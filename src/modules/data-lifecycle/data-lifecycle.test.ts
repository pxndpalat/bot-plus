import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createDataLifecycleService } from "./service.ts";
import { createInMemoryLifecycleRepository } from "./in-memory.ts";

const NOW = new Date("2026-01-31T00:00:00.000Z");

test("unsend is atomic/idempotent and removes source content, jobs, observations, and dependent facts", async () => {
  const repository = createInMemoryLifecycleRepository({
    messages: [{ id: "msg-1", groupId: "g1", lineMessageId: "line-1", senderMemberId: "m1", sentAt: new Date("2026-01-30T00:00:00Z"), textContent: "secret" }],
    jobs: [{ id: "job-1", groupId: "g1", sourceMessageId: "msg-1" }],
    observations: [{ id: "obs-1", groupId: "g1", subjectMemberId: "m1", sourceMessageId: "msg-1" }],
    facts: [{ id: "fact-1", groupId: "g1", subjectMemberId: "m1", observationIds: ["obs-1"], lastSeenAt: NOW }],
  });
  const service = createDataLifecycleService(repository, { now: () => NOW });
  const first = await service.unsend({ groupId: "g1", lineMessageId: "line-1" });
  const second = await service.unsend({ groupId: "g1", lineMessageId: "line-1" });
  assert.equal(first.messagesDeleted, 1); assert.equal(first.jobsCancelled, 1); assert.equal(first.observationsInvalidated, 1); assert.equal(first.factsArchived, 1); assert.equal(second.alreadyApplied, true);
  assert.equal(repository.messages.length, 0); assert.equal(repository.facts[0]?.active, false); assert.equal(repository.tombstones.length, 1);
});

test("forget only removes the actor's messages/persona and does not opt out or erase another subject", async () => {
  const repository = createInMemoryLifecycleRepository({
    messages: [
      { id: "msg-1", groupId: "g1", lineMessageId: "line-1", senderMemberId: "m1", sentAt: NOW },
      { id: "msg-2", groupId: "g1", lineMessageId: "line-2", senderMemberId: "m2", sentAt: NOW },
    ],
    observations: [
      { id: "obs-1", groupId: "g1", subjectMemberId: "m1", sourceMessageId: "msg-1" },
      { id: "obs-2", groupId: "g1", subjectMemberId: "m2", sourceMessageId: "msg-1" },
    ],
    facts: [
      { id: "fact-1", groupId: "g1", subjectMemberId: "m1", observationIds: ["obs-1"], lastSeenAt: NOW },
      { id: "fact-2", groupId: "g1", subjectMemberId: "m2", observationIds: ["obs-2"], lastSeenAt: NOW },
    ],
  });
  const service = createDataLifecycleService(repository, { now: () => NOW });
  const result = await service.forgetMe({ groupId: "g1", memberId: "m1" });
  const repeat = await service.forgetMe({ groupId: "g1", memberId: "m1" });
  assert.equal(result.messagesDeleted, 1); assert.equal(repository.messages.length, 1); assert.equal(repository.facts.find((fact) => fact.id === "fact-1")?.active, false); assert.equal(repository.facts.find((fact) => fact.id === "fact-2")?.active, true); assert.equal(repository.observations.find((item) => item.id === "obs-2")?.status, "active");
  assert.equal(repeat.alreadyApplied, true);
});

test("sweep respects strict retention and decay boundaries, and is safe to rerun", async () => {
  const repository = createInMemoryLifecycleRepository({
    messages: [{ id: "old", groupId: "g1", lineMessageId: "old-line", sentAt: new Date("2025-12-01T00:00:00Z") }, { id: "new", groupId: "g1", lineMessageId: "new-line", sentAt: new Date("2026-01-01T00:00:00Z") }],
    contentLogs: [{ id: "log-old", groupId: "g1", createdAt: new Date("2025-01-01T00:00:00Z"), expiresAt: new Date("2026-01-30T00:00:00Z") }],
    facts: [{ id: "fact-old", groupId: "g1", subjectMemberId: "m1", observationIds: [], lastSeenAt: new Date("2025-07-31T00:00:00Z") }],
  });
  const service = createDataLifecycleService(repository, { now: () => NOW });
  const policy = { rawMessageRetentionDays: 30, contentLogRetentionDays: 7, personaDecayDays: 180 };
  const result = await service.sweep({ groupId: "g1", now: NOW, policy });
  assert.equal(result.messagesDeleted, 1); assert.equal(result.contentLogsDeleted, 1); assert.equal(result.factsArchived, 1); assert.equal(repository.messages[0]?.id, "new"); assert.equal(repository.tombstones[0]?.reason, "retention");
});

