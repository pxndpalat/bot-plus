import type { Kysely } from "kysely";
import type { DecisionRecord, DecisionRepository, DecisionUsage } from "../../../../modules/decision-engine/index.ts";
import type { Database } from "../../types.ts";

const date = (value: unknown): Date => value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
const ids = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function record(row: Record<string, unknown>): DecisionRecord {
  return {
    id: String(row.id), groupId: String(row.group_id), sourceMessageId: row.source_message_id as string | null,
    episodeId: row.episode_id as string | null, responseId: row.response_id as string | null,
    decisionType: String(row.decision_type) as DecisionRecord["decisionType"], respond: Boolean(row.respond), reason: String(row.reason),
    interestScore: row.interest_score === null || row.interest_score === undefined ? null : Number(row.interest_score),
    answeredByHuman: row.answered_by_human === null || row.answered_by_human === undefined ? null : Boolean(row.answered_by_human),
    safety: String(row.safety) as DecisionRecord["safety"], draft: row.draft as string | null,
    usedFactIds: ids(row.used_fact_ids), suppressionReason: row.suppression_reason as DecisionRecord["suppressionReason"], createdAt: date(row.created_at),
  };
}

export function createDecisionRepository(db: Kysely<Database>): DecisionRepository {
  return {
    async createDecision(value) {
      const row = await db.insertInto("decision_records").values({
        id: value.id, group_id: value.groupId, source_message_id: value.sourceMessageId, episode_id: value.episodeId, response_id: value.responseId,
        decision_type: value.decisionType, respond: value.respond, reason: value.reason, interest_score: value.interestScore,
        answered_by_human: value.answeredByHuman, safety: value.safety, draft: value.draft, used_fact_ids: value.usedFactIds as never,
        suppression_reason: value.suppressionReason, created_at: value.createdAt,
      }).onConflict((oc) => oc.column("id").doNothing()).returningAll().executeTakeFirst();
      if (row) return record(row);
      const existing = await db.selectFrom("decision_records").selectAll().where("id", "=", value.id).executeTakeFirstOrThrow();
      return record(existing);
    },
    async recordUsage(value: DecisionUsage) {
      await db.insertInto("ai_usage_events").values({
        id: value.id ?? crypto.randomUUID(), group_id: value.groupId, decision_id: value.decisionId ?? null, operation: value.operation,
        model: value.model, input_tokens: value.usage.inputTokens, output_tokens: value.usage.outputTokens, total_tokens: value.usage.totalTokens,
        occurred_at: value.occurredAt, request_id: value.requestId ?? null, metadata: {} as never,
      }).execute();
    },
    async getLastAmbientResponseAt(groupId, before) {
      const row = await db.selectFrom("decision_records").select("created_at").where("group_id", "=", groupId).where("decision_type", "=", "ambient").where("respond", "=", true).where("created_at", "<=", before).orderBy("created_at", "desc").executeTakeFirst();
      return row ? date(row.created_at) : null;
    },
    async countAmbientResponsesSince(groupId, since, until) {
      const row = await db.selectFrom("decision_records").select(({ fn }) => fn.countAll<number>().as("count")).where("group_id", "=", groupId).where("decision_type", "=", "ambient").where("respond", "=", true).where("created_at", ">=", since).where("created_at", "<=", until).executeTakeFirst();
      return Number(row?.count ?? 0);
    },
  };
}

export const createKyselyDecisionRepository = createDecisionRepository;

