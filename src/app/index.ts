import { Elysia } from "elysia";
import type { Kysely } from "kysely";
import { getMigrationStatus, createDatabase, type Database } from "../infrastructure/db/index.ts";
import { createConversationRepository } from "../infrastructure/db/repositories/conversation/index.ts";
import { createDecisionRepository } from "../infrastructure/db/repositories/decision-engine/index.ts";
import { createJobStore } from "../infrastructure/db/repositories/job-runner/index.ts";
import { createPersonaRepository } from "../infrastructure/db/repositories/persona/index.ts";
import { createRetentionRepository } from "../infrastructure/db/repositories/retention/index.ts";
import { createKyselySettingsRepository } from "../infrastructure/db/repositories/settings/index.ts";
import { createWebhookIngestRepository } from "../infrastructure/db/repositories/webhook-ingest/index.ts";
import {
  createAiClient,
  createOpenAIResponsesClient,
  createOpenAIResponsesTransport,
  type AiClient,
} from "../modules/ai-client/index.ts";
import { createAmbientPipeline, type AmbientPipeline } from "../modules/ambient-pipeline/index.ts";
import { createCommandHandler, type CommandHandler } from "../modules/command-service/index.ts";
import { createConversationService, type ConversationService } from "../modules/conversation-service/index.ts";
import { createDataLifecycleService, type LifecycleService } from "../modules/data-lifecycle/index.ts";
import { createDecisionEngine, type DecisionEngine } from "../modules/decision-engine/index.ts";
import { createDirectPipeline, type ResponseClaimStore } from "../modules/direct-pipeline/index.ts";
import { createJobHandlerRegistry, createJobRunner, type JobRunner } from "../modules/job-runner/index.ts";
import { createReplyPort, type LineEvent, type LineReplyPort, type LineTransportClient } from "../modules/line-adapter/index.ts";
import { createPersonaService, personaExtractionJsonSchema, type PersonaService } from "../modules/persona-service/index.ts";
import { SafetyGate } from "../modules/safety-gate/index.ts";
import { createSettingsService, type SettingsService } from "../modules/settings/index.ts";
import { createAuditEventPort, createLogger } from "../modules/telemetry/index.ts";
import { createWebhookIngestHandler } from "../modules/webhook-ingest/index.ts";
import { loadEnvironment, parseEnvironment, type Environment, type EnvironmentInput } from "../shared/index.ts";
import { assertLineSignature, parseWebhookPayload } from "../modules/line-adapter/index.ts";
import { createResponseClaimProof } from "../modules/line-adapter/index.ts";
import type { WebhookIngestHandler, WebhookIngestResult } from "../modules/webhook-ingest/index.ts";

export type AppState = "created" | "starting" | "running" | "stopping" | "stopped";

export interface ReadinessResult {
  readonly ready: boolean;
  readonly migrationVersion?: string | null;
  readonly database?: boolean;
}

export type ReadinessCheck = () => ReadinessResult | Promise<ReadinessResult>;

export interface AppOptions {
  readonly channelSecret?: string;
  readonly webhook?: WebhookIngestHandler;
  readonly ingest?: WebhookIngestHandler;
  readonly readiness?: ReadinessCheck;
  readonly database?: Kysely<Database>;
  readonly jobRunner?: JobRunner;
  readonly close?: () => void | Promise<void>;
  readonly clock?: { now(): Date };
  readonly shutdownTimeoutMs?: number;
}

export interface StartOptions {
  readonly hostname?: string;
  readonly port?: number;
}

export interface Application {
  readonly app: Elysia;
  readonly state: AppState;
  readonly start: (options?: StartOptions) => Promise<unknown>;
  readonly stop: (timeoutMs?: number) => Promise<void>;
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

function environmentSecret(options: AppOptions): string {
  const secret = options.channelSecret ?? process.env.LINE_CHANNEL_SECRET;
  if (typeof secret !== "string" || secret.trim().length === 0) return "";
  return secret;
}

async function defaultReadiness(options: AppOptions): Promise<ReadinessResult> {
  if (!options.database) return { ready: false, database: false, migrationVersion: null };
  const migration = await getMigrationStatus(options.database);
  return { ready: migration.ready, database: migration.ready, migrationVersion: migration.ready ? migration.latest : null };
}

function portOf(value: number | undefined): number {
  const port = value ?? Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer between 1 and 65535");
  return port;
}

/** Build the HTTP boundary around injected module ports. */
export function createApplication(options: AppOptions = {}): Application {
  const secret = environmentSecret(options);
  const ingest = options.webhook ?? options.ingest;
  const clock = options.clock ?? { now: () => new Date() };
  let current: AppState = "created";
  let server: { stop?: () => unknown | Promise<unknown> } | undefined;
  let activeRequests = 0;
  let closePromise: Promise<void> | undefined;
  let resolveDrained: (() => void) | undefined;
  const app = new Elysia();

  const requestStarted = (): void => { activeRequests += 1; };
  const requestFinished = (): void => {
    activeRequests = Math.max(activeRequests - 1, 0);
    if (activeRequests === 0) resolveDrained?.();
  };

  app.get("/health/live", () => current === "stopping" || current === "stopped"
    ? json({ status: "unavailable" }, 503)
    : json({ status: "ok" }));

  app.get("/health/ready", async () => {
    let readiness: ReadinessResult;
    try {
      readiness = await (options.readiness ?? (() => defaultReadiness(options)))();
    } catch {
      readiness = { ready: false, database: false, migrationVersion: null };
    }
    if (!readiness.ready) return json({ status: "not_ready", database: readiness.database === true, migrationVersion: readiness.migrationVersion ?? null }, 503);
    return json({ status: "ok", database: true, migrationVersion: readiness.migrationVersion ?? null });
  });

  app.post("/webhooks/line", async ({ request }) => {
    requestStarted();
    try {
      if (current === "stopping" || current === "stopped") return json({ error: "shutting_down" }, 503);
      const signature = request.headers.get("x-line-signature") ?? "";
      // Read exact bytes first: LINE signs the raw UTF-8 request body.
      const raw = await request.arrayBuffer();
      try {
        assertLineSignature(raw, signature, secret);
      } catch {
        return json({ error: "invalid_signature" }, 401);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return json({ error: "invalid_payload" }, 400);
      }
      let parsed: ReturnType<typeof parseWebhookPayload>;
      try {
        parsed = parseWebhookPayload(payload, clock.now());
      } catch {
        return json({ error: "invalid_payload" }, 400);
      }
      if (!ingest) return json({ error: "webhook_ingest_unavailable" }, 503);
      const results: WebhookIngestResult[] = [];
      try {
        for (const event of parsed.events) results.push(await ingest.handleVerifiedEvent(event));
      } catch {
        return json({ error: "ingest_failed" }, 503);
      }
      return json({ ok: true, events: results.length, ignoredEvents: parsed.ignoredEventCount });
    } finally {
      requestFinished();
    }
  });

  const waitForRequests = async (timeoutMs: number): Promise<void> => {
    if (activeRequests === 0) return;
    await new Promise<void>((resolve) => {
      resolveDrained = resolve;
      setTimeout(resolve, timeoutMs);
    });
    resolveDrained = undefined;
  };

  const application: Application = {
    app,
    get state() { return current; },
    async start(startOptions = {}): Promise<unknown> {
      if (current === "running") return server;
      if (current === "stopping" || current === "stopped") throw new Error("Application cannot be started after shutdown");
      current = "starting";
      const hostname = startOptions.hostname ?? process.env.HOST ?? "127.0.0.1";
      const port = portOf(startOptions.port);
      try {
        server = app.listen({ hostname, port });
        current = "running";
        options.jobRunner?.start();
        return server;
      } catch (error) {
        current = "stopped";
        throw error;
      }
    },
    async stop(timeoutMs = options.shutdownTimeoutMs ?? 5_000): Promise<void> {
      if (current === "stopped") return;
      current = "stopping";
      if (server?.stop) await server.stop();
      await waitForRequests(timeoutMs);
      await options.jobRunner?.stop(timeoutMs);
      if (!closePromise) closePromise = Promise.resolve(options.close?.()).then(() => undefined);
      await closePromise;
      current = "stopped";
    },
  };
  return application;
}

/** Backwards-compatible HTTP-only factory used by Bun's dev/build scripts. */
export function createApp(options: AppOptions = {}): Elysia {
  return createApplication(options).app;
}

/** Install signal handlers only for the executable entry point, never on import. */
export function installSignalHandlers(application: Application, exit: (code: number) => void = (code) => { process.exitCode = code; }): () => void {
  const handle = (signal: "SIGTERM" | "SIGINT") => {
    void application.stop().then(() => exit(0), () => exit(1));
    void signal;
  };
  process.once("SIGTERM", handle);
  process.once("SIGINT", handle);
  return () => {
    process.off("SIGTERM", handle);
    process.off("SIGINT", handle);
  };
}

type ResponseRow = {
  id: string;
  idempotency_key: string;
  group_id: string;
  source_message_id: string | null;
  state: "claimed" | "sent" | "unknown" | "suppressed" | "cancelled";
  reply_token: string | null;
  reply_token_received_at: Date | null;
  reply_token_expires_at: Date | null;
  claimed_at: Date | null;
  delivered_at: Date | null;
  suppression_reason: string | null;
  created_at: Date;
  updated_at: Date;
  response_id?: never;
};

function responseFromRow(row: ResponseRow) {
  return {
    responseId: row.id,
    idempotencyKey: row.idempotency_key,
    groupId: row.group_id,
    sourceMessageId: row.source_message_id,
    decisionId: null,
    state: row.state,
    claimedAt: row.claimed_at ? new Date(row.claimed_at) : null,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at) : null,
    suppressionReason: row.suppression_reason,
  } as const;
}

/** PostgreSQL-backed irreversible response claim (the at-most-once send gate). */
export function createDatabaseResponseClaimStore(db: Kysely<Database>): ResponseClaimStore {
  return {
    async claim(input) {
      return db.transaction().execute(async (trx) => {
        const responseId = input.responseId ?? crypto.randomUUID();
        const inserted = await trx.insertInto("bot_responses").values({
          id: responseId,
          group_id: input.groupId,
          idempotency_key: input.idempotencyKey,
          source_message_id: input.sourceMessageId ?? null,
          job_id: null,
          state: "claimed",
          reply_token: input.replyToken ?? null,
          reply_token_received_at: input.replyTokenReceivedAt ?? null,
          reply_token_expires_at: input.replyTokenExpiresAt ?? null,
          claimed_at: input.claimedAt,
          delivered_at: null,
          suppression_reason: null,
          created_at: input.claimedAt,
          updated_at: input.claimedAt,
        }).onConflict((oc) => oc.column("idempotency_key").doNothing()).returning("id").executeTakeFirst();
        const row = await trx.selectFrom("bot_responses").selectAll().where("idempotency_key", "=", input.idempotencyKey).executeTakeFirstOrThrow() as ResponseRow;
        const response = responseFromRow(row);
        return {
          claimed: inserted !== undefined,
          duplicate: inserted === undefined,
          response,
          ...(inserted ? { claimProof: createResponseClaimProof(input.idempotencyKey, response.responseId) } : {}),
        };
      });
    },
    async markSent(responseId, deliveredAt) {
      const row = await db.updateTable("bot_responses").set({ state: "sent", delivered_at: deliveredAt, updated_at: deliveredAt }).where("id", "=", responseId).returningAll().executeTakeFirstOrThrow() as ResponseRow;
      return responseFromRow(row);
    },
    async markUnknown(responseId, reason, at) {
      const row = await db.updateTable("bot_responses").set({ state: "unknown", suppression_reason: reason, updated_at: at }).where("id", "=", responseId).returningAll().executeTakeFirstOrThrow() as ResponseRow;
      return responseFromRow(row);
    },
    async markSuppressed(input, reason) {
      const responseId = input.responseId ?? crypto.randomUUID();
      const row = await db.insertInto("bot_responses").values({
        id: responseId,
        group_id: input.groupId,
        idempotency_key: input.idempotencyKey,
        source_message_id: input.sourceMessageId ?? null,
        job_id: null,
        state: "suppressed",
        reply_token: input.replyToken ?? null,
        reply_token_received_at: input.replyTokenReceivedAt ?? null,
        reply_token_expires_at: input.replyTokenExpiresAt ?? null,
        claimed_at: null,
        delivered_at: null,
        suppression_reason: reason,
        created_at: input.claimedAt,
        updated_at: input.claimedAt,
      }).onConflict((oc) => oc.column("idempotency_key").doNothing()).returningAll().executeTakeFirst();
      if (row) return responseFromRow(row as ResponseRow);
      return responseFromRow(await db.selectFrom("bot_responses").selectAll().where("idempotency_key", "=", input.idempotencyKey).executeTakeFirstOrThrow() as ResponseRow);
    },
  };
}

export function createTrackedReplyPort(
  delegate: LineReplyPort,
  claims: Pick<ResponseClaimStore, "markSent" | "markUnknown">,
  now: () => Date = () => new Date(),
): LineReplyPort {
  return {
    async reply(request) {
      const responseId = request.claimProof.responseId;
      try {
        await delegate.reply(request);
        if (responseId) await claims.markSent(responseId, now());
      } catch (error) {
        if (responseId) {
          await claims.markUnknown(
            responseId,
            error instanceof Error ? error.name || "transport_error" : "transport_error",
            now(),
          ).catch(() => undefined);
        }
        throw error;
      }
    },
  };
}

type MessageJobRow = {
  id: string;
  group_id: string;
  sender_member_id: string | null;
  line_message_id: string | null;
  message_type: string;
  text_content: string | null;
  media_metadata: unknown;
  line_quoted_message_id: string | null;
  sent_at: Date;
  received_at: Date;
  reply_token: string | null;
  reply_token_received_at: Date | null;
  reply_token_expires_at: Date | null;
};

function durableMentions(metadata: unknown): readonly { readonly isSelf?: boolean; readonly userId?: string }[] {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return [];
  const mentions = (metadata as { mentions?: unknown }).mentions;
  if (!Array.isArray(mentions)) return [];
  return mentions.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const mention = value as { isSelf?: unknown; userId?: unknown };
    if (typeof mention.isSelf !== "boolean") return [];
    return [{ isSelf: mention.isSelf, ...(typeof mention.userId === "string" ? { userId: mention.userId } : {}) }];
  });
}

/** Stable across worker restarts while still spreading candidates through the
 * configured delay window. */
export function ambientCandidateDueAt(
  receivedAt: Date,
  idempotencyKey: string,
  minDelayMs: number,
  maxDelayMs: number,
): Date {
  if (!Number.isSafeInteger(minDelayMs) || !Number.isSafeInteger(maxDelayMs) || minDelayMs < 0 || maxDelayMs < minDelayMs) {
    throw new TypeError("Invalid ambient delay range");
  }
  let hash = 2_166_136_261;
  for (const character of idempotencyKey) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const span = maxDelayMs - minDelayMs;
  const delay = minDelayMs + (span === 0 ? 0 : hash % (span + 1));
  return new Date(receivedAt.getTime() + delay);
}

async function loadMessageJob(db: Kysely<Database>, job: { sourceMessageId?: string; groupId: string }): Promise<MessageJobRow | null> {
  if (!job.sourceMessageId) return null;
  const row = await db.selectFrom("messages").select([
    "id", "group_id", "sender_member_id", "line_message_id", "message_type", "text_content", "media_metadata", "line_quoted_message_id", "sent_at", "received_at",
    "reply_token", "reply_token_received_at", "reply_token_expires_at",
  ]).where("group_id", "=", job.groupId).where("id", "=", job.sourceMessageId).executeTakeFirst();
  return row as MessageJobRow | undefined ?? null;
}

export interface ProductionApplicationOptions extends Omit<AppOptions, "channelSecret" | "webhook" | "database" | "jobRunner" | "close"> {
  readonly environment?: EnvironmentInput;
  readonly lineClient?: LineTransportClient;
  readonly aiClient?: AiClient;
  readonly close?: () => void | Promise<void>;
}

export interface ProductionComposition {
  readonly environment: Environment;
  readonly database: Kysely<Database>;
  readonly reply: LineReplyPort;
  readonly settings: SettingsService;
  readonly persona: PersonaService;
  readonly conversation: ConversationService;
  readonly decision: DecisionEngine;
  readonly command: CommandHandler;
  readonly lifecycle: LifecycleService;
  readonly ambient: AmbientPipeline;
  readonly jobRunner: JobRunner;
}

const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export function createScheduledRetentionRunner(
  runner: JobRunner,
  lifecycle: Pick<LifecycleService, "sweep">,
  policy: { readonly rawMessageRetentionDays: number; readonly contentLogRetentionDays: number; readonly personaDecayDays: number },
  intervalMs = RETENTION_SWEEP_INTERVAL_MS,
): JobRunner {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new TypeError("Retention sweep interval must be positive");
  let timer: ReturnType<typeof setInterval> | undefined;
  const sweep = (): void => {
    void lifecycle.sweep({ policy, now: new Date() }).catch(() => undefined);
  };
  return {
    get running() { return runner.running; },
    start() {
      runner.start();
      if (!timer) {
        sweep();
        timer = setInterval(sweep, intervalMs);
        timer.unref?.();
      }
    },
    runOnce: () => runner.runOnce(),
    async stop(timeoutMs) {
      if (timer) clearInterval(timer);
      timer = undefined;
      return runner.stop(timeoutMs);
    },
  };
}

function lineClientFromEnvironment(environment: Environment): LineTransportClient {
  // Keep SDK types outside the domain: the adapter receives only these two
  // provider-independent calls.
  return {
    reply: async (replyToken, messages) => {
      const { LineBotClient } = await import("@line/bot-sdk");
      const client = LineBotClient.fromChannelAccessToken({ channelAccessToken: environment.lineChannelAccessToken });
      return client.replyMessage({ replyToken, messages: messages as never });
    },
    profile: async (userId) => {
      const { LineBotClient } = await import("@line/bot-sdk");
      const client = LineBotClient.fromChannelAccessToken({ channelAccessToken: environment.lineChannelAccessToken });
      return client.getProfile(userId);
    },
  };
}

/** Full modular-monolith composition. All concrete wiring stays in `src/app`. */
export function createProductionApplication(options: ProductionApplicationOptions = {}): { readonly application: Application; readonly composition: ProductionComposition } {
  const environment = options.environment ? parseEnvironment(options.environment) : loadEnvironment();
  const { db } = createDatabase(environment.databaseUrl);
  const settingsRepository = createKyselySettingsRepository(db);
  const settings = createSettingsService(settingsRepository, { adminLineUserIds: environment.adminLineUserIds.map(String) });
  const lineClient = options.lineClient ?? lineClientFromEnvironment(environment);
  const reply = createReplyPort(lineClient);
  const aiClient = options.aiClient ?? createAiClient({
    transport: createOpenAIResponsesTransport(createOpenAIResponsesClient({ apiKey: environment.openAiApiKey })),
    model: environment.openAiModel,
  });
  const safety = new SafetyGate({ aiClient });
  const persona = createPersonaService(createPersonaRepository(db), { safetyGate: safety });
  const conversation = createConversationService(createConversationRepository(db));
  const decision = createDecisionEngine({ aiClient, safetyGate: safety, settings, repository: createDecisionRepository(db), model: environment.openAiModel, cooldownMs: environment.cooldownMin });
  const lifecycle = createDataLifecycleService(createRetentionRepository(db), { policyProvider: settings });
  const audit = createAuditEventPort(async (event) => {
    await db.insertInto("audit_events").values({
      id: crypto.randomUUID(), group_id: event.targetType === "group" ? event.targetId ?? null : null, actor_member_id: event.actorLineUserId,
      action: event.action, target_type: event.targetType ?? "unknown", target_id: event.targetId ?? null,
      metadata: (event.metadata ?? {}) as never, created_at: new Date(event.occurredAt),
    }).execute();
  });
  const command = createCommandHandler({ persona, settings, lifecycle: { forgetMe: async (input) => { await lifecycle.forgetMe(input); } }, audit });
  const claims = createDatabaseResponseClaimStore(db);
  const ambientReply = createTrackedReplyPort(reply, claims);
  const direct = createDirectPipeline({ reply, responseClaims: claims, decisionEngine: decision, safetyGate: safety, conversation, commandHandler: command, persona, replyTokenSafetyMarginMs: Number(environment.replyTokenSafetyMargin), telemetry: { emit: (event) => createLogger().emit(event) }, suppression: { record: async () => undefined } });
  const ambient = createAmbientPipeline({
    conversation,
    decision,
    reply: ambientReply,
    responseClaims: { claim: async (input) => { const result = await claims.claim({ ...input, claimedAt: input.now }); return result.claimProof ?? null; } },
    safety,
    suppression: {
      async record(suppression) {
        if (suppression.reason === "not_due" || suppression.reason === "duplicate_response" || suppression.reason === "transport_failure") return;
        const decisionId = typeof suppression.metadata?.decisionId === "string" ? suppression.metadata.decisionId : undefined;
        const safety = suppression.reason === "safety_blocked"
          ? "blocked"
          : suppression.reason === "safety_uncertain" || suppression.reason === "invalid_model_output"
            ? "uncertain"
            : "allowed";
        if (decisionId) {
          await db.updateTable("decision_records").set({
            respond: false,
            reason: suppression.reason,
            safety,
            suppression_reason: suppression.reason,
          }).where("id", "=", decisionId).execute();
          return;
        }
        await db.insertInto("decision_records").values({
          id: crypto.randomUUID(),
          group_id: suppression.groupId,
          source_message_id: suppression.sourceMessageId ?? null,
          episode_id: null,
          response_id: null,
          decision_type: "ambient",
          respond: false,
          reason: suppression.reason,
          interest_score: null,
          answered_by_human: suppression.reason === "human_answered" ? true : null,
          safety,
          draft: null,
          used_fact_ids: [],
          suppression_reason: suppression.reason,
          created_at: suppression.occurredAt,
        }).execute();
      },
    },
    candidateLoader: {
      async load(job) {
        const row = await loadMessageJob(db, job);
        if (!row) return null;
        const groupSettings = await settings.getGroupSettings(row.group_id);
        const minDelayMs = (groupSettings?.ambientMinDelaySeconds ?? Number(environment.ambientDelayMin) / 1_000) * 1_000;
        const maxDelayMs = (groupSettings?.ambientMaxDelaySeconds ?? Number(environment.ambientDelayMax) / 1_000) * 1_000;
        return {
          groupId: row.group_id,
          sourceMessageId: row.id,
          idempotencyKey: job.idempotencyKey,
          messageType: row.message_type,
          text: row.text_content,
          ...(row.reply_token ? { replyToken: row.reply_token } : {}),
          ...(row.reply_token_received_at ? { replyTokenReceivedAt: row.reply_token_received_at } : {}),
          receivedAt: row.received_at,
          eventAt: row.sent_at,
          dueAt: ambientCandidateDueAt(row.received_at, job.idempotencyKey, minDelayMs, maxDelayMs),
          relevantMessageIds: [row.id],
          ...(row.sender_member_id ? { senderMemberId: row.sender_member_id } : {}),
        };
      },
    },
  });

  const handlers = createJobHandlerRegistry();
  handlers.register("direct", async (job) => {
    const row = await loadMessageJob(db, job);
    if (!row) return "cancelled";
    const result = await direct.process({
      groupId: row.group_id,
      sourceMessageId: row.id,
      actorLineUserId: row.sender_member_id ?? undefined,
      jobId: job.id,
      idempotencyKey: job.idempotencyKey,
      text: row.text_content,
      messageType: row.message_type,
      mentions: durableMentions(row.media_metadata),
      quotedMessageId: row.line_quoted_message_id,
      ...(row.reply_token ? { replyToken: row.reply_token } : {}),
      ...(row.reply_token_received_at ? { replyTokenReceivedAt: row.reply_token_received_at } : {}),
      ...(row.reply_token_expires_at ? { replyTokenExpiresAt: row.reply_token_expires_at } : {}),
      receivedAt: row.received_at,
      eventAt: row.sent_at,
      now: new Date(),
    });
    return result.outcome === "unknown" || result.outcome === "sent" || result.outcome === "suppressed" || result.outcome === "duplicate" || result.outcome === "expired" ? "done" : "cancelled";
  });
  handlers.register("ambient_candidate", (job) => ambient.handleJob(job));
  handlers.register("join_transparency", async (job) => {
    const replyToken = typeof job.payload.replyToken === "string" ? job.payload.replyToken : undefined;
    const receivedAt = typeof job.payload.replyTokenReceivedAt === "string"
      ? new Date(job.payload.replyTokenReceivedAt)
      : job.dueAt;
    const expiresAt = typeof job.payload.replyTokenExpiresAt === "string"
      ? new Date(job.payload.replyTokenExpiresAt)
      : new Date(receivedAt.getTime() + 60_000);
    const now = new Date();
    if (!replyToken || Number.isNaN(receivedAt.getTime()) || Number.isNaN(expiresAt.getTime())) return "cancelled";
    const claimInput = {
      groupId: job.groupId,
      idempotencyKey: job.idempotencyKey,
      sourceMessageId: null,
      replyToken,
      replyTokenReceivedAt: receivedAt,
      replyTokenExpiresAt: expiresAt,
      claimedAt: now,
    } as const;
    if (now.getTime() - receivedAt.getTime() >= Number(environment.replyTokenSafetyMargin) || now >= expiresAt) {
      await claims.markSuppressed(claimInput, "stale_join_reply_token");
      return "expired";
    }
    const claimed = await claims.claim(claimInput);
    if (!claimed.claimed || !claimed.claimProof) return "done";
    try {
      await reply.reply({
        replyToken,
        claimProof: claimed.claimProof,
        messages: [{
          type: "text",
          text: "สวัสดี เราจะตอบแบบเลือกจังหวะและอาจจดจำข้อมูลทั่วไปจากบทสนทนา ใช้ @bot ฉันคือใคร, @bot ลืมฉัน หรือ @bot ไม่ต้องจำฉัน เพื่อดูและควบคุมความจำได้",
        }],
      });
      await claims.markSent(claimed.response.responseId, new Date());
    } catch (error) {
      await claims.markUnknown(
        claimed.response.responseId,
        error instanceof Error ? error.name || "join_transparency_transport_error" : "join_transparency_transport_error",
        new Date(),
      ).catch(() => undefined);
    }
    return "done";
  });
  handlers.register("unsend", async (job) => {
    const target = typeof job.payload.targetMessageId === "string" ? job.payload.targetMessageId : undefined;
    if (!target) return "cancelled";
    await lifecycle.unsend({ groupId: job.groupId, lineMessageId: target, occurredAt: new Date() });
    return "done";
  });
  handlers.register("persona_extract", async (job) => {
    const row = await loadMessageJob(db, job);
    if (!row?.text_content || !row.sender_member_id) return "cancelled";
    try {
      const extraction = await aiClient.structured({
        task: "persona_extraction",
        prompt: { message: row.text_content },
        schema: personaExtractionJsonSchema,
      });
      await persona.extractAndResolve({ groupId: row.group_id, extractorOutput: extraction.value, sourceMessageId: row.id, extractedByMemberId: row.sender_member_id, now: new Date() });
      return "done";
    } catch {
      // The AI client has its own bounded retry; a malformed extraction is
      // discarded rather than allowing a poison job to loop indefinitely.
      return "cancelled";
    }
  });
  const baseRunner = createJobRunner({ store: createJobStore(db), handlers, workerId: crypto.randomUUID(), pollIntervalMs: 1_000, batchSize: 10 });
  const runner = createScheduledRetentionRunner(baseRunner, lifecycle, {
    rawMessageRetentionDays: environment.rawMessageRetentionDays,
    contentLogRetentionDays: environment.contentLogRetentionDays,
    personaDecayDays: environment.personaDecayDays,
  });
  const ingest = createWebhookIngestHandler(createWebhookIngestRepository(db, {
    dailyTokenBudget: environment.dailyAiTokenBudget,
    ambientMinDelaySeconds: Number(environment.ambientDelayMin) / 1_000,
    ambientMaxDelaySeconds: Number(environment.ambientDelayMax) / 1_000,
    ambientCooldownSeconds: Number(environment.cooldownMin) / 1_000,
    rawMessageRetentionDays: environment.rawMessageRetentionDays,
    contentLogRetentionDays: environment.contentLogRetentionDays,
    personaDecayDays: environment.personaDecayDays,
  }));
  const application = createApplication({ ...options, channelSecret: environment.lineChannelSecret, webhook: ingest, database: db, jobRunner: runner, close: async () => { await db.destroy(); await options.close?.(); } });
  return { application, composition: { environment, database: db, reply, settings, persona, conversation, decision, command, lifecycle, ambient, jobRunner: runner } };
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const hasProductionEnvironment = [
    "LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "OPENAI_API_KEY", "DATABASE_URL", "ADMIN_LINE_USER_IDS",
  ].every((key) => typeof process.env[key] === "string" && process.env[key]!.trim().length > 0);
  const application = hasProductionEnvironment
    ? createProductionApplication().application
    : createApplication({ channelSecret: process.env.LINE_CHANNEL_SECRET });
  installSignalHandlers(application);
  void application.start().catch((error) => {
    console.error(error instanceof Error ? error.message : "Application failed to start");
    process.exitCode = 1;
  });
}

export type { LineEvent, LineReplyPort, LineTransportClient };
