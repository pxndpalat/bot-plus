import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { parseCommand } from "../index.ts";

const actor = "U-command-member";
const mentioned = [{ isSelf: true }] as const;

test("parses the complete MVP command table and preserves payload", () => {
  const cases = [
    ["ฉันเป็นใคร", "who_am_i"],
    ["ลืมฉัน", "forget_me"],
    ["หยุดวิเคราะห์ฉัน", "memory_opt_out"],
    ["จำฉันได้แล้ว", "memory_opt_in"],
    ["แก้ข้อมูลฉัน: ไม่ชอบซูชิ : แล้ว", "correct_persona"],
    ["เรียกฉันว่า เอก-ซ่า!", "set_alias"],
    ["เงียบ 1 ชม.", "mute"],
    ["โหมด แซวแรง", "set_mode"],
    ["สถานะ", "status"],
  ] as const;
  for (const [text, command] of cases) {
    const requiresMention = !["ฉันเป็นใคร", "สถานะ"].includes(text);
    const result = parseCommand({ text, actorUserId: actor, botMentioned: requiresMention });
    assert.equal(result.kind, "command", text);
    if (result.kind === "command") assert.equal(result.command, command, text);
  }

  const correction = parseCommand({
    text: "แก้ข้อมูลฉัน:  ไม่ชอบซูชิ : แล้ว  ",
    actorUserId: actor,
    mentions: [{ isSelf: true }],
  });
  assert.equal(correction.kind, "command");
  if (correction.kind === "command" && correction.command === "correct_persona") assert.equal(correction.payload, "ไม่ชอบซูชิ : แล้ว");
  const alias = parseCommand({ text: "เรียกฉันว่า เอก-ซ่า!", actorUserId: actor, mentions: [{ isSelf: true }] });
  assert.equal(alias.kind, "command");
  if (alias.kind === "command" && alias.command === "set_alias") assert.equal(alias.alias, "เอก-ซ่า!");
});

test("structured self mention is required for state-changing commands", () => {
  const missing = parseCommand({ text: "ลืมฉัน", actorUserId: actor });
  assert.equal(missing.kind, "not_command");
  if (missing.kind === "not_command") {
    assert.equal(missing.reason, "missing_mention");
    assert.equal(missing.actorUserId, actor);
  }
  const spoofedDisplayName = parseCommand({ text: "ลืมฉัน", actorUserId: actor, displayName: "@bot" });
  assert.equal(spoofedDisplayName.kind, "not_command");
  const accepted = parseCommand({ text: "ลืมฉัน", actorUserId: actor, mentions: mentioned });
  assert.equal(accepted.kind, "command");
});

test("normalizes limited spacing and Thai punctuation without changing payload", () => {
  const result = parseCommand({ text: "  แก้ข้อมูลฉัน：   ชอบชา  ไทย : มาก  ", actorUserId: actor, botMentioned: true });
  assert.equal(result.kind, "command");
  if (result.kind === "command" && result.command === "correct_persona") assert.equal(result.correction, "ชอบชา  ไทย : มาก");
  assert.equal(parseCommand({ text: "เงียบ 2 นาที", actorUserId: actor, botMentioned: true }).kind, "command");
  const hours = parseCommand({ text: "เงียบ 2 ชั่วโมง", actorUserId: actor, botMentioned: true });
  assert.equal(hours.kind, "command");
  if (hours.kind === "command" && hours.command === "mute") assert.equal(hours.durationMinutes, 120);
  const textualMarker = parseCommand({ text: "@bot เรียกฉันว่า  สอง  คำ", actorUserId: actor, botMentioned: true });
  assert.equal(textualMarker.kind, "command");
  if (textualMarker.kind === "command" && textualMarker.command === "set_alias") assert.equal(textualMarker.alias, "สอง  คำ");
});

test("malformed, incomplete, wrong mode, and mixed-noise messages are not commands", () => {
  const invalid = [
    "แก้ข้อมูลฉัน:",
    "เรียกฉันว่า",
    "เงียบ 0 ชม.",
    "เงียบ 1 วัน",
    "โหมด 隨便",
    "โหมด ปกติ เพิ่มเติม",
    "hello ฉันเป็นใคร",
    "ฉันเป็นใคร please",
  ];
  for (const text of invalid) {
    const result = parseCommand({ text, actorUserId: actor, botMentioned: true });
    assert.equal(result.kind, "not_command", text);
  }
});

test("arbitrary fuzz input never throws", () => {
  const values: unknown[] = [null, undefined, 1, {}, "", "\u0000\u0001\uD800", "@bot".repeat(1000), "\u200B  แก้ข้อมูลฉัน：\uFEFF "];
  for (const value of values) {
    assert.doesNotThrow(() => parseCommand({ text: value as never, actorUserId: actor }));
  }
});
