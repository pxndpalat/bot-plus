import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createInMemorySettingsRepository, createSettingsService, isGroupMuted } from "./index.ts";

const GROUP_ID = "group-settings-test";
const ADMIN = "U-admin-exact";
const OTHER_USER = "U-member";

function serviceWithBudget(dailyTokenBudget = 100): ReturnType<typeof createSettingsService> {
  const repository = createInMemorySettingsRepository([{ groupId: GROUP_ID, dailyTokenBudget }]);
  return createSettingsService(repository, { adminLineUserIds: [ADMIN] });
}

test("admin authorization uses exact LINE userId and Thai mode/mute settings", async () => {
  const repository = createInMemorySettingsRepository([{ groupId: GROUP_ID }]);
  const service = createSettingsService(repository, { adminLineUserIds: [ADMIN] });
  const muteUntil = new Date("2026-01-01T01:00:00.000Z");

  assert.equal(service.isAdmin(ADMIN), true);
  assert.equal(service.isAdmin(" U-admin-exact"), false);
  assert.equal(service.isAdmin(OTHER_USER), false);
  await assert.rejects(
    service.updateGroupSettings(OTHER_USER, GROUP_ID, { mode: "แซวแรง" }),
    (error: unknown) => error instanceof Error && error.message === "Admin authorization required",
  );
  assert.equal(repository.audits.length, 0);

  const updated = await service.updateGroupSettings(
    ADMIN,
    GROUP_ID,
    {
      mode: "แซวแรง",
      muteUntil,
    },
    new Date("2026-01-01T00:00:00.000Z"),
  );
  assert.equal(updated.mode, "teasing");
  assert.equal(updated.muteUntil?.toISOString(), muteUntil.toISOString());
  assert.equal(isGroupMuted(updated, new Date("2026-01-01T00:59:59.000Z")), true);
  assert.equal(isGroupMuted(updated, muteUntil), false);
  assert.equal(repository.audits.length, 1);
});

test("Bangkok budget boundary resets at midnight and blocks ambient only when full", async () => {
  const service = serviceWithBudget(100);
  const beforeMidnight = new Date("2026-01-01T16:59:59.000Z");
  const afterMidnight = new Date("2026-01-01T17:00:00.000Z");

  const first = await service.consumeAiBudget({
    groupId: GROUP_ID,
    path: "ambient",
    model: "test-model",
    operation: "judge",
    inputTokens: 60,
    outputTokens: 0,
    occurredAt: beforeMidnight,
  });
  assert.equal(first.allowed, true);
  assert.equal(first.budgetDay, "2026-01-01");

  const second = await service.consumeAiBudget({
    groupId: GROUP_ID,
    path: "ambient",
    model: "test-model",
    operation: "judge",
    inputTokens: 100,
    outputTokens: 0,
    occurredAt: afterMidnight,
  });
  assert.equal(second.allowed, true);
  assert.equal(second.budgetDay, "2026-01-02");

  const blocked = await service.consumeAiBudget({
    groupId: GROUP_ID,
    path: "ambient",
    model: "test-model",
    operation: "judge",
    inputTokens: 1,
    outputTokens: 0,
    occurredAt: afterMidnight,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.recorded, false);
  assert.equal(blocked.reason, "daily_budget_exhausted");

  const direct = await service.consumeAiBudget({
    groupId: GROUP_ID,
    path: "direct",
    model: "test-model",
    operation: "answer",
    inputTokens: 1,
    outputTokens: 0,
    occurredAt: afterMidnight,
  });
  assert.equal(direct.allowed, true);
  const command = await service.consumeAiBudget({
    groupId: GROUP_ID,
    path: "command",
    model: "test-model",
    operation: "command",
    inputTokens: 1,
    outputTokens: 0,
    occurredAt: afterMidnight,
  });
  assert.equal(command.allowed, true);
});

test("concurrent ambient reservations cannot overspend the daily budget", async () => {
  const service = serviceWithBudget(100);
  const at = new Date("2026-02-01T05:00:00.000Z");
  const results = await Promise.all([
    service.consumeAiBudget({
      groupId: GROUP_ID,
      path: "ambient",
      model: "test-model",
      operation: "judge",
      inputTokens: 60,
      outputTokens: 0,
      occurredAt: at,
    }),
    service.consumeAiBudget({
      groupId: GROUP_ID,
      path: "ambient",
      model: "test-model",
      operation: "judge",
      inputTokens: 60,
      outputTokens: 0,
      occurredAt: at,
    }),
  ]);
  assert.equal(results.filter((result) => result.allowed).length, 1);
  assert.equal(results.filter((result) => result.reason === "daily_budget_exhausted").length, 1);
});

test("settings mutation and audit are atomic", async () => {
  const repository = createInMemorySettingsRepository([{ groupId: GROUP_ID }]);
  const service = createSettingsService(repository, { adminLineUserIds: [ADMIN] });
  repository.failNextMutationAudit = true;

  await assert.rejects(service.updateGroupSettings(ADMIN, GROUP_ID, { dailyTokenBudget: 10 }));
  assert.equal((await service.getGroupSettings(GROUP_ID))?.dailyTokenBudget, 100_000);
  assert.equal(repository.audits.length, 0);

  await service.updateGroupSettings(ADMIN, GROUP_ID, { active: false });
  const status = await service.getStatusSnapshot(GROUP_ID, new Date("2026-01-01T00:00:00.000Z"));
  assert.equal(status?.active, false);
  assert.equal(status?.databaseReady, true);
  assert.equal("adminLineUserIds" in (status ?? {}), false);
  assert.equal("databaseUrl" in (status ?? {}), false);
  assert.equal(repository.audits.length, 1);
});

test("inactive groups reject budget usage and expose retention settings only", async () => {
  const repository = createInMemorySettingsRepository([
    {
      groupId: GROUP_ID,
      active: false,
      rawMessageRetentionDays: 30,
      contentLogRetentionDays: 7,
      personaDecayDays: 180,
    },
  ]);
  const service = createSettingsService(repository, { adminLineUserIds: [ADMIN] });
  const result = await service.consumeAiBudget({
    groupId: GROUP_ID,
    path: "direct",
    model: "test-model",
    operation: "answer",
    inputTokens: 1,
    outputTokens: 0,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "inactive_group");
  assert.deepEqual(await service.getRetentionPolicy(GROUP_ID), {
    rawMessageRetentionDays: 30,
    contentLogRetentionDays: 7,
    personaDecayDays: 180,
  });
});
