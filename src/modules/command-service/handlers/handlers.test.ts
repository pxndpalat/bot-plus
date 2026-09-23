import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { parseCommand } from "../index.ts";
import { createCommandHandler, createInMemoryCommandIdempotencyStore } from "../index.ts";
import { createInMemoryPersonaStore, createPersonaService, type PersonaMember } from "../../persona-service/index.ts";
import { createInMemorySettingsRepository, createSettingsService } from "../../settings/index.ts";
import { createInMemoryAuditEventPort } from "../../telemetry/index.ts";

const GROUP = "group-1";
const USER = "U-member";
const ADMIN = "U-admin";
const at = new Date("2026-01-02T03:04:05.000Z");

function member(lineUserId: string, id = lineUserId): PersonaMember {
  return { id, groupId: GROUP, lineUserId, displayName: null, memoryOptedOut: false, leftAt: null };
}

function fixture() {
  const personaStore = createInMemoryPersonaStore([{ member: member(USER, "member-1") }, { member: member(ADMIN, "admin-1") }]);
  const persona = createPersonaService(personaStore, { now: () => at });
  const settingsRepository = createInMemorySettingsRepository([{ groupId: GROUP }]);
  const settings = createSettingsService(settingsRepository, { adminLineUserIds: [ADMIN] });
  const audit = createInMemoryAuditEventPort();
  const idempotency = createInMemoryCommandIdempotencyStore();
  const lifecycleCalls: unknown[] = [];
  const handler = createCommandHandler({
    persona,
    settings,
    audit,
    idempotency,
    lifecycle: { forgetMember: async (input) => { lifecycleCalls.push(input); } },
  });
  return { personaStore, settingsRepository, audit, idempotency, lifecycleCalls, handler };
}

function command(text: string, actorUserId = USER) {
  const result = parseCommand({ text, actorUserId, botMentioned: true });
  if (result.kind !== "command") throw new Error(`not a command: ${result.reason}`);
  return result;
}

test("command handlers view only the actor's safe facts and return defensive copies", async () => {
    const fixtureValue = fixture();
    await fixtureValue.handler.handle(command("แก้ข้อมูลฉัน: food: ซูชิ"), { groupId: GROUP, eventId: "evt-1", now: at });
    const result = await fixtureValue.handler.handle(command("ฉันเป็นใคร"), { groupId: GROUP, eventId: "evt-2", now: at });
    assert.equal(result.facts?.length, 1);
    if (!result.facts) throw new Error("facts missing");
    (result.facts[0] as { claim: string }).claim = "mutated";
    const again = await fixtureValue.handler.handle(command("ฉันเป็นใคร"), { groupId: GROUP, eventId: "evt-3", now: at });
    assert.equal(again.facts?.[0]?.claim, "ซูชิ");
});

test("command correction is self-correction strength and mutation is audited", async () => {
    const fixtureValue = fixture();
    const result = await fixtureValue.handler.handle(command("แก้ข้อมูลฉัน: food: ชา"), { groupId: GROUP, eventId: "evt-correct", now: at });
    assert.equal(result.observation?.sourceStrength, "self_correction");
    assert.equal(result.observation?.confidence, 1);
    assert(fixtureValue.audit.events.map((item) => item.action).includes("persona.corrected"));
});

test("command forget delegates to lifecycle and replay is idempotent", async () => {
    const fixtureValue = fixture();
    const first = await fixtureValue.handler.handle(command("ลืมฉัน"), { groupId: GROUP, eventId: "evt-forget", now: at });
    const second = await fixtureValue.handler.handle(command("ลืมฉัน"), { groupId: GROUP, eventId: "evt-forget", now: at });
    assert.equal(first.text, second.text);
    assert.equal(fixtureValue.lifecycleCalls.length, 1);
});

test("command non-admin cannot mutate group settings", async () => {
    const fixtureValue = fixture();
    await assert.rejects(fixtureValue.handler.handle(command("เงียบ 2 นาที"), { groupId: GROUP, eventId: "evt-mute", now: at }), (error: unknown) => (error as { kind?: string }).kind === "unauthorized");
});

test("command admin status does not reveal the admin allowlist", async () => {
    const fixtureValue = fixture();
    const result = await fixtureValue.handler.handle(command("สถานะ", ADMIN), { groupId: GROUP, eventId: "evt-status", now: at });
    assert.equal(result.status?.groupId, GROUP);
    assert(!result.text.includes(ADMIN));
    assert(!JSON.stringify(result).includes("adminLineUserIds"));
});
