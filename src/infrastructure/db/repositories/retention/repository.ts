import { sql, type Kysely } from "kysely";
import type { LifecycleAudit, LifecycleRepository, LifecycleResult, ForgetInput, RetentionSweepInput, UnsendInput } from "../../../../modules/data-lifecycle/index.ts";
import type { Database } from "../../types.ts";

const DAY_MS = 86_400_000;
const count = (value: bigint | number): number => typeof value === "bigint" ? Number(value) : value;
const emptyResult = (overrides: Partial<LifecycleResult> = {}): LifecycleResult => ({ alreadyApplied: false, messagesDeleted: 0, jobsCancelled: 0, observationsInvalidated: 0, factsArchived: 0, contentLogsDeleted: 0, aliasesDeleted: 0, tombstoneCreated: false, ...overrides });

async function audit(trx: Kysely<Database>, input: LifecycleAudit): Promise<void> {
  await trx.insertInto("audit_events").values({ id: crypto.randomUUID(), group_id: input.groupId, actor_member_id: input.actorMemberId ?? null, action: input.action, target_type: input.targetType, target_id: input.targetId ?? null, metadata: {}, created_at: input.occurredAt }).execute();
}

async function archiveFactsWithoutActiveEvidence(trx: Kysely<Database>, factIds: readonly string[], at: Date): Promise<number> {
  let archived = 0;
  for (const factId of factIds) {
    const linked = await trx.selectFrom("persona_fact_observations as pfo").innerJoin("persona_observations as po", "po.id", "pfo.observation_id").select("po.id").where("pfo.fact_id", "=", factId).where("po.status", "=", "active").executeTakeFirst();
    if (linked) continue;
    const updated = await trx.updateTable("persona_facts").set({ active: false, archived_at: at, updated_at: at }).where("id", "=", factId).where("active", "=", true).executeTakeFirst();
    archived += count(updated.numUpdatedRows);
  }
  return archived;
}

async function cancelJobsForMessages(trx: Kysely<Database>, messageIds: readonly string[], at: Date): Promise<number> {
  if (messageIds.length === 0) return 0;
  const updated = await trx.updateTable("delayed_jobs").set({ status: "cancelled", locked_at: null, locked_by: null, last_error: "cancelled", updated_at: at }).where("status", "in", ["pending", "claimed"]).where((eb) => eb.or([eb("source_message_id", "in", [...messageIds]), sql<boolean>`payload->>'targetMessageId' IN (${sql.join(messageIds)})`])).executeTakeFirst();
  return count(updated.numUpdatedRows);
}

export function createRetentionRepository(db: Kysely<Database>): LifecycleRepository {
  return {
    async unsend(input: UnsendInput, auditInput: LifecycleAudit): Promise<LifecycleResult> {
      const at = input.occurredAt ?? new Date();
      return db.transaction().execute(async (trx) => {
        const existing = await trx.selectFrom("message_tombstones").select("id").where("group_id", "=", input.groupId).where("line_message_id", "=", input.lineMessageId).forUpdate().executeTakeFirst();
        if (existing) return emptyResult({ alreadyApplied: true });
        const message = await trx.selectFrom("messages").select(["id", "line_message_id"]).where("group_id", "=", input.groupId).where((eb) => eb.or([eb("id", "=", input.messageId ?? ""), eb("line_message_id", "=", input.lineMessageId)])).forUpdate().executeTakeFirst();
        const messageId = message?.id ?? null;
        await trx.insertInto("message_tombstones").values({ id: crypto.randomUUID(), group_id: input.groupId, message_id: messageId, line_message_id: input.lineMessageId, reason: "unsent", invalidated_at: at, created_at: at }).execute();
        const jobsCancelled = await cancelJobsForMessages(trx, messageId ? [messageId] : [], at);
        let observationsInvalidated = 0; let factsArchived = 0;
        if (messageId) {
          const affected = await trx.selectFrom("persona_observations").select(["id"]).where("group_id", "=", input.groupId).where("source_message_id", "=", messageId).where("status", "=", "active").execute();
          const affectedIds = affected.map((row) => row.id);
          const factRows = affectedIds.length === 0 ? [] : await trx.selectFrom("persona_fact_observations").select("fact_id").where("observation_id", "in", affectedIds).execute();
          observationsInvalidated = count((await trx.updateTable("persona_observations").set({ status: "invalidated", invalidated_at: at, invalidation_reason: "unsent" }).where("group_id", "=", input.groupId).where("source_message_id", "=", messageId).where("status", "=", "active").executeTakeFirst()).numUpdatedRows);
          factsArchived = await archiveFactsWithoutActiveEvidence(trx, [...new Set(factRows.map((row) => row.fact_id))], at);
          await trx.deleteFrom("messages").where("id", "=", messageId).execute();
        }
        await audit(trx, auditInput);
        return emptyResult({ messagesDeleted: message ? 1 : 0, jobsCancelled, observationsInvalidated, factsArchived, tombstoneCreated: true });
      });
    },

    async forgetMe(input: ForgetInput, auditInput: LifecycleAudit): Promise<LifecycleResult> {
      const at = input.occurredAt ?? new Date();
      return db.transaction().execute(async (trx) => {
        const member = await trx.selectFrom("members").select("id").where("group_id", "=", input.groupId).where("id", "=", input.memberId).executeTakeFirst();
        if (!member) return emptyResult({ alreadyApplied: true });
        const messages = await trx.selectFrom("messages").select("id").where("group_id", "=", input.groupId).where("sender_member_id", "=", member.id).forUpdate().execute();
        const messageIds = messages.map((row) => row.id);
        const jobsCancelled = await cancelJobsForMessages(trx, messageIds, at);
        const observations = await trx.selectFrom("persona_observations").select("id").where("group_id", "=", input.groupId).where("subject_member_id", "=", member.id).where("status", "=", "active").execute();
        const activeFacts = await trx.selectFrom("persona_facts").select("id").where("group_id", "=", input.groupId).where("subject_member_id", "=", member.id).where("active", "=", true).execute();
        const aliases = await trx.selectFrom("member_aliases").select("id").where("group_id", "=", input.groupId).where("member_id", "=", member.id).execute();
        if (messageIds.length === 0 && observations.length === 0 && activeFacts.length === 0 && aliases.length === 0) return emptyResult({ alreadyApplied: true });
        const observationsInvalidated = count((await trx.updateTable("persona_observations").set({ status: "invalidated", invalidated_at: at, invalidation_reason: "forgotten" }).where("group_id", "=", input.groupId).where("subject_member_id", "=", member.id).where("status", "=", "active").executeTakeFirst()).numUpdatedRows);
        const factsArchived = count((await trx.updateTable("persona_facts").set({ active: false, archived_at: at, updated_at: at }).where("group_id", "=", input.groupId).where("subject_member_id", "=", member.id).where("active", "=", true).executeTakeFirst()).numUpdatedRows);
        const aliasesDeleted = count((await trx.deleteFrom("member_aliases").where("group_id", "=", input.groupId).where("member_id", "=", member.id).executeTakeFirst()).numDeletedRows);
        if (messageIds.length > 0) {
          const rows = await trx.selectFrom("messages").select(["id", "line_message_id"]).where("id", "in", messageIds).execute();
          for (const row of rows) if (row.line_message_id) await trx.insertInto("message_tombstones").values({ id: crypto.randomUUID(), group_id: input.groupId, message_id: row.id, line_message_id: row.line_message_id, reason: "forgotten", invalidated_at: at, created_at: at }).onConflict((oc) => oc.column("line_message_id").doNothing()).execute();
        }
        await trx.deleteFrom("messages").where("id", "in", messageIds.length ? messageIds : ["__none__"]).execute();
        await audit(trx, auditInput);
        return emptyResult({ messagesDeleted: messageIds.length, jobsCancelled, observationsInvalidated: observations.length ? observationsInvalidated : 0, factsArchived, aliasesDeleted });
      });
    },

    async sweep(input: RetentionSweepInput, auditInput?: LifecycleAudit): Promise<LifecycleResult> {
      if (!input.policy || !input.now) throw new Error("Sweep policy and time are required");
      const { now, policy } = input;
      return db.transaction().execute(async (trx) => {
        let messagesQuery = trx.selectFrom("messages").select("id").where("sent_at", "<", new Date(now.getTime() - policy.rawMessageRetentionDays * DAY_MS));
        if (input.groupId) messagesQuery = messagesQuery.where("group_id", "=", input.groupId) as typeof messagesQuery;
        const messages = await messagesQuery.execute(); const messageIds = messages.map((row) => row.id);
        const jobsCancelled = await cancelJobsForMessages(trx, messageIds, now);
        if (messageIds.length > 0) {
          const rows = await trx.selectFrom("messages").select(["id", "group_id", "line_message_id"]).where("id", "in", messageIds).execute();
          for (const row of rows) if (row.line_message_id) await trx.insertInto("message_tombstones").values({ id: crypto.randomUUID(), group_id: row.group_id, message_id: row.id, line_message_id: row.line_message_id, reason: "retention", invalidated_at: now, created_at: now }).onConflict((oc) => oc.column("line_message_id").doNothing()).execute();
        }
        const messagesDeleted = messageIds.length ? count((await trx.deleteFrom("messages").where("id", "in", messageIds).executeTakeFirst()).numDeletedRows) : 0;
        let logsQuery = trx.deleteFrom("content_debug_logs").where((eb) => eb.or([eb("expires_at", "<=", now), eb("created_at", "<", new Date(now.getTime() - policy.contentLogRetentionDays * DAY_MS))]));
        if (input.groupId) logsQuery = logsQuery.where("group_id", "=", input.groupId) as typeof logsQuery;
        const contentLogsDeleted = count((await logsQuery.executeTakeFirst()).numDeletedRows);
        let factsQuery = trx.updateTable("persona_facts").set({ active: false, archived_at: now, updated_at: now }).where("active", "=", true).where("last_seen_at", "<=", new Date(now.getTime() - policy.personaDecayDays * DAY_MS));
        if (input.groupId) factsQuery = factsQuery.where("group_id", "=", input.groupId) as typeof factsQuery;
        const factsArchived = count((await factsQuery.executeTakeFirst()).numUpdatedRows);
        if (auditInput) await audit(trx, auditInput);
        return emptyResult({ messagesDeleted, jobsCancelled, contentLogsDeleted, factsArchived });
      });
    },
  };
}

export const createKyselyRetentionRepository = createRetentionRepository;

