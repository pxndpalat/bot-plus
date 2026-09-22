import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createDatabase, rebuildDatabase } from "../../index.ts";
import { createJobStore } from "./index.ts";

test("PostgreSQL job store claims due jobs once, reclaims stale locks, and skips future/expired jobs", async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) return;

  const { db } = createDatabase(connectionString);
  try {
    await rebuildDatabase(db);
    const now = new Date("2026-01-01T00:00:00.000Z");
    await db.insertInto("groups").values({ id: "job-runner-group", line_group_id: "job-runner-group", joined_at: now, created_at: now, updated_at: now }).execute();
    await db.insertInto("delayed_jobs").values([
      { id: "due-job", group_id: "job-runner-group", job_type: "test", status: "pending", idempotency_key: "due-key", due_at: now, attempts: 0, locked_at: null, locked_by: null, source_message_id: null, episode_id: null, payload: {}, created_at: now, updated_at: now },
      { id: "stale-job", group_id: "job-runner-group", job_type: "test", status: "claimed", idempotency_key: "stale-key", due_at: now, attempts: 1, locked_at: new Date(now.getTime() - 120_000), locked_by: "crashed-worker", source_message_id: null, episode_id: null, payload: {}, created_at: now, updated_at: now },
      { id: "future-job", group_id: "job-runner-group", job_type: "test", status: "pending", idempotency_key: "future-key", due_at: new Date(now.getTime() + 60_000), attempts: 0, locked_at: null, locked_by: null, source_message_id: null, episode_id: null, payload: {}, created_at: now, updated_at: now },
      { id: "expired-job", group_id: "job-runner-group", job_type: "test", status: "pending", idempotency_key: "expired-key", due_at: now, attempts: 0, locked_at: null, locked_by: null, source_message_id: null, episode_id: null, payload: { expiresAt: new Date(now.getTime() - 1_000).toISOString() }, created_at: now, updated_at: now },
      { id: "protected-job", group_id: "job-runner-group", job_type: "test", status: "claimed", idempotency_key: "protected-key", due_at: now, attempts: 1, locked_at: new Date(now.getTime() - 120_000), locked_by: "response-worker", source_message_id: null, episode_id: null, payload: { responseClaimed: true }, created_at: now, updated_at: now },
    ]).execute();

    const storeA = createJobStore(db);
    const storeB = createJobStore(db);
    const expired = await storeA.expireDueJobs(now);
    assert.deepEqual(expired, ["expired-job"]);
    const [claimedA, claimedB] = await Promise.all([
      storeA.claimDueJobs({ workerId: "worker-a", now, limit: 10, staleLockBefore: new Date(now.getTime() - 30_000) }),
      storeB.claimDueJobs({ workerId: "worker-b", now, limit: 10, staleLockBefore: new Date(now.getTime() - 30_000) }),
    ]);
    const claimedIds = [...claimedA, ...claimedB].map((job) => job.id).sort();
    assert.deepEqual(claimedIds, ["due-job", "stale-job"]);
    assert.equal(new Set(claimedIds).size, 2);
    assert.equal((await db.selectFrom("delayed_jobs").selectAll().where("id", "=", "future-job").executeTakeFirstOrThrow()).status, "pending");
    assert.equal((await db.selectFrom("delayed_jobs").selectAll().where("id", "=", "protected-job").executeTakeFirstOrThrow()).status, "claimed");
    assert.equal(await storeA.cancelByIdempotencyKey("due-key"), 1);
  } finally {
    await db.destroy();
  }
});

