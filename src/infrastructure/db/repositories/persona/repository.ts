import type { Kysely } from "kysely";
import { ConflictError } from "../../../../shared/index.ts";
import type { ObservationStore } from "../../../../modules/persona-service/index.ts";
import type { PersonaAlias, PersonaFact, PersonaMember, PersonaObservation } from "../../../../modules/persona-service/index.ts";
import type { Database } from "../../types.ts";

const normalize = (value: string) => value.trim().normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase();
const date = (value: unknown): Date => value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
const metadata = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

function member(row: Record<string, unknown>): PersonaMember { return { id: String(row.id), groupId: String(row.group_id), lineUserId: String(row.line_user_id), displayName: row.display_name as string | null, memoryOptedOut: Boolean(row.memory_opted_out), leftAt: row.left_at ? date(row.left_at) : null }; }
function alias(row: Record<string, unknown>): PersonaAlias { return { id: String(row.id), groupId: String(row.group_id), memberId: String(row.member_id), alias: String(row.alias), normalizedAlias: String(row.normalized_alias), isPrimary: Boolean(row.is_primary), createdAt: date(row.created_at) }; }
function observation(row: Record<string, unknown>): PersonaObservation { return { id: String(row.id), groupId: String(row.group_id), subjectMemberId: String(row.subject_member_id), sourceMessageId: row.source_message_id as string | null, extractedByMemberId: row.extracted_by_member_id as string | null, category: String(row.category) as PersonaObservation["category"], claim: String(row.claim), sourceStrength: String(row.source_strength) as PersonaObservation["sourceStrength"], confidence: Number(row.confidence), visibility: String(row.visibility) as PersonaObservation["visibility"], status: String(row.status) as PersonaObservation["status"], observedAt: date(row.observed_at), invalidatedAt: row.invalidated_at ? date(row.invalidated_at) : null, invalidationReason: row.invalidation_reason as string | null, metadata: metadata(row.metadata) }; }

async function links(db: Kysely<Database>, factId: string): Promise<readonly string[]> { const rows = await db.selectFrom("persona_fact_observations").select("observation_id").where("fact_id", "=", factId).execute(); return rows.map((row) => row.observation_id); }
async function fact(db: Kysely<Database>, row: Record<string, unknown>): Promise<PersonaFact> { return { id: String(row.id), groupId: String(row.group_id), subjectMemberId: String(row.subject_member_id), category: String(row.category) as PersonaFact["category"], claim: String(row.claim), confidence: Number(row.confidence), visibility: String(row.visibility) as PersonaFact["visibility"], active: Boolean(row.active), firstSeenAt: date(row.first_seen_at), lastSeenAt: date(row.last_seen_at), expiresOrDecayAt: date(row.expires_or_decay_at), archivedAt: row.archived_at ? date(row.archived_at) : null, observationIds: await links(db, String(row.id)) }; }

export function createPersonaRepository(db: Kysely<Database>): ObservationStore {
  return {
    async findMember(groupId, memberIdOrLineUserId) { const row = await db.selectFrom("members").selectAll().where("group_id", "=", groupId).where((eb) => eb.or([eb("id", "=", memberIdOrLineUserId), eb("line_user_id", "=", memberIdOrLineUserId)])).executeTakeFirst(); return row ? member(row) : null; },
    async listMembers(groupId) { const rows = await db.selectFrom("members").selectAll().where("group_id", "=", groupId).orderBy("id").execute(); return rows.map(member); },
    async findAlias(groupId, inputAlias) { const rows = await db.selectFrom("member_aliases").selectAll().where("group_id", "=", groupId).where("normalized_alias", "=", normalize(inputAlias)).execute(); return rows.map(alias); },
    async addAlias(value) {
      const row = await db.insertInto("member_aliases").values({ id: value.id, group_id: value.groupId, member_id: String(value.memberId), alias: value.alias, normalized_alias: value.normalizedAlias, is_primary: value.isPrimary, created_at: value.createdAt }).onConflict((oc) => oc.columns(["group_id", "normalized_alias"]).doNothing()).returningAll().executeTakeFirst();
      if (!row) throw new ConflictError("Alias is already used by another member");
      return alias(row);
    },
    async setMemoryOptOut(groupId, memberId, optedOut) { await db.updateTable("members").set({ memory_opted_out: optedOut, updated_at: new Date() }).where("group_id", "=", groupId).where("id", "=", memberId).execute(); },
    async findObservation(groupId, input) {
      let query = db.selectFrom("persona_observations").selectAll().where("group_id", "=", groupId).where("subject_member_id", "=", String(input.subjectMemberId)).where("category", "=", input.category).where("claim", "=", input.claim);
      query = input.sourceMessageId === null ? query.where("source_message_id", "is", null) : query.where("source_message_id", "=", input.sourceMessageId);
      const row = await query.executeTakeFirst(); return row ? observation(row) : null;
    },
    async createObservation(value) {
      const existing = await this.findObservation(value.groupId, value); if (existing) return existing;
      const row = await db.insertInto("persona_observations").values({ id: String(value.id), group_id: value.groupId, subject_member_id: String(value.subjectMemberId), source_message_id: value.sourceMessageId, extracted_by_member_id: value.extractedByMemberId ? String(value.extractedByMemberId) : null, category: value.category, claim: value.claim, source_strength: value.sourceStrength, confidence: value.confidence, visibility: value.visibility, status: value.status, observed_at: value.observedAt, invalidated_at: value.invalidatedAt, invalidation_reason: value.invalidationReason, metadata: value.metadata as never, created_at: new Date() }).onConflict((oc) => oc.column("id").doNothing()).returningAll().executeTakeFirst();
      if (row) return observation(row);
      const existingAfterConflict = await this.findObservation(value.groupId, value);
      if (existingAfterConflict) return existingAfterConflict;
      const byId = await db.selectFrom("persona_observations").selectAll().where("id", "=", String(value.id)).executeTakeFirst();
      if (!byId) throw new Error("Observation insert was not visible after idempotent conflict");
      return observation(byId);
    },
    async listObservations(groupId, query = {}) { const rows = await db.selectFrom("persona_observations").selectAll().where("group_id", "=", groupId).$if(query.subjectMemberId !== undefined, (builder) => builder.where("subject_member_id", "=", query.subjectMemberId as string)).$if(query.category !== undefined, (builder) => builder.where("category", "=", query.category as string)).$if(query.activeOnly === true, (builder) => builder.where("status", "=", "active")).orderBy("observed_at", "desc").execute(); return rows.map(observation); },
    async listFacts(query) { const rows = await db.selectFrom("persona_facts").selectAll().where("group_id", "=", query.groupId).$if(query.subjectMemberId !== undefined, (builder) => builder.where("subject_member_id", "=", query.subjectMemberId as string)).$if(query.category !== undefined, (builder) => builder.where("category", "=", query.category as string)).$if(query.includeRisky !== true, (builder) => builder.where("visibility", "!=", "risky")).orderBy("updated_at", "desc").execute(); const result = await Promise.all(rows.map((row) => fact(db, row))); return query.visibility === undefined ? result : result.filter((item) => query.visibility?.includes(item.visibility)); },
    async createFact(value) {
      await db.insertInto("persona_facts").values({ id: String(value.id), group_id: value.groupId, subject_member_id: String(value.subjectMemberId), category: value.category, claim: value.claim, confidence: value.confidence, visibility: value.visibility, active: value.active, first_seen_at: value.firstSeenAt, last_seen_at: value.lastSeenAt, expires_or_decay_at: value.expiresOrDecayAt, archived_at: value.archivedAt, created_at: new Date(), updated_at: new Date() }).onConflict((oc) => oc.column("id").doNothing()).execute();
      if (value.observationIds.length > 0) await db.insertInto("persona_fact_observations").values(value.observationIds.map((id) => ({ fact_id: String(value.id), observation_id: String(id), is_supporting: true, linked_at: new Date() }))).onConflict((oc) => oc.columns(["fact_id", "observation_id"]).doNothing()).execute();
      const row = await db.selectFrom("persona_facts").selectAll().where("id", "=", String(value.id)).executeTakeFirstOrThrow();
      return fact(db, row);
    },
    async updateFact(value) {
      await db.updateTable("persona_facts").set({ claim: value.claim, confidence: value.confidence, visibility: value.visibility, active: value.active, first_seen_at: value.firstSeenAt, last_seen_at: value.lastSeenAt, expires_or_decay_at: value.expiresOrDecayAt, archived_at: value.archivedAt, updated_at: new Date() }).where("id", "=", String(value.id)).execute();
      await db.deleteFrom("persona_fact_observations").where("fact_id", "=", String(value.id)).execute();
      if (value.observationIds.length > 0) await db.insertInto("persona_fact_observations").values(value.observationIds.map((id) => ({ fact_id: String(value.id), observation_id: String(id), is_supporting: true, linked_at: new Date() }))).execute();
      const row = await db.selectFrom("persona_facts").selectAll().where("id", "=", String(value.id)).executeTakeFirstOrThrow(); return fact(db, row);
    },
  };
}

export const createKyselyPersonaRepository = createPersonaRepository;

