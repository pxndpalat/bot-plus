import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { ConflictError } from "../../shared/index.ts";
import { createInMemoryPersonaStore } from "./in-memory.ts";
import { createPersonaService } from "./service.ts";

const at = new Date("2026-01-01T00:00:00.000Z");
function setup() {
  const store = createInMemoryPersonaStore([{ member: { id: "m1", groupId: "g1", lineUserId: "u1", displayName: "A", memoryOptedOut: false }, aliases: ["A"] }, { member: { id: "m2", groupId: "g1", lineUserId: "u2", displayName: "B", memoryOptedOut: false } }]);
  return { store, service: createPersonaService(store, { now: () => at }) };
}

test("persona resolves only unique aliases and rejects collisions", async () => {
    const { service } = setup();
    assert.equal((await service.resolveAlias("g1", " a ")).memberId, "m1");
    await assert.rejects(service.addAlias({ groupId: "g1", memberId: "m2", alias: "A" }), (error: unknown) => error instanceof ConflictError);
  });

test("persona stores traceable observations, ranks explicit evidence, and is idempotent by source", async () => {
    const { service, store } = setup();
    const first = await service.extractAndResolve({ groupId: "g1", sourceMessageId: "msg-1", now: at, extractorOutput: { observations: [{ subjectMemberId: "m1", category: "food", claim: "sushi", sourceStrength: "third_party", confidence: 1, visibility: "public_safe" }] } });
    const second = await service.extractAndResolve({ groupId: "g1", sourceMessageId: "msg-1", now: at, extractorOutput: { observations: [{ subjectMemberId: "m1", category: "food", claim: "sushi", sourceStrength: "self_explicit", confidence: 1, visibility: "public_safe" }] } });
    assert.equal(store.observations.length, 1);
    assert.equal(first[0]?.claim, "sushi");
    assert.equal(second[0]?.observationIds.length, 1);
  });

test("persona correction wins without deleting conflicting evidence", async () => {
    const { service, store } = setup();
    await service.extractAndResolve({ groupId: "g1", sourceMessageId: "msg-1", extractorOutput: { observations: [{ subjectMemberId: "m1", category: "food", claim: "sushi", sourceStrength: "self_explicit", confidence: 0.8, visibility: "public_safe" }] } });
    const facts = await service.extractAndResolve({ groupId: "g1", sourceMessageId: "msg-2", extractorOutput: { observations: [{ subjectMemberId: "m1", category: "food", claim: "pizza", sourceStrength: "self_correction", confidence: 1, visibility: "public_safe" }] } });
    assert.equal(facts[0]?.claim, "pizza");
    assert.equal(store.observations.length, 2);
  });

test("persona opt-out prevents new memory and retrieval hides risky facts by default", async () => {
    const { service, store } = setup();
    await service.setMemoryOptOut("g1", "m1");
    await service.extractAndResolve({ groupId: "g1", sourceMessageId: "msg-1", extractorOutput: { observations: [{ subjectMemberId: "m1", category: "work", claim: "secret", sourceStrength: "self_explicit", confidence: 1, visibility: "risky" }] } });
    assert.equal(store.observations.length, 0);
    await service.setMemoryOptIn("g1", "m1");
    await service.extractAndResolve({ groupId: "g1", sourceMessageId: "msg-2", extractorOutput: { observations: [{ subjectMemberId: "m1", category: "work", claim: "secret", sourceStrength: "self_explicit", confidence: 1, visibility: "risky" }] } });
    assert.equal((await service.getFacts({ groupId: "g1", subjectMemberId: "m1" })).length, 0);
    assert.equal((await service.getFacts({ groupId: "g1", subjectMemberId: "m1", includeRisky: true })).length, 1);
  });

test("persona extraction honors the Safety Gate public port when configured", async () => {
  const store = createInMemoryPersonaStore([{ member: { id: "m1", groupId: "g1", lineUserId: "u1", displayName: null, memoryOptedOut: false } }]);
  const service = createPersonaService(store, { safetyGate: { evaluate: async () => ({ status: "blocked" } as never) } });
  await service.extractAndResolve({ groupId: "g1", sourceMessageId: "msg-safe", extractorOutput: { observations: [{ subjectMemberId: "m1", category: "food", claim: "secret", sourceStrength: "self_explicit", confidence: 1, visibility: "risky" }] } });
  assert.equal(store.observations.length, 0);
});

