import type { Kysely } from "kysely";
import type {
  LineEvent,
  LineMemberEvent,
  LineMessageEvent,
  LineMessage,
} from "../../../../modules/line-adapter/index.ts";
import type { WebhookIngestRepository, WebhookIngestResult, IngestJobIntent, IngestJobType } from "../../../../modules/webhook-ingest/index.ts";
import type { Database, JsonValue } from "../../types.ts";
import type { JsonObject } from "../../../../modules/line-adapter/index.ts";

const REPLY_TOKEN_LIFETIME_MS = 60_000;

export interface WebhookIngestRepositoryOptions {
  readonly idGenerator?: () => string;
  readonly dailyTokenBudget?: number;
  readonly ambientMinDelaySeconds?: number;
  readonly ambientMaxDelaySeconds?: number;
  readonly ambientCooldownSeconds?: number;
  readonly rawMessageRetentionDays?: number;
  readonly contentLogRetentionDays?: number;
  readonly personaDecayDays?: number;
}

function idGenerator(): string {
  return crypto.randomUUID();
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child !== undefined) result[key] = jsonValue(child);
    }
    return result;
  }
  return String(value);
}

/**
 * The adapter exposes message metadata as a provider-independent object. Some
 * fixture/provider boundaries put unknown provider fields under one
 * `unknownMetadata` envelope; persist the canonical metadata object rather
 * than introducing that envelope as a second layer in PostgreSQL JSONB.
 */
export function canonicalMediaMetadata(metadata: JsonObject): JsonValue {
  let current: JsonObject = metadata;
  while (Object.keys(current).length === 1 && typeof current.unknownMetadata === "object" && current.unknownMetadata !== null && !Array.isArray(current.unknownMetadata)) {
    current = current.unknownMetadata as JsonObject;
  }
  if (current !== metadata) return jsonValue(current);
  if (typeof metadata.unknownMetadata === "object" && metadata.unknownMetadata !== null && !Array.isArray(metadata.unknownMetadata)) {
    const { unknownMetadata, ...rest } = metadata;
    return jsonValue({ ...(unknownMetadata as JsonObject), ...rest });
  }
  return jsonValue(metadata);
}

/** Persist text addressing data with provider metadata so durable jobs can
 * reconstruct command/direct invocation semantics after a restart. */
export function persistedMessageMetadata(message: LineMessage): JsonValue {
  const canonical = canonicalMediaMetadata(message.metadata);
  if (message.type !== "text") return canonical;
  const base = typeof canonical === "object" && canonical !== null && !Array.isArray(canonical)
    ? canonical
    : { providerMetadata: canonical };
  return jsonValue({
    ...base,
    mentions: message.mentions.map((mention) => ({
      index: mention.index,
      length: mention.length,
      isSelf: mention.isSelf,
      ...(mention.userId ? { userId: String(mention.userId) } : {}),
    })),
  });
}

function sourceGroupId(event: LineEvent): string {
  const groupId = event.source.groupId;
  if (!groupId) throw new TypeError("Webhook event must have a LINE group source");
  return String(groupId);
}

function eventPayload(event: LineEvent): JsonValue {
  const base: Record<string, unknown> = {
    webhookEventId: String(event.webhookEventId),
    eventType: event.eventType,
    source: {
      type: event.source.type,
      groupId: event.source.groupId ? String(event.source.groupId) : undefined,
      userId: event.source.userId ? String(event.source.userId) : undefined,
    },
    eventAt: event.eventAt.toISOString(),
    receivedAt: event.receivedAt.toISOString(),
    redelivered: event.redelivered,
  };
  if (event.type === "message") {
    base.message = {
      id: String(event.message.id),
      type: event.message.type,
      text: event.message.type === "text" ? event.message.text : undefined,
      quotedMessageId: event.message.quotedMessageId ? String(event.message.quotedMessageId) : undefined,
      metadata: canonicalMediaMetadata(event.message.metadata),
    };
  } else if (event.type === "unsend") {
    base.messageId = String(event.messageId);
  } else {
    base.memberIds = event.memberIds.map(String);
  }
  return jsonValue(base);
}

function messageType(message: LineMessage): "text" | "sticker" | "image" | "video" | "audio" | "file" | "other" {
  return message.type === "text" || message.type === "sticker" || message.type === "image" || message.type === "video" || message.type === "audio" || message.type === "file"
    ? message.type
    : "other";
}

function isDirect(message: LineMessage): boolean {
  return message.type === "text" && (message.mentions.some((mention) => mention.isSelf) || Boolean(message.quotedMessageId));
}

function jobIntent(type: IngestJobType, eventId: string, dueAt: Date, sourceMessageId?: string): IngestJobIntent {
  return {
    type,
    idempotencyKey: `${eventId}:${type}`,
    dueAt: new Date(dueAt.getTime()),
    ...(sourceMessageId ? { sourceMessageId } : {}),
  };
}

function messageJobs(event: LineMessageEvent, messageId: string): readonly IngestJobIntent[] {
  const direct = isDirect(event.message);
  const jobs: IngestJobIntent[] = [
    jobIntent(direct ? "direct" : "ambient_candidate", String(event.webhookEventId), event.receivedAt, messageId),
  ];
  if (event.message.type === "text") jobs.push(jobIntent("persona_extract", String(event.webhookEventId), event.receivedAt, messageId));
  return jobs;
}

async function ensureGroup(
  trx: Kysely<Database>,
  groupId: string,
  at: Date,
  defaults: WebhookIngestRepositoryOptions,
): Promise<void> {
  await trx
    .insertInto("groups")
    .values({ id: groupId, line_group_id: groupId, joined_at: at, created_at: at, updated_at: at })
    .onConflict((oc) => oc.column("line_group_id").doUpdateSet({ updated_at: at }))
    .execute();
  await trx
    .insertInto("group_settings")
    .values({
      group_id: groupId,
      mode: "normal",
      muted_until: null,
      ambient_enabled: true,
      ambient_min_delay_seconds: defaults.ambientMinDelaySeconds ?? 15,
      ambient_max_delay_seconds: defaults.ambientMaxDelaySeconds ?? 30,
      ambient_cooldown_seconds: defaults.ambientCooldownSeconds ?? 180,
      daily_token_budget: defaults.dailyTokenBudget ?? 100_000,
      raw_message_retention_days: defaults.rawMessageRetentionDays ?? 30,
      content_log_retention_days: defaults.contentLogRetentionDays ?? 7,
      persona_decay_days: defaults.personaDecayDays ?? 180,
      created_at: at,
      updated_at: at,
    })
    .onConflict((oc) => oc.column("group_id").doNothing())
    .execute();
}

async function ensureMember(trx: Kysely<Database>, groupId: string, userId: string, at: Date): Promise<void> {
  await trx
    .insertInto("members")
    .values({ id: userId, group_id: groupId, line_user_id: userId, joined_at: at, memory_opted_out: false, created_at: at, updated_at: at })
    .onConflict((oc) => oc.columns(["group_id", "line_user_id"]).doUpdateSet({ updated_at: at }))
    .execute();
}

async function memberEventMembers(trx: Kysely<Database>, event: LineMemberEvent, groupId: string): Promise<void> {
  for (const memberId of event.memberIds) {
    const userId = String(memberId);
    await ensureMember(trx, groupId, userId, event.eventAt);
    if (event.type === "join") {
      await trx.updateTable("members").set({ left_at: null, updated_at: event.eventAt }).where("group_id", "=", groupId).where("line_user_id", "=", userId).execute();
    } else {
      await trx.updateTable("members").set({ left_at: event.eventAt, updated_at: event.eventAt }).where("group_id", "=", groupId).where("line_user_id", "=", userId).execute();
    }
  }
}

export function createWebhookIngestRepository(
  db: Kysely<Database>,
  options: WebhookIngestRepositoryOptions = {},
): WebhookIngestRepository {
  const nextId = options.idGenerator ?? idGenerator;
  const recordVerifiedEvent = async (event: LineEvent): Promise<WebhookIngestResult> => {
      const groupId = sourceGroupId(event);
      return db.transaction().execute(async (trx) => {
        await ensureGroup(trx, groupId, event.eventAt, options);
        if (event.source.userId) await ensureMember(trx, groupId, String(event.source.userId), event.eventAt);

        const databaseEventId = nextId();
        const inserted = await trx
          .insertInto("webhook_events")
          .values({
            id: databaseEventId,
            webhook_event_id: String(event.webhookEventId),
            group_id: groupId,
            event_type: event.eventType,
            event_at: event.eventAt,
            received_at: event.receivedAt,
            redelivered: event.redelivered,
            payload: eventPayload(event),
            created_at: event.receivedAt,
          })
          .onConflict((oc) => oc.column("webhook_event_id").doNothing())
          .returning("id")
          .executeTakeFirst();

        if (!inserted) {
          const existing = await trx.selectFrom("webhook_events").select("id").where("webhook_event_id", "=", String(event.webhookEventId)).executeTakeFirst();
          return {
            duplicate: true,
            webhookEventId: String(event.webhookEventId),
            ...(existing ? { databaseEventId: existing.id } : {}),
            jobs: [],
          };
        }

        const jobs: IngestJobIntent[] = [];
        let messageId: string | undefined;
        if (event.type === "message") {
          const senderId = event.source.userId ? String(event.source.userId) : undefined;
          if (senderId) await ensureMember(trx, groupId, senderId, event.eventAt);
          messageId = nextId();
          const replyReceivedAt = event.replyToken ? event.receivedAt : undefined;
          const replyExpiresAt = replyReceivedAt ? new Date(replyReceivedAt.getTime() + REPLY_TOKEN_LIFETIME_MS) : undefined;
          await trx
            .insertInto("messages")
            .values({
              id: messageId,
              webhook_event_id: inserted.id,
              group_id: groupId,
              sender_member_id: senderId ?? null,
              line_message_id: String(event.message.id),
              message_type: messageType(event.message),
              text_content: event.message.type === "text" ? event.message.text : null,
              media_metadata: persistedMessageMetadata(event.message),
              line_quoted_message_id: event.message.quotedMessageId ? String(event.message.quotedMessageId) : null,
              sent_at: event.eventAt,
              received_at: event.receivedAt,
              reply_token: event.replyToken ?? null,
              reply_token_received_at: replyReceivedAt ?? null,
              reply_token_expires_at: replyExpiresAt ?? null,
              created_at: event.receivedAt,
            })
            .execute();
          jobs.push(...messageJobs(event, messageId));
        } else if (event.type === "unsend") {
          jobs.push(jobIntent("unsend", String(event.webhookEventId), event.receivedAt));
        } else {
          await memberEventMembers(trx, event, groupId);
          if (event.type === "join" && event.replyToken) {
            jobs.push(jobIntent("join_transparency", String(event.webhookEventId), event.receivedAt));
          }
        }

        for (const job of jobs) {
          await trx
            .insertInto("delayed_jobs")
            .values({
              id: nextId(),
              group_id: groupId,
              job_type: job.type,
              status: "pending",
              idempotency_key: job.idempotencyKey,
              due_at: job.dueAt,
              attempts: 0,
              source_message_id: job.sourceMessageId ?? null,
              episode_id: null,
              payload: jsonValue({
                webhookEventId: String(event.webhookEventId),
                jobType: job.type,
                targetMessageId: event.type === "unsend" ? String(event.messageId) : undefined,
                replyToken: event.type === "join" ? event.replyToken : undefined,
                replyTokenReceivedAt: event.type === "join" && event.replyToken ? event.receivedAt.toISOString() : undefined,
                replyTokenExpiresAt: event.type === "join" && event.replyToken
                  ? new Date(event.receivedAt.getTime() + REPLY_TOKEN_LIFETIME_MS).toISOString()
                  : undefined,
              }),
              created_at: event.receivedAt,
              updated_at: event.receivedAt,
            })
            .execute();
        }

        return {
          duplicate: false,
          webhookEventId: String(event.webhookEventId),
          databaseEventId: inserted.id,
          ...(messageId ? { messageId } : {}),
          jobs,
        };
      });
    };

  return {
    recordVerifiedEvent,
    ingest: recordVerifiedEvent,
  };
}

export const createWebhookIngestStore = createWebhookIngestRepository;
