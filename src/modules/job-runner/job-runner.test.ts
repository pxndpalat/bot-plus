import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createJobHandlerRegistry } from "./registry.ts";
import { createJobRunner, RetryableJobError } from "./runner.ts";
import type { ClaimedJob, ClaimJobsInput, JobStore } from "./types.ts";

type MutableJob = Omit<ClaimedJob, "dueAt" | "attempts" | "lockedAt" | "lockedBy"> & {
  dueAt: Date;
  attempts: number;
  lockedAt: Date;
  lockedBy: string;
  mutableStatus: "pending" | "claimed" | "completed" | "cancelled" | "expired" | "failed";
};

class MemoryStore implements JobStore {
  readonly jobs: MutableJob[] = [];
  readonly retries: Date[] = [];
  readonly calls: string[] = [];

  add(job: Partial<ClaimedJob> & { id: string; jobType: string; dueAt: Date; payload?: Readonly<Record<string, unknown>> }): void {
    this.jobs.push({
      id: job.id,
      groupId: job.groupId ?? "group-1",
      jobType: job.jobType,
      status: "claimed",
      mutableStatus: "pending",
      idempotencyKey: job.idempotencyKey ?? job.id,
      dueAt: job.dueAt,
      attempts: job.attempts ?? 0,
      lockedAt: job.lockedAt ?? new Date(0),
      lockedBy: job.lockedBy ?? "",
      ...(job.sourceMessageId ? { sourceMessageId: job.sourceMessageId } : {}),
      ...(job.episodeId ? { episodeId: job.episodeId } : {}),
      payload: job.payload ?? {},
    });
  }

  async claimDueJobs(input: ClaimJobsInput): Promise<readonly ClaimedJob[]> {
    this.calls.push("claim");
    for (const job of this.jobs) {
      if (job.mutableStatus === "claimed" && job.lockedAt < input.staleLockBefore && job.payload.responseClaimed !== true) {
        job.mutableStatus = "pending";
        job.lockedBy = "";
      }
    }
    return this.jobs
      .filter((job) => job.mutableStatus === "pending" && job.dueAt <= input.now)
      .slice(0, input.limit)
      .map((job) => {
        job.mutableStatus = "claimed";
        job.lockedBy = input.workerId;
        job.lockedAt = input.now;
        job.attempts += 1;
        return { ...job, status: "claimed" as const };
      });
  }

  async markDone(id: string, worker: string): Promise<boolean> { return this.transition(id, worker, "completed"); }
  async markCancelled(id: string, worker?: string): Promise<boolean> { return this.transition(id, worker, "cancelled"); }
  async markExpired(id: string, worker?: string): Promise<boolean> { return this.transition(id, worker, "expired"); }
  async scheduleRetry(id: string, worker: string, dueAt: Date): Promise<boolean> {
    const job = this.jobs.find((candidate) => candidate.id === id && candidate.mutableStatus === "claimed" && candidate.lockedBy === worker);
    if (!job) return false;
    job.mutableStatus = "pending";
    job.lockedBy = "";
    job.dueAt = dueAt;
    this.retries.push(dueAt);
    return true;
  }
  async markFailed(id: string, worker: string): Promise<boolean> { return this.transition(id, worker, "failed"); }
  async expireDueJobs(now: Date): Promise<readonly string[]> {
    const expired: string[] = [];
    for (const job of this.jobs) {
      const value = job.payload.expiresAt;
      if ((job.mutableStatus === "pending" || job.mutableStatus === "claimed") && typeof value === "string" && new Date(value) <= now) {
        job.mutableStatus = "expired";
        expired.push(job.id);
      }
    }
    return expired;
  }
  async cancelBySourceEvent(): Promise<number> { return 0; }
  async cancelBySourceMessage(): Promise<number> { return 0; }
  async cancelByMember(): Promise<number> { return 0; }
  async cancelByIdempotencyKey(): Promise<number> { return 0; }

  private transition(id: string, worker: string | undefined, status: "completed" | "cancelled" | "expired" | "failed"): boolean {
    const job = this.jobs.find((candidate) => candidate.id === id && (candidate.mutableStatus === "claimed" || candidate.mutableStatus === "pending") && (!worker || candidate.lockedBy === worker));
    if (!job) return false;
    job.mutableStatus = status;
    job.lockedBy = "";
    return true;
  }
}

test("claims due jobs once, skips future jobs, and reclaims stale locks", async () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const store = new MemoryStore();
  store.add({ id: "future", jobType: "future", dueAt: new Date(now.getTime() + 1_000) });
  store.add({ id: "stale", jobType: "stale", dueAt: now, lockedAt: new Date(now.getTime() - 100_000), lockedBy: "crashed-worker" });
  const registry = createJobHandlerRegistry({ future: async () => "done", stale: async () => "done" });
  const runner = createJobRunner({ store, handlers: registry, workerId: "worker-1", now: () => now, lockTimeoutMs: 30_000 });
  assert.equal(await runner.runOnce(), 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.jobs.find((job) => job.id === "future")?.mutableStatus, "pending");
  assert.equal(store.jobs.find((job) => job.id === "stale")?.mutableStatus, "completed");
});

test("retries are bounded and emit lifecycle telemetry", async () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const store = new MemoryStore();
  store.add({ id: "retry", jobType: "retry", dueAt: now });
  const telemetry: string[] = [];
  const runner = createJobRunner({
    store,
    workerId: "worker-1",
    maxAttempts: 2,
    retryDelayMs: 0,
    now: () => now,
    handlers: createJobHandlerRegistry({ retry: async () => { throw new RetryableJobError(); } }),
    telemetry: { emit: (event) => { telemetry.push(event.event); } },
  });
  await runner.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await runner.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.jobs[0]?.mutableStatus, "failed");
  assert.deepEqual(telemetry, ["job_claimed", "job_retry", "job_claimed", "job_failed"]);
});

test("handler lifecycle supports cancelled and expired jobs", async () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const store = new MemoryStore();
  store.add({ id: "cancel", jobType: "cancel", dueAt: now });
  store.add({ id: "expire", jobType: "expire", dueAt: now });
  const runner = createJobRunner({
    store,
    workerId: "worker-1",
    now: () => now,
    handlers: createJobHandlerRegistry({ cancel: async () => "cancelled", expire: async () => "expired" }),
  });
  await runner.runOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.jobs.find((job) => job.id === "cancel")?.mutableStatus, "cancelled");
  assert.equal(store.jobs.find((job) => job.id === "expire")?.mutableStatus, "expired");
});
