import {
  createResponseClaimProof,
  type LineMessageEvent,
  type LineReplyMessage,
} from "../line-adapter/index.ts";
import { parseCommand, type CommandParseResult, type ParsedCommand } from "../command-service/index.ts";
import type { ConversationContext } from "../conversation-service/index.ts";
import type { DecisionResult } from "../decision-engine/index.ts";
import {
  noOpTransaction,
  systemClock,
  type Clock,
  type TransactionBoundary,
} from "../../shared/index.ts";
import type {
  DirectPipelineInput,
  DirectPipelineOptions,
  DirectPipelineResult,
  ResponseClaimResult,
  ResponseClaimStore,
  ResponseClaimInput,
} from "./types.ts";
import { DEFAULT_REPLY_TOKEN_SAFETY_MARGIN_MS } from "./types.ts";

const DEFAULT_TEXT_LIMIT = 5_000;
const DEFAULT_NEUTRAL_RESPONSE = "ขอเลือกตอบแบบปลอดภัยก่อนนะ";

interface NormalizedInput {
  readonly groupId: string;
  readonly sourceMessageId: string | null;
  readonly eventId: string | undefined;
  readonly jobId: string | undefined;
  readonly idempotencyKey: string;
  readonly actorLineUserId: string | undefined;
  readonly text: string;
  readonly messageType: string;
  readonly mentions: readonly { readonly isSelf?: boolean; readonly userId?: string }[];
  readonly quotedMessageId: string | null;
  readonly replyToken: string | null;
  readonly replyTokenReceivedAt: Date | null;
  readonly replyTokenExpiresAt: Date | null;
  readonly receivedAt: Date | null;
  readonly eventAt: Date | null;
  readonly episodeId: string | undefined;
  readonly now: Date;
}

function date(value: Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const result = new Date(value.getTime());
  if (Number.isNaN(result.getTime())) throw new TypeError("Timestamp must be valid");
  return result;
}
function required(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) throw new TypeError(`${field} must be a non-empty trimmed string`);
  return value;
}
function eventMessage(event: LineMessageEvent | undefined): LineMessageEvent["message"] | undefined { return event?.message; }
function normalize(input: DirectPipelineInput, now: Date): NormalizedInput {
  const event = input.event;
  const message = eventMessage(event);
  const groupId = required(input.groupId ?? (event?.source.groupId ? String(event.source.groupId) : undefined), "groupId");
  const sourceMessageId = input.sourceMessageId ?? (message ? String(message.id) : null);
  const eventId = input.eventId ?? (event ? String(event.webhookEventId) : undefined);
  const idempotencyKey = input.idempotencyKey ?? (sourceMessageId ? `${groupId}:direct:${sourceMessageId}` : eventId ? `${groupId}:direct:event:${eventId}` : undefined);
  if (!idempotencyKey) throw new TypeError("Direct invocation requires an idempotency key or source message");
  const eventText = message?.type === "text" ? message.text : "";
  const text = input.text ?? eventText;
  if (text !== null && typeof text !== "string") throw new TypeError("Direct text must be a string or null");
  return {
    groupId, sourceMessageId, eventId, jobId: input.jobId, idempotencyKey,
    actorLineUserId: input.actorLineUserId ?? (event?.source.userId ? String(event.source.userId) : undefined),
    text: text ?? "", messageType: input.messageType ?? message?.type ?? "text",
    mentions: input.mentions ?? (message?.type === "text" ? message.mentions.map((mention) => ({ isSelf: mention.isSelf, ...(mention.userId ? { userId: String(mention.userId) } : {}) })) : []),
    quotedMessageId: input.quotedMessageId ?? (message?.quotedMessageId ? String(message.quotedMessageId) : null),
    replyToken: input.replyToken ?? event?.replyToken ?? null,
    replyTokenReceivedAt: date(input.replyTokenReceivedAt ?? input.receivedAt ?? event?.receivedAt),
    replyTokenExpiresAt: date(input.replyTokenExpiresAt), receivedAt: date(input.receivedAt ?? event?.receivedAt), eventAt: date(input.eventAt ?? event?.eventAt), episodeId: input.episodeId, now,
  };
}
function commandInput(value: NormalizedInput): { readonly text: string; readonly actorUserId: string; readonly mentions: readonly { readonly isSelf: boolean }[]; readonly botMentioned: boolean } | null {
  if (!value.actorLineUserId) return null;
  return { text: value.text, actorUserId: value.actorLineUserId, mentions: value.mentions.map((mention) => ({ isSelf: mention.isSelf === true })), botMentioned: value.mentions.some((mention) => mention.isSelf === true) };
}
function keyError(error: unknown): string { return error instanceof Error && error.name ? error.name : "pipeline_error"; }
function sendMessage(text: string): readonly LineReplyMessage[] { return [{ type: "text", text: text.slice(0, DEFAULT_TEXT_LIMIT) }]; }
function tokenExpired(value: NormalizedInput, at: Date, margin: number): boolean {
  const age = value.replyTokenReceivedAt ? Math.max(0, at.getTime() - value.replyTokenReceivedAt.getTime()) : 0;
  return Boolean(value.replyTokenExpiresAt && at.getTime() >= value.replyTokenExpiresAt.getTime()) || age >= margin;
}
function richClaims(value: DirectPipelineOptions["responseClaims"]): value is ResponseClaimStore {
  return "markSent" in value && "markUnknown" in value && "markSuppressed" in value;
}

export function createDirectPipeline(options: DirectPipelineOptions) {
  const clock: Clock = options.clock ?? systemClock;
  const transaction: TransactionBoundary = options.transaction ?? noOpTransaction;
  const margin = options.replyTokenSafetyMarginMs ?? options.replyTokenMaxAgeMs ?? DEFAULT_REPLY_TOKEN_SAFETY_MARGIN_MS;
  const decisionEngine = options.decisionEngine ?? options.decision;
  if (!decisionEngine) throw new TypeError("Decision engine is required");
  const safetyGate = options.safetyGate ?? options.safety;
  const claims = options.responseClaims;
  if (!Number.isSafeInteger(margin) || margin <= 0) throw new TypeError("Reply token safety margin must be a positive integer");

  const emit = (event: Parameters<NonNullable<DirectPipelineOptions["telemetry"]>["emit"]>[0]): void => {
    try { options.telemetry?.emit(event); } catch { /* telemetry cannot cause a second reply */ }
  };
  const finish = (result: Omit<DirectPipelineResult, "latencyMs">, startedAt: Date): DirectPipelineResult => {
    const endedAt = date(clock.now()) ?? startedAt;
    const latencyMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
    emit({ event: "latency", operation: "direct_pipeline", durationMs: latencyMs, success: result.outcome === "sent", correlation: { responseId: result.responseId, webhookId: result.idempotencyKey } });
    return { ...result, latencyMs };
  };
  const claimInput = (value: NormalizedInput, decisionId: string | null): ResponseClaimInput => ({
    idempotencyKey: value.idempotencyKey, groupId: value.groupId, sourceMessageId: value.sourceMessageId,
    decisionId, replyToken: value.replyToken, replyTokenReceivedAt: value.replyTokenReceivedAt, replyTokenExpiresAt: value.replyTokenExpiresAt, claimedAt: value.now,
  });
  const suppressClaim = async (value: NormalizedInput, reason: string, decisionId: string | null): Promise<{ readonly responseId: string }> => {
    if (richClaims(claims)) return claims.markSuppressed(claimInput(value, decisionId), reason);
    return { responseId: `response:${value.idempotencyKey}` };
  };
  const claimResponse = async (value: NormalizedInput, decisionId: string | null): Promise<ResponseClaimResult> => {
    if (richClaims(claims)) return transaction.run(() => claims.claim(claimInput(value, decisionId)));
    const proof = await transaction.run(() => claims.claim({ idempotencyKey: value.idempotencyKey, groupId: value.groupId, sourceMessageId: value.sourceMessageId ?? "", decisionId, now: value.now }));
    const responseId = proof?.responseId ?? `response:${value.idempotencyKey}`;
    return proof
      ? { claimed: true, duplicate: false, response: { responseId, idempotencyKey: value.idempotencyKey, groupId: value.groupId, sourceMessageId: value.sourceMessageId, decisionId, state: "claimed", claimedAt: value.now, deliveredAt: null, suppressionReason: null }, claimProof: proof }
      : { claimed: false, duplicate: true, response: { responseId, idempotencyKey: value.idempotencyKey, groupId: value.groupId, sourceMessageId: value.sourceMessageId, decisionId, state: "claimed", claimedAt: null, deliveredAt: null, suppressionReason: null } };
  };
  const suppressed = async (value: NormalizedInput, reason: string, startedAt: Date, extras: Partial<Omit<DirectPipelineResult, "outcome" | "idempotencyKey" | "latencyMs" | "retry">> = {}): Promise<DirectPipelineResult> => {
    const response = await suppressClaim(value, reason, extras.decision?.id ?? null);
    try { await options.suppression?.record({ groupId: value.groupId, ...(value.sourceMessageId ? { sourceMessageId: value.sourceMessageId } : {}), reason, occurredAt: value.now, ...(extras.decision ? { metadata: { decisionId: extras.decision.id } } : {}) }); } catch { /* suppression telemetry is best effort */ }
    emit({ event: "decision_outcome", outcome: "suppress", path: "direct", correlation: { responseId: response.responseId } });
    emit({ event: "suppression_reason", reason, path: "direct", correlation: { responseId: response.responseId } });
    return finish({ outcome: "suppressed", idempotencyKey: value.idempotencyKey, responseId: response.responseId, retry: false, ...extras }, startedAt);
  };
  const expired = async (value: NormalizedInput, startedAt: Date): Promise<DirectPipelineResult> => {
    const response = await suppressClaim(value, "stale_reply_token", null);
    try { await options.suppression?.record({ groupId: value.groupId, ...(value.sourceMessageId ? { sourceMessageId: value.sourceMessageId } : {}), reason: "stale_reply_token", occurredAt: value.now }); } catch { /* best effort */ }
    emit({ event: "decision_outcome", outcome: "cancel", path: "direct", correlation: { responseId: response.responseId } });
    emit({ event: "suppression_reason", reason: "stale_reply_token", path: "direct", correlation: { responseId: response.responseId } });
    return finish({ outcome: "expired", idempotencyKey: value.idempotencyKey, responseId: response.responseId, retry: false }, startedAt);
  };

  const process = async (input: DirectPipelineInput): Promise<DirectPipelineResult> => {
    const startedAt = date(input.now) ?? date(clock.now()) as Date;
    const value = normalize(input, startedAt);
    const ageMs = value.replyTokenReceivedAt ? Math.max(0, value.now.getTime() - value.replyTokenReceivedAt.getTime()) : 0;
    const initialExpired = Boolean(value.replyTokenExpiresAt && value.now.getTime() >= value.replyTokenExpiresAt.getTime()) || ageMs >= margin;
    if (value.replyTokenReceivedAt || value.replyTokenExpiresAt) emit({ event: "reply_token_age", ageMs, expired: initialExpired, correlation: { webhookId: value.eventId } });
    if (!value.replyToken) return suppressed(value, "missing_reply_token", startedAt);
    if (initialExpired || tokenExpired(value, value.now, margin)) return expired(value, startedAt);

    let command: ParsedCommand | undefined = input.command;
    let parsed: CommandParseResult | undefined = input.parsedCommand;
    if (!command && !parsed && commandInput(value)) parsed = (options.commandParser ?? parseCommand)(commandInput(value)!);
    if (!command && parsed?.kind === "command") command = parsed;
    if (command) {
      if (!options.commandHandler) return suppressed(value, "command_handler_unavailable", startedAt);
      const commandResult = await options.commandHandler.handle(command, { groupId: value.groupId, eventId: value.eventId, now: value.now });
      const beforeClaim = date(clock.now()) ?? value.now;
      if (tokenExpired(value, beforeClaim, margin)) return expired({ ...value, now: beforeClaim }, startedAt);
      const claimValue = { ...value, now: beforeClaim };
      const claim = await claimResponse(claimValue, null);
      if (claim.duplicate || !claim.claimed || !claim.claimProof) {
        emit({ event: "duplicate_response", idempotencyKey: value.idempotencyKey, duplicate: true, correlation: { responseId: claim.response.responseId } });
        return finish({ outcome: "duplicate", idempotencyKey: value.idempotencyKey, responseId: claim.response.responseId, retry: false, command: commandResult }, startedAt);
      }
      return sendClaimed(claimValue, claim.response.responseId, claim.claimProof, commandResult.message || commandResult.text, undefined, startedAt);
    }

    let context: ConversationContext | undefined;
    let rendered: ReturnType<NonNullable<DirectPipelineOptions["conversation"]>["renderContext"]> | undefined;
    if (options.conversation) {
      context = await options.conversation.buildContext({ groupId: value.groupId, ...(value.sourceMessageId ? { anchorMessageId: value.sourceMessageId } : { anchorAt: value.eventAt ?? value.now }), ...(value.episodeId ? { episodeId: value.episodeId } : {}) });
      rendered = options.conversation.renderContext(context);
    }
    const facts = input.facts ?? (options.persona ? await options.persona.getFacts({ groupId: value.groupId, includeRisky: false }) : []);
    const decision = await decisionEngine.decide({ ...(input.decisionInput ?? {}), groupId: value.groupId, decisionType: "direct", sourceMessageId: value.sourceMessageId ?? undefined, now: value.now, text: value.text, messageType: value.messageType, mentions: value.mentions, quotedMessageId: value.quotedMessageId, facts, context: input.context ?? rendered, authorized: input.authorized });
    if (!decision.respond || !decision.draft) return suppressed(value, decision.suppressionReason ?? "decision_suppressed", startedAt, { decision, context: rendered });
    let draft = decision.draft;
    if (decision.safety !== "allowed") {
      const neutral = safetyGate
        ? await safetyGate.evaluate({ draft: options.neutralResponse?.trim() || DEFAULT_NEUTRAL_RESPONSE, path: "direct", facts: [] })
        : undefined;
      draft = neutral?.response ?? neutral?.neutralResponse ?? options.neutralResponse?.trim() ?? DEFAULT_NEUTRAL_RESPONSE;
    }
    const beforeClaim = date(clock.now()) ?? value.now;
    if (tokenExpired(value, beforeClaim, margin)) return expired({ ...value, now: beforeClaim }, startedAt);
    const claimValue = { ...value, now: beforeClaim };
    const claim = await claimResponse(claimValue, decision.id);
    if (claim.duplicate || !claim.claimed || !claim.claimProof) {
      emit({ event: "duplicate_response", idempotencyKey: value.idempotencyKey, duplicate: true, correlation: { responseId: claim.response.responseId, decisionId: decision.id } });
      return finish({ outcome: "duplicate", idempotencyKey: value.idempotencyKey, responseId: claim.response.responseId, retry: false, decision, context: rendered }, startedAt);
    }
    return sendClaimed(claimValue, claim.response.responseId, claim.claimProof, draft, decision, startedAt);
  };

  const sendClaimed = async (value: NormalizedInput, responseId: string, claimProof: ReturnType<typeof createResponseClaimProof>, text: string, decision: DecisionResult | undefined, startedAt: Date): Promise<DirectPipelineResult> => {
    try {
      await options.reply.reply({ replyToken: value.replyToken as string, messages: sendMessage(text), claimProof });
    } catch (error) {
      if (richClaims(claims)) { try { await claims.markUnknown(responseId, keyError(error), value.now); } catch { /* claim remains irreversible */ } }
      emit({ event: "decision_outcome", outcome: "uncertain", path: "direct", correlation: { responseId, ...(decision ? { decisionId: decision.id } : {}) } });
      return finish({ outcome: "unknown", idempotencyKey: value.idempotencyKey, responseId, retry: false, ...(decision ? { decision } : {}) }, startedAt);
    }
    if (richClaims(claims)) try { await claims.markSent(responseId, value.now); } catch {
      try { await claims.markUnknown(responseId, "claim_state_update_failed", value.now); } catch { /* no automatic retry */ }
      return finish({ outcome: "unknown", idempotencyKey: value.idempotencyKey, responseId, retry: false, ...(decision ? { decision } : {}) }, startedAt);
    }
    emit({ event: "decision_outcome", outcome: "respond", path: "direct", correlation: { responseId, ...(decision ? { decisionId: decision.id } : {}) } });
    return finish({ outcome: "sent", idempotencyKey: value.idempotencyKey, responseId, message: text, retry: false, ...(decision ? { decision } : {}) }, startedAt);
  };

  return { process, handle: process, execute: process };
}

export const createDirectInvocationPipeline = createDirectPipeline;

