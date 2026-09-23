import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createInMemoryResponseClaimStore, createDirectPipeline, type DirectTelemetryPort } from "./index.ts";
import type { CommandResult, ParsedCommand } from "../command-service/index.ts";
import type { DecisionResult } from "../decision-engine/index.ts";
import type { LineReplyPort } from "../line-adapter/index.ts";
import { fixedClock } from "../../shared/index.ts";

const at = new Date("2026-01-01T00:00:00.000Z");
const decision = (id = "decision-1"): DecisionResult => ({ id, groupId: "group-1", sourceMessageId: "message-1", episodeId: null, responseId: null, decisionType: "direct", respond: true, reason: "answer", interestScore: 1, answeredByHuman: false, safety: "allowed", draft: "hello", usedFactIds: [], suppressionReason: null, createdAt: at, direct: true });
const command = { kind: "command", command: "who_am_i", intent: "who_am_i", actorUserId: "U-member", actor: { userId: "U-member" }, scope: "member", authorization: "member", requiresMention: false, mentionPresent: true, rawText: "command", normalizedText: "command" } as unknown as ParsedCommand;
const commandResult: CommandResult = { ok: true, command: "who_am_i", kind: "query", text: "profile", message: "profile" };

function base(options: Partial<Parameters<typeof createDirectPipeline>[0]> = {}) {
  const responses = createInMemoryResponseClaimStore(() => "response-1");
  const calls: string[] = [];
  const reply: LineReplyPort = { reply: async ({ replyToken, messages }) => { calls.push(`${replyToken}:${String((messages[0] as { text?: string }).text)}`); } };
  const engine = { decide: async () => decision() };
  const pipeline = createDirectPipeline({ reply, responseClaims: responses, decisionEngine: engine, clock: fixedClock(at), ...options });
  return { pipeline, responses, calls };
}

test("concurrent duplicate direct jobs claim and send at most once", async () => {
  const { pipeline, calls } = base();
  const input = { groupId: "group-1", sourceMessageId: "message-1", text: "@bot hi", replyToken: "token", replyTokenReceivedAt: at, now: at };
  const results = await Promise.all([pipeline.process(input), pipeline.process(input)]);
  assert.equal(calls.length, 1);
  assert.equal(results.filter((result) => result.outcome === "sent").length, 1);
  assert.equal(results.filter((result) => result.outcome === "duplicate").length, 1);
});

test("transport timeout after claim becomes unknown and is never retried", async () => {
  const responses = createInMemoryResponseClaimStore(() => "response-timeout");
  let calls = 0;
  const pipeline = createDirectPipeline({
    reply: { reply: async () => { calls += 1; throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); } },
    responseClaims: responses, decisionEngine: { decide: async () => decision("decision-timeout") }, clock: fixedClock(at),
  });
  const input = { groupId: "group-1", sourceMessageId: "message-timeout", text: "hi", replyToken: "token", replyTokenReceivedAt: at, now: at };
  assert.equal((await pipeline.process(input)).outcome, "unknown");
  assert.equal((await pipeline.process(input)).outcome, "duplicate");
  assert.equal(calls, 1);
  assert.equal(responses.responses[0]?.state, "unknown");
});

test("stale reply token is expired without claiming or sending", async () => {
  const { pipeline, responses, calls } = base();
  const result = await pipeline.process({ groupId: "group-1", sourceMessageId: "old", text: "hi", replyToken: "token", replyTokenReceivedAt: new Date(at.getTime() - 45_000), now: at });
  assert.equal(result.outcome, "expired");
  assert.equal(calls.length, 0);
  assert.equal(responses.responses[0]?.state, "suppressed");
  assert.equal(responses.responses[0]?.suppressionReason, "stale_reply_token");
});

test("commands bypass decision generation and route through command handler", async () => {
  let decisions = 0;
  let handled = 0;
  const { responses, calls } = base({
    decisionEngine: { decide: async () => { decisions += 1; return decision(); } },
    commandHandler: { handle: async () => { handled += 1; return commandResult; } },
  });
  const pipeline = createDirectPipeline({ reply: { reply: async ({ messages }) => { calls.push(String((messages[0] as { text?: string }).text)); } }, responseClaims: responses, decisionEngine: { decide: async () => { decisions += 1; return decision(); } }, commandHandler: { handle: async () => { handled += 1; return commandResult; } }, clock: fixedClock(at) });
  const result = await pipeline.process({ groupId: "group-1", sourceMessageId: "command-message", command, replyToken: "token", replyTokenReceivedAt: at, now: at });
  assert.equal(result.outcome, "sent");
  assert.equal(handled, 1);
  assert.equal(decisions, 0);
  assert.deepEqual(calls, ["profile"]);
});

test("latency telemetry is emitted without exposing reply token", async () => {
  const events: unknown[] = [];
  const telemetry: DirectTelemetryPort = { emit: (event) => events.push(event) };
  const { pipeline } = base({ telemetry });
  await pipeline.process({ groupId: "group-1", sourceMessageId: "telemetry", text: "hi", replyToken: "secret-token", replyTokenReceivedAt: at, now: at });
  assert.equal(events.some((event) => (event as { event?: string }).event === "latency"), true);
  assert.equal(JSON.stringify(events).includes("secret-token"), false);
});

