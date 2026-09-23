import type { LineReplyMessage } from "../line-adapter/index.ts";
import type { DecisionResult } from "../decision-engine/index.ts";
import type { ClaimedJob, JobHandlerResult } from "../job-runner/index.ts";
import {
  AMBIENT_MAX_DELAY_MS,
  AMBIENT_MIN_DELAY_MS,
  AMBIENT_REPLY_TOKEN_MAX_AGE_MS,
  type AmbientCandidate,
  type AmbientCandidateInput,
  type AmbientCandidateResult,
  type AmbientClock,
  type AmbientPipeline,
  type AmbientPipelineDependencies,
  type AmbientProcessResult,
  type AmbientSuppressionReason,
} from "./types.ts";

const systemClock: AmbientClock = { now: () => new Date() };
const systemRandom = { next: () => Math.random() };

function copyDate(value: Date): Date { return new Date(value.getTime()); }
function validDate(value: Date, field: string): Date {
  const result = new Date(value.getTime());
  if (Number.isNaN(result.getTime())) throw new TypeError(`${field} must be a valid Date`);
  return result;
}
function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) throw new TypeError(`${field} must be a non-empty trimmed string`);
  return value;
}
function randomDelay(random: { next(): number }, min: number, max: number): number {
  const value = random.next();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new TypeError("Random source must return a value in [0, 1)");
  return min + Math.floor(value * (max - min + 1));
}
function normalizeText(value: string): string { return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase(); }
function lowSignal(text: string): boolean {
  const normalized = normalizeText(text).replace(/[\s.!?,。！？]+/gu, "");
  if (!normalized) return true;
  return /^(?:5{3,}|555+|ฮ่า+|ha+|lol+|ok(?:ay)?|k|kk|thanks?|thx|gotit|รับทราบ|โอเค|ตกลง|ครับ|ค่ะ|จ้า|ได้เลย|ขอบคุณ)$/iu.test(normalized);
}
function asReason(value: string | null | undefined): AmbientSuppressionReason | undefined {
  const reasons: readonly AmbientSuppressionReason[] = [
    "non_text", "sticker_only", "low_signal", "duplicate", "muted", "inactive_group", "ambient_disabled",
    "cooldown", "ambient_rate_limit", "daily_budget_exhausted", "human_answered", "stale_context",
    "model_declined", "safety_blocked", "safety_uncertain", "model_failure", "invalid_model_output",
    "missing_settings", "stale_reply_token", "duplicate_response", "transport_failure", "missing_reply_token", "not_due", "invalid_candidate",
  ];
  return value && reasons.includes(value as AmbientSuppressionReason) ? value as AmbientSuppressionReason : undefined;
}
function candidateCopy(candidate: AmbientCandidate): AmbientCandidate {
  return {
    ...candidate,
    receivedAt: copyDate(candidate.receivedAt),
    ...(candidate.replyTokenReceivedAt ? { replyTokenReceivedAt: copyDate(candidate.replyTokenReceivedAt) } : {}),
    ...(candidate.eventAt ? { eventAt: copyDate(candidate.eventAt) } : {}),
    dueAt: copyDate(candidate.dueAt),
    relevantMessageIds: candidate.relevantMessageIds ? [...candidate.relevantMessageIds] : undefined,
    facts: candidate.facts ? candidate.facts.map((fact) => ({ ...fact })) : undefined,
  };
}
function messageFor(candidate: AmbientCandidate): { id: string; type: string; text: string | null; authorKind: "human" } {
  return { id: candidate.sourceMessageId, type: candidate.messageType, text: candidate.text ?? null, authorKind: "human" };
}
function suppressionResult(reason: AmbientSuppressionReason): AmbientProcessResult {
  return { outcome: "suppressed", reason };
}

export function createAmbientPipeline(dependencies: AmbientPipelineDependencies): AmbientPipeline {
  const clock = dependencies.clock ?? systemClock;
  const random = dependencies.random ?? systemRandom;
  const maxAge = dependencies.replyTokenMaxAgeMs ?? AMBIENT_REPLY_TOKEN_MAX_AGE_MS;
  const minDelay = dependencies.minDelayMs ?? AMBIENT_MIN_DELAY_MS;
  const maxDelay = dependencies.maxDelayMs ?? AMBIENT_MAX_DELAY_MS;
  if (!Number.isSafeInteger(minDelay) || !Number.isSafeInteger(maxDelay) || minDelay < AMBIENT_MIN_DELAY_MS || maxDelay > AMBIENT_MAX_DELAY_MS || maxDelay < minDelay) throw new TypeError("Ambient delay must be within 15-30 seconds");
  if (!Number.isSafeInteger(maxAge) || maxAge <= 0) throw new TypeError("replyTokenMaxAgeMs must be a positive integer");

  async function suppress(candidate: AmbientCandidate | AmbientCandidateInput, reason: AmbientSuppressionReason, metadata?: Readonly<Record<string, unknown>>): Promise<AmbientProcessResult> {
    await dependencies.suppression?.record({ groupId: candidate.groupId, sourceMessageId: candidate.sourceMessageId, reason, occurredAt: copyDate(clock.now()), metadata });
    return suppressionResult(reason);
  }

  async function createCandidate(input: AmbientCandidateInput): Promise<AmbientCandidateResult> {
    try {
      required(input.groupId, "groupId"); required(input.sourceMessageId, "sourceMessageId");
      const receivedAt = validDate(input.receivedAt, "receivedAt");
      if (input.messageType === "sticker") { await dependencies.suppression?.record({ groupId: input.groupId, sourceMessageId: input.sourceMessageId, reason: "sticker_only", occurredAt: copyDate(clock.now()) }); return { scheduled: false, suppressionReason: "sticker_only" }; }
      if (input.messageType !== "text") { await dependencies.suppression?.record({ groupId: input.groupId, sourceMessageId: input.sourceMessageId, reason: "non_text", occurredAt: copyDate(clock.now()) }); return { scheduled: false, suppressionReason: "non_text" }; }
      if (lowSignal(input.text ?? "")) { await dependencies.suppression?.record({ groupId: input.groupId, sourceMessageId: input.sourceMessageId, reason: "low_signal", occurredAt: copyDate(clock.now()) }); return { scheduled: false, suppressionReason: "low_signal" }; }
      if (input.duplicate) { await dependencies.suppression?.record({ groupId: input.groupId, sourceMessageId: input.sourceMessageId, reason: "duplicate", occurredAt: copyDate(clock.now()) }); return { scheduled: false, suppressionReason: "duplicate" }; }
      const idempotencyKey = input.idempotencyKey ?? `${input.eventId ?? input.sourceMessageId}:ambient_candidate`;
      required(idempotencyKey, "idempotencyKey");
      const delay = randomDelay(random, minDelay, maxDelay);
      const candidate: AmbientCandidate = {
        ...input,
        idempotencyKey,
        receivedAt,
        dueAt: new Date(receivedAt.getTime() + delay),
        ...(input.replyTokenReceivedAt ? { replyTokenReceivedAt: validDate(input.replyTokenReceivedAt, "replyTokenReceivedAt") } : {}),
        ...(input.eventAt ? { eventAt: validDate(input.eventAt, "eventAt") } : {}),
        relevantMessageIds: [...(input.relevantMessageIds ?? [input.sourceMessageId])],
      };
      await dependencies.schedule?.schedule(candidateCopy(candidate));
      return { scheduled: true, candidate: candidateCopy(candidate) };
    } catch {
      return { scheduled: false, suppressionReason: "invalid_candidate" };
    }
  }

  async function process(candidateInput: AmbientCandidate): Promise<AmbientProcessResult> {
    const candidate = candidateCopy(candidateInput);
    const now = validDate(clock.now(), "now");
    if (now.getTime() < candidate.dueAt.getTime()) return suppress(candidate, "not_due");
    if (!candidate.replyToken) return suppress(candidate, "missing_reply_token");
    const tokenReceivedAt = candidate.replyTokenReceivedAt ?? candidate.receivedAt;
    if (now.getTime() - tokenReceivedAt.getTime() > maxAge) return suppress(candidate, "stale_reply_token");

    let context;
    let analysis;
    try {
      context = await dependencies.conversation.buildContext({ groupId: candidate.groupId, anchorMessageId: candidate.sourceMessageId, anchorAt: candidate.eventAt ?? candidate.receivedAt, episodeId: candidate.episodeId });
      analysis = await dependencies.conversation.evaluateCandidate({ groupId: candidate.groupId, candidateMessageId: candidate.sourceMessageId, relevantMessageIds: candidate.relevantMessageIds ?? [candidate.sourceMessageId], asOf: now });
    } catch {
      return suppress(candidate, "stale_context");
    }
    if (analysis.answeredByHuman) return suppress(candidate, "human_answered", { answeringMessageIds: analysis.answeringMessageIds });
    if (analysis.staleContext) return suppress(candidate, "stale_context", { staleMessageIds: analysis.staleMessageIds });

    let decision: DecisionResult;
    try {
      const rendered = dependencies.conversation.renderContext(context);
      decision = await dependencies.decision.decide({
        groupId: candidate.groupId,
        path: "ambient",
        decisionType: "ambient",
        sourceMessageId: candidate.sourceMessageId,
        episodeId: context.episodeId,
        message: messageFor(candidate),
        text: candidate.text ?? null,
        messageType: candidate.messageType,
        context: candidate.context ?? rendered,
        facts: candidate.facts ?? [],
        answeredByHuman: analysis.answeredByHuman,
        staleContext: analysis.staleContext,
        now,
      });
    } catch {
      return suppress(candidate, "model_failure");
    }
    if (!decision.respond) return suppress(candidate, asReason(decision.suppressionReason) ?? "model_declined", { decisionId: decision.id });
    if (!decision.draft || decision.safety !== "allowed") return suppress(candidate, decision.safety === "blocked" ? "safety_blocked" : decision.safety === "uncertain" ? "safety_uncertain" : "invalid_model_output", { decisionId: decision.id });

    let safety = decision.safetyResult;
    if (dependencies.safety) {
      const usedFactIds = new Set(decision.usedFactIds);
      const factMetadata = (candidate.facts ?? [])
        .filter((fact) => usedFactIds.has(fact.id))
        .map((fact) => ({ id: fact.id, visibility: fact.visibility, category: fact.category }));
      try { safety = await dependencies.safety.evaluate({ draft: decision.draft, path: "ambient", facts: factMetadata }); }
      catch { return suppress(candidate, "safety_uncertain", { decisionId: decision.id }); }
      if (safety.status !== "allowed") return suppress(candidate, safety.status === "blocked" ? "safety_blocked" : "safety_uncertain", { decisionId: decision.id });
    }

    // Recheck token age immediately before the irreversible claim/send sequence.
    const beforeClaim = validDate(clock.now(), "now");
    if (beforeClaim.getTime() - tokenReceivedAt.getTime() > maxAge) return suppress(candidate, "stale_reply_token");
    let proof;
    try {
      proof = await dependencies.responseClaims.claim({ idempotencyKey: candidate.idempotencyKey, groupId: candidate.groupId, sourceMessageId: candidate.sourceMessageId, now: beforeClaim });
    } catch {
      return suppress(candidate, "transport_failure", { stage: "response_claim" });
    }
    if (!proof) return suppress(candidate, "duplicate_response");
    try {
      const messages: readonly LineReplyMessage[] = [{ type: "text", text: safety?.response ?? decision.draft }];
      await dependencies.reply.reply({ replyToken: candidate.replyToken, messages, claimProof: proof });
      return { outcome: "sent", decision, safety };
    } catch {
      // The claim has already happened; transport uncertainty must never retry.
      await dependencies.suppression?.record({ groupId: candidate.groupId, sourceMessageId: candidate.sourceMessageId, reason: "transport_failure", occurredAt: copyDate(clock.now()), metadata: { stage: "reply_after_claim" } });
      return { outcome: "unknown", reason: "transport_failure", decision, safety };
    }
  }

  async function handleJob(job: ClaimedJob): Promise<JobHandlerResult> {
    if (job.jobType !== "ambient_candidate") return { outcome: "cancelled", reason: "invalid_candidate" };
    const loaded = await dependencies.candidateLoader?.load(job);
    if (loaded) {
      const result = await process(loaded);
      if (result.reason === "not_due") return { outcome: "retry", delayMs: Math.max(loaded.dueAt.getTime() - clock.now().getTime(), 1), reason: "not_due" };
      return result.outcome === "unknown" || result.outcome === "sent" ? "done" : "cancelled";
    }
    const payload = job.payload;
    const sourceMessageId = typeof payload.sourceMessageId === "string" ? payload.sourceMessageId : job.sourceMessageId;
    if (!sourceMessageId) { await suppress({ groupId: job.groupId, sourceMessageId: "unknown", receivedAt: job.dueAt, messageType: "text" }, "invalid_candidate"); return "cancelled"; }
    const dateFromPayload = (value: unknown, fallback: Date): Date => value instanceof Date ? copyDate(value) : typeof value === "string" ? new Date(value) : copyDate(fallback);
    const input: AmbientCandidate = {
      groupId: job.groupId,
      sourceMessageId,
      idempotencyKey: job.idempotencyKey,
      messageType: typeof payload.messageType === "string" ? payload.messageType : "text",
      text: typeof payload.text === "string" ? payload.text : null,
      replyToken: typeof payload.replyToken === "string" ? payload.replyToken : undefined,
      receivedAt: dateFromPayload(payload.receivedAt, job.dueAt),
      replyTokenReceivedAt: payload.replyTokenReceivedAt === undefined ? undefined : dateFromPayload(payload.replyTokenReceivedAt, job.dueAt),
      eventAt: payload.eventAt === undefined ? undefined : dateFromPayload(payload.eventAt, job.dueAt),
      relevantMessageIds: Array.isArray(payload.relevantMessageIds) ? payload.relevantMessageIds.filter((value): value is string => typeof value === "string") : [sourceMessageId],
      facts: Array.isArray(payload.facts) ? payload.facts as never : [],
      episodeId: typeof job.episodeId === "string" ? job.episodeId : undefined,
      dueAt: dateFromPayload(payload.dueAt, job.dueAt),
    };
    const result = await process(input);
    if (result.reason === "not_due") return { outcome: "retry", delayMs: Math.max(input.dueAt.getTime() - clock.now().getTime(), 1), reason: "not_due" };
    return result.outcome === "unknown" ? "done" : result.outcome === "sent" ? "done" : "cancelled";
  }

  return { createCandidate, process, handleJob };
}

export const createAmbientCandidatePipeline = createAmbientPipeline;
export const createAmbientService = createAmbientPipeline;
