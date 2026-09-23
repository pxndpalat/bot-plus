import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createAmbientPipeline, createInMemoryAmbientResponseClaims, createInMemoryAmbientSchedulePort, createInMemoryAmbientSuppressionPort, type AmbientClock } from "./index.ts";
import type { ConversationContext } from "../conversation-service/index.ts";
import type { DecisionResult } from "../decision-engine/index.ts";

const groupId = "group-ambient";
const sourceMessageId = "message-1";
const receivedAt = new Date("2026-01-01T00:00:00.000Z");

function clock(value: Date): AmbientClock & { set(next: Date): void } {
  let current = new Date(value.getTime());
  return { now: () => new Date(current.getTime()), set: (next) => { current = new Date(next.getTime()); } };
}

function context(): ConversationContext {
  return { groupId, anchorAt: receivedAt, windowStartedAt: new Date(receivedAt.getTime() - 600_000), messages: [] };
}

function decision(overrides: Partial<DecisionResult> = {}): DecisionResult {
  return {
    id: "decision-1", groupId, sourceMessageId, episodeId: null, responseId: null, decisionType: "ambient",
    respond: true, reason: "can_add_fun", interestScore: 0.8, answeredByHuman: false, safety: "allowed", draft: "น่าสนใจนะ", usedFactIds: [], suppressionReason: null, createdAt: receivedAt,
    direct: false, ...overrides,
  };
}

function base() {
  const now = clock(new Date(receivedAt.getTime() + 20_000));
  const schedule = createInMemoryAmbientSchedulePort();
  const suppression = createInMemoryAmbientSuppressionPort();
  const claims = createInMemoryAmbientResponseClaims();
  const sent: unknown[] = [];
  const pipeline = createAmbientPipeline({
    clock: now,
    random: { next: () => 0 },
    schedule,
    suppression,
    responseClaims: claims,
    reply: { reply: async (request) => { sent.push(request); } },
    conversation: {
      buildContext: async () => context(),
      renderContext: () => ({ trustedMetadata: { groupId, messageIds: [sourceMessageId], windowStartedAt: receivedAt.toISOString(), anchorAt: receivedAt.toISOString() }, untrustedUserText: [] }),
      evaluateCandidate: async () => ({ answeredByHuman: false, answeringMessageIds: [], staleContext: false, staleMessageIds: [], relevantMessageIds: [sourceMessageId] }),
    },
    decision: { decide: async () => decision() },
  });
  return { now, schedule, suppression, claims, sent, pipeline };
}

function input() {
  return { groupId, sourceMessageId, eventId: "event-1", messageType: "text", text: "เรื่องนี้น่าสนใจมาก", replyToken: "token", replyTokenReceivedAt: receivedAt, receivedAt };
}

test("ambient candidate schedules an injectable delay in the 15-30 second range", async () => {
  const fixture = base();
  const result = await fixture.pipeline.createCandidate(input());
  assert.equal(result.scheduled, true);
  assert.equal(result.candidate?.dueAt.getTime(), receivedAt.getTime() + 15_000);
  assert.equal(fixture.schedule.candidates.length, 1);
});

test("candidate is silent before due and then sends once after due", async () => {
  const fixture = base();
  const candidate = (await fixture.pipeline.createCandidate(input())).candidate!;
  fixture.now.set(new Date(candidate.dueAt.getTime() - 1));
  assert.equal((await fixture.pipeline.process(candidate)).reason, "not_due");
  fixture.now.set(candidate.dueAt);
  assert.equal((await fixture.pipeline.process(candidate)).outcome, "sent");
  assert.equal(fixture.sent.length, 1);
  assert.equal((await fixture.pipeline.process(candidate)).reason, "duplicate_response");
  assert.equal(fixture.sent.length, 1);
});

test("human response and stale context cancel without invoking a reply", async () => {
  const fixture = base();
  const candidate = (await fixture.pipeline.createCandidate(input())).candidate!;
  const humanPipeline = createAmbientPipeline({
    clock: fixture.now, responseClaims: fixture.claims, reply: { reply: async () => { throw new Error("must not send"); } },
    conversation: {
      buildContext: async () => context(), renderContext: () => ({ trustedMetadata: { groupId, messageIds: [], windowStartedAt: receivedAt.toISOString(), anchorAt: receivedAt.toISOString() }, untrustedUserText: [] }),
      evaluateCandidate: async () => ({ answeredByHuman: true, answeringMessageIds: ["answer"], staleContext: false, staleMessageIds: [], relevantMessageIds: [sourceMessageId] }),
    },
    decision: { decide: async () => { throw new Error("must not decide"); } },
  });
  assert.equal((await humanPipeline.process(candidate)).reason, "human_answered");
});

test("stale reply tokens cancel and all ambient safety failures stay silent", async () => {
  const fixture = base();
  const candidate = (await fixture.pipeline.createCandidate(input())).candidate!;
  fixture.now.set(new Date(receivedAt.getTime() + 45_001));
  assert.equal((await fixture.pipeline.process(candidate)).reason, "stale_reply_token");
  assert.equal(fixture.sent.length, 0);
  assert(fixture.suppression.suppressions.some((item) => item.reason === "stale_reply_token"));
});

test("model failure is suppressed rather than retried or neutral-fallbacked", async () => {
  const fixture = base();
  const candidate = (await fixture.pipeline.createCandidate(input())).candidate!;
  const failed = createAmbientPipeline({
    clock: fixture.now, responseClaims: fixture.claims, reply: fixture.pipeline as never,
    conversation: { buildContext: async () => context(), renderContext: () => ({ trustedMetadata: { groupId, messageIds: [], windowStartedAt: receivedAt.toISOString(), anchorAt: receivedAt.toISOString() }, untrustedUserText: [] }), evaluateCandidate: async () => ({ answeredByHuman: false, answeringMessageIds: [], staleContext: false, staleMessageIds: [], relevantMessageIds: [sourceMessageId] }) },
    decision: { decide: async () => { throw new Error("model timeout"); } },
  });
  assert.equal((await failed.process(candidate)).reason, "model_failure");
});
