import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createFakeAiResponsesTransport, createAiClient } from "../ai-client/index.ts";
import { createInMemorySettingsRepository } from "../settings/index.ts";
import type { SafetyGateResult } from "../safety-gate/index.ts";
import { createDecisionEngine, createInMemoryDecisionRepository } from "./index.ts";

const at = new Date("2026-01-01T00:00:00.000Z");
const allowedGate = async ({ draft, path }: { draft: string; path?: "direct" | "ambient" }): Promise<SafetyGateResult> => ({ status: "allowed", safety: "allowed", decision: "allowed", reason: "allowed", reasonCode: "allowed", machineReason: "allowed", category: "none", path: path ?? "ambient", response: draft, reply: draft });
const response = (value: unknown) => ({ output: JSON.stringify(value), usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });

function setup(value: unknown) {
  const transport = createFakeAiResponsesTransport([response(value)]);
  const settings = createInMemorySettingsRepository([{ groupId: "group-1", dailyTokenBudget: 100 }]);
  const repository = createInMemoryDecisionRepository();
  const engine = createDecisionEngine({ aiClient: createAiClient({ transport }), safetyGate: allowedGate, settings, repository, now: () => at });
  return { engine, settings, repository, transport };
}

test("direct invocation detects self mention and returns a model draft", async () => {
  const { engine } = setup({ respond: true, reason: "can_add_fun", interest_score: 0.8, answered_by_human: false, safety: "allowed", draft: "hello", used_fact_ids: [] });
  const result = await engine.decide({ groupId: "group-1", decisionType: "direct", message: { type: "text", text: "@bot hi", mentions: [{ isSelf: true }] }, now: at });
  assert.equal(result.direct, true);
  assert.equal(result.respond, true);
  assert.equal(result.draft, "hello");
});

test("ambient hard filters run before the model", async () => {
  const { engine, transport } = setup({ respond: true, reason: "x", interest_score: 1, answered_by_human: false, safety: "allowed", draft: "x", used_fact_ids: [] });
  const result = await engine.decide({ groupId: "group-1", path: "ambient", message: { type: "text", text: "555" }, now: at });
  assert.equal(result.suppressionReason, "low_signal");
  assert.equal(transport.calls.length, 0);
});

test("unknown fact ids are rejected and direct uses neutral fallback", async () => {
  const { engine } = setup({ respond: true, reason: "x", interest_score: 1, answered_by_human: false, safety: "allowed", draft: "x", used_fact_ids: ["not-supplied"] });
  const result = await engine.decide({ groupId: "group-1", path: "direct", text: "@bot", now: at });
  assert.equal(result.respond, true);
  assert.equal(result.reason, "neutral_fallback");
  assert.equal(result.usedFactIds.length, 0);
});

test("only facts selected by the model are supplied to the final safety check", async () => {
  const transport = createFakeAiResponsesTransport([response({ respond: true, reason: "x", interest_score: 1, answered_by_human: false, safety: "allowed", draft: "safe", used_fact_ids: ["safe-fact"] })]);
  const settings = createInMemorySettingsRepository([{ groupId: "group-1" }]);
  const seen: string[] = [];
  const engine = createDecisionEngine({
    aiClient: createAiClient({ transport }), settings,
    safetyGate: async ({ facts, draft, path }) => { seen.push(...(facts ?? []).map((fact) => fact.id ?? "")); return allowedGate({ draft, path }); },
  });
  const result = await engine.decide({ groupId: "group-1", path: "ambient", text: "topic", facts: [{ id: "safe-fact", visibility: "public_safe" }, { id: "risky-fact", visibility: "risky" }], now: at });
  assert.equal(result.respond, true);
  assert.deepEqual(seen, ["safe-fact"]);
});

