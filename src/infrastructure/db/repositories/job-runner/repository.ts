import { sql, type Kysely, type Selectable } from "kysely";
import type { Database, JsonValue } from "../../types.ts";
import type {
  ClaimedJob,
  ClaimJobsInput,
  JobStore,
} from "../../../../modules/job-runner/index.ts";

type JobRow = Selectable<Database["delayed_jobs"]>;

function recordPayload(value: JsonValue): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function toJob(row: JobRow): ClaimedJob {
  if (row.locked_at === null || row.locked_by === null) throw new Error("Claimed job is missing lock metadata");
  return {
    id: row.id,
    groupId: row.group_id,
    jobType: row.job_type,
    status: "claimed",
    idempotencyKey: row.idempotency_key,
    dueAt: new Date(row.due_at.getTime()),
    attempts: row.attempts,
    lockedAt: new Date(row.locked_at.getTime()),
    lockedBy: row.locked_by,
    ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    ...(row.episode_id ? { episodeId: row.episode_id } : {}),
    payload: recordPayload(row.payload),
  };
}

function count(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value;
}

export function createJobStore(db: Kysely<Database>): JobStore {
  return {
    async claimDueJobs(input: ClaimJobsInput): Promise<readonly ClaimedJob[]> {
      return db.transaction().execute(async (trx) => {
        await trx
          .updateTable("delayed_jobs")
          .set({ status: "pending", locked_at: null, locked_by: null, updated_at: input.now })
          .where("status", "=", "claimed")
          .where("locked_at", "<", input.staleLockBefore)
          .where(sql<boolean>`COALESCE(payload->>'responseClaimed', 'false') <> 'true'`)
          .execute();

        const rows = await trx
          .selectFrom("delayed_jobs")
          .selectAll()
          .where("status", "=", "pending")
          .where("due_at", "<=", input.now)
          .orderBy("due_at", "asc")
          .orderBy("id", "asc")
          .limit(input.limit)
          .forUpdate()
          .skipLocked()
          .execute();

        const claimed: ClaimedJob[] = [];
        for (const row of rows) {
          const updated = await trx
            .updateTable("delayed_jobs")
            .set({
              status: "claimed",
              locked_at: input.now,
              locked_by: input.workerId,
              attempts: sql<number>`attempts + 1`,
              updated_at: input.now,
            })
            .where("id", "=", row.id)
            .where("status", "=", "pending")
            .returningAll()
            .executeTakeFirst();
          if (updated) claimed.push(toJob(updated));
        }
        return claimed;
      });
    },

    async markDone(jobId, workerId): Promise<boolean> {
      const result = await db.updateTable("delayed_jobs").set({ status: "completed", locked_at: null, locked_by: null, updated_at: new Date() }).where("id", "=", jobId).where("status", "=", "claimed").where("locked_by", "=", workerId).executeTakeFirst();
      return count(result.numUpdatedRows) === 1;
    },

    async markCancelled(jobId, workerId): Promise<boolean> {
      let query = db.updateTable("delayed_jobs").set({ status: "cancelled", locked_at: null, locked_by: null, last_error: "cancelled", updated_at: new Date() }).where("id", "=", jobId).where("status", "in", ["pending", "claimed"]);
      if (workerId) query = query.where("locked_by", "=", workerId) as typeof query;
      const result = await query.executeTakeFirst();
      return count(result.numUpdatedRows) === 1;
    },

    async markExpired(jobId, workerId): Promise<boolean> {
      let query = db.updateTable("delayed_jobs").set({ status: "expired", locked_at: null, locked_by: null, last_error: "expired", updated_at: new Date() }).where("id", "=", jobId).where("status", "in", ["pending", "claimed"]);
      if (workerId) query = query.where("locked_by", "=", workerId) as typeof query;
      const result = await query.executeTakeFirst();
      return count(result.numUpdatedRows) === 1;
    },

    async scheduleRetry(jobId, workerId, dueAt, reason): Promise<boolean> {
      const result = await db.updateTable("delayed_jobs").set({ status: "pending", due_at: dueAt, locked_at: null, locked_by: null, last_error: reason ?? "retry", updated_at: new Date() }).where("id", "=", jobId).where("status", "=", "claimed").where("locked_by", "=", workerId).executeTakeFirst();
      return count(result.numUpdatedRows) === 1;
    },

    async markFailed(jobId, workerId, reason): Promise<boolean> {
      const result = await db.updateTable("delayed_jobs").set({ status: "failed", locked_at: null, locked_by: null, last_error: reason ?? "failed", updated_at: new Date() }).where("id", "=", jobId).where("status", "=", "claimed").where("locked_by", "=", workerId).executeTakeFirst();
      return count(result.numUpdatedRows) === 1;
    },

    async expireDueJobs(now): Promise<readonly string[]> {
      const rows = await db.selectFrom("delayed_jobs").select(["id", "payload"]).where("status", "in", ["pending", "claimed"]).execute();
      const expired: string[] = [];
      for (const row of rows) {
        const raw = recordPayload(row.payload).expiresAt;
        if (typeof raw !== "string") continue;
        const at = new Date(raw);
        if (Number.isNaN(at.getTime()) || at > now) continue;
        const result = await db.updateTable("delayed_jobs").set({ status: "expired", locked_at: null, locked_by: null, last_error: "expired", updated_at: now }).where("id", "=", row.id).where("status", "in", ["pending", "claimed"]).executeTakeFirst();
        if (count(result.numUpdatedRows) === 1) expired.push(row.id);
      }
      return expired;
    },

    async cancelBySourceEvent(sourceEventId): Promise<number> {
      const result = await db.updateTable("delayed_jobs").set({ status: "cancelled", locked_at: null, locked_by: null, last_error: "cancelled", updated_at: new Date() }).where("status", "in", ["pending", "claimed"]).where(sql<boolean>`payload->>'webhookEventId' = ${sourceEventId}`).executeTakeFirst();
      return count(result.numUpdatedRows);
    },

    async cancelBySourceMessage(sourceMessageId): Promise<number> {
      const result = await db.updateTable("delayed_jobs").set({ status: "cancelled", locked_at: null, locked_by: null, last_error: "cancelled", updated_at: new Date() }).where("status", "in", ["pending", "claimed"]).where("source_message_id", "=", sourceMessageId).executeTakeFirst();
      return count(result.numUpdatedRows);
    },

    async cancelByMember(memberId): Promise<number> {
      const messages = await db.selectFrom("messages").select("id").where("sender_member_id", "=", memberId).execute();
      if (messages.length === 0) return 0;
      const result = await db.updateTable("delayed_jobs").set({ status: "cancelled", locked_at: null, locked_by: null, last_error: "cancelled", updated_at: new Date() }).where("status", "in", ["pending", "claimed"]).where("source_message_id", "in", messages.map((row) => row.id)).executeTakeFirst();
      return count(result.numUpdatedRows);
    },

    async cancelByIdempotencyKey(idempotencyKey): Promise<number> {
      const result = await db.updateTable("delayed_jobs").set({ status: "cancelled", locked_at: null, locked_by: null, last_error: "cancelled", updated_at: new Date() }).where("status", "in", ["pending", "claimed"]).where("idempotency_key", "=", idempotencyKey).executeTakeFirst();
      return count(result.numUpdatedRows);
    },
  };
}

export const createJobRunnerRepository = createJobStore;
