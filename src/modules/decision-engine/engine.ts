import { AiClientError, type AiUsage, type BilledUsage } from "../ai-client/index.ts";
import { isGroupMuted } from "../settings/index.ts";
import type { SafetyFactMetadata, SafetyGateInput, SafetyGateResult } from "../safety-gate/index.ts";
import { systemClock, type Clock } from "../../shared/index.ts";
import {
  DECISION_SCHEMA,
  isDirectInvocation,
  messageText,
  messageType,
  type DecisionEngineOptions,
  type DecisionFact,
  type DecisionRecord,
  type DecisionRepository,
  type DecisionRequest,
  type DecisionResult,
  type DecisionSafety,
  type ModelDecision,
  type SuppressionReason,
} from "./types.ts";
import { createInMemoryDecisionRepository } from "./in-memory.ts";

const DEFAULT_MODEL = "gpt-5-nano";
const DEFAULT_COOLDOWN_MS = 3 * 60_000;
const DEFAULT_AMBIENT_WINDOW_MESSAGES = 10;
const DEFAULT_NEUTRAL_RESPONSE = "ขอเลือกตอบแบบปลอดภัยก่อนนะ";

function copyDate(date: Date): Date { return new Date(date.getTime()); }
function validDate(value: Date | undefined, fallback: Date): Date {
  const date = value ?? fallback;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError("Decision time must be a valid Date");
  return copyDate(date);
}
function requiredId(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) throw new TypeError(`${field} must be a non-empty trimmed string`);
  return value;
}
function finiteInteger(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError("Message counts must be non-negative integers");
  return result;
}
function normalize(value: string): string { return value.trim().normalize("NFKC").toLocaleLowerCase(); }
function isLowSignal(text: string, type: string): boolean {
  if (type === "sticker") return true;
  const normalized = normalize(text);
  if (!normalized) return true;
  if (/^(?:5{3,}|555+|ฮ่า+|ha+|lol+)$/iu.test(normalized.replace(/[\s.!?,。！？]+/gu, ""))) return true;
  return /^(?:ok(?:ay)?|k|kk|thanks?|thx|got it|รับทราบ|โอเค|ตกลง|ครับ|ค่ะ|จ้า|ได้เลย|ขอบคุณ)[.!?\s]*$/iu.test(normalized);
}
function dedupe(values: readonly string[]): readonly string[] { return [...new Set(values)]; }
function usageOf(billed: BilledUsage | undefined): AiUsage {
  return billed?.status === "known" && billed.usage ? billed.usage : { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}
function failureName(error: unknown): string {
  if (error instanceof AiClientError) return error.code;
  return error instanceof Error ? error.name || "model_failure" : "model_failure";
}
function safetyStatus(value: unknown): DecisionSafety {
  return value === "allowed" || value === "blocked" || value === "uncertain" ? value : "uncertain";
}
function modelDecision(value: unknown, allowedFactIds: ReadonlySet<string>): ModelDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Decision output must be an object");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.respond !== "boolean" || typeof candidate.reason !== "string" || candidate.reason.trim() === "" || candidate.reason.length > 200) throw new TypeError("Invalid decision fields");
  if (typeof candidate.interest_score !== "number" || !Number.isFinite(candidate.interest_score) || candidate.interest_score < 0 || candidate.interest_score > 1) throw new TypeError("Invalid interest score");
  if (typeof candidate.answered_by_human !== "boolean" || typeof candidate.draft !== "string" || candidate.draft.length > 2_000 || !Array.isArray(candidate.used_fact_ids)) throw new TypeError("Invalid decision fields");
  const factIds = candidate.used_fact_ids.filter((id): id is string => typeof id === "string");
  if (factIds.length !== candidate.used_fact_ids.length || factIds.some((id) => !allowedFactIds.has(id))) throw new TypeError("Decision referenced a fact outside the supplied context");
  return {
    respond: candidate.respond,
    reason: candidate.reason.trim(),
    interest_score: candidate.interest_score,
    answered_by_human: candidate.answered_by_human,
    safety: safetyStatus(candidate.safety),
    draft: candidate.draft,
    used_fact_ids: dedupe(factIds),
  };
}
function safetyFacts(facts: readonly DecisionFact[]): readonly SafetyFactMetadata[] {
  return facts.map((fact) => ({ id: fact.id, ...(fact.visibility ? { visibility: fact.visibility } : {}), ...(fact.category ? { category: fact.category } : {}) }));
}
function asSafetyGate(options: DecisionEngineOptions): (input: SafetyGateInput) => Promise<SafetyGateResult> {
  if (typeof options.safetyGate === "function") return options.safetyGate;
  const gate = options.safetyGate;
  return (input) => gate.evaluate(input);
}

export interface DecisionEngine {
  decide(input: DecisionRequest): Promise<DecisionResult>;
  evaluate(input: DecisionRequest): Promise<DecisionResult>;
  makeDecision(input: DecisionRequest): Promise<DecisionResult>;
  isDirectInvocation(input: DecisionRequest): boolean;
}

export function createDecisionEngine(options: DecisionEngineOptions): DecisionEngine {
  const clock: Clock = options.now ? { now: options.now } : systemClock;
  const repository: DecisionRepository = options.repository ?? createInMemoryDecisionRepository();
  const nextId = options.idGenerator ?? (() => crypto.randomUUID());
  const aiClient = options.aiClient;
  const safetyGate = asSafetyGate(options);
  const modelName = options.model?.trim() || DEFAULT_MODEL;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const ambientWindowMessages = options.ambientWindowMessages ?? DEFAULT_AMBIENT_WINDOW_MESSAGES;
  const neutralResponse = options.neutralResponse?.trim() || DEFAULT_NEUTRAL_RESPONSE;
  const settingsRecordsUsage = options.settings.getBudgetSnapshot !== undefined || options.settings.getStatusSnapshot !== undefined;
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0 || !Number.isSafeInteger(ambientWindowMessages) || ambientWindowMessages <= 0) throw new TypeError("Invalid decision engine configuration");

  const persist = async (record: DecisionRecord): Promise<DecisionRecord> => repository.createDecision(record);
  const resultRecord = (input: DecisionRequest, now: Date, direct: boolean, values: Pick<DecisionRecord, "respond" | "reason" | "interestScore" | "answeredByHuman" | "safety" | "draft" | "usedFactIds" | "suppressionReason">): DecisionRecord => ({
    id: nextId(), groupId: input.groupId, sourceMessageId: input.sourceMessageId ?? input.message?.id ?? null, episodeId: input.episodeId ?? null, responseId: input.responseId ?? null,
    decisionType: direct ? "direct" : "ambient", ...values, createdAt: now,
  });
  const suppressed = async (input: DecisionRequest, now: Date, direct: boolean, reason: SuppressionReason, extras: Partial<Pick<DecisionRecord, "safety" | "answeredByHuman" | "interestScore" | "draft" | "usedFactIds">> = {}): Promise<DecisionResult> => {
    const record = await persist(resultRecord(input, now, direct, { respond: false, reason, interestScore: extras.interestScore ?? null, answeredByHuman: extras.answeredByHuman ?? null, safety: extras.safety ?? "allowed", draft: extras.draft ?? null, usedFactIds: extras.usedFactIds ?? [], suppressionReason: reason }));
    return { ...record, direct, suppressionReason: reason };
  };

  const decide = async (input: DecisionRequest): Promise<DecisionResult> => {
    const groupId = requiredId(input.groupId, "groupId");
    const now = validDate(input.now, clock.now());
    const direct = input.decisionType === "direct" || input.path === "direct" || isDirectInvocation(input);
    const type = messageType(input);
    const text = messageText(input);
    const settings = await options.settings.getGroupSettings(groupId);
    if (!settings) return suppressed(input, now, direct, "missing_settings");
    if (!settings.active) return suppressed(input, now, direct, "inactive_group");
    if (isGroupMuted(settings, now)) return suppressed(input, now, direct, "muted");
    if (input.authorized === false) return suppressed(input, now, direct, "unauthorized");

    if (!direct) {
      if (!settings.ambientEnabled) return suppressed(input, now, false, "ambient_disabled");
      if (type === "sticker") return suppressed(input, now, false, "sticker_only");
      if (type !== "text") return suppressed(input, now, false, "non_text");
      if (isLowSignal(text, type)) return suppressed(input, now, false, "low_signal");
      if (input.duplicate) return suppressed(input, now, false, "duplicate");
      if (input.responseBudgetExceeded) return suppressed(input, now, false, "ambient_rate_limit");
      if (input.answeredByHuman) return suppressed(input, now, false, "human_answered", { answeredByHuman: true });
      if (input.staleContext) return suppressed(input, now, false, "stale_context");
      let last = input.lastAmbientResponseAt ?? null;
      if (!last && repository.getLastAmbientResponseAt) last = await repository.getLastAmbientResponseAt(groupId, now);
      if (last && now.getTime() - last.getTime() < Math.max(cooldownMs, settings.ambientCooldownSeconds * 1_000)) return suppressed(input, now, false, "cooldown");
      const substantive = finiteInteger(input.recentSubstantiveMessageCount, 0);
      let ambientCount = finiteInteger(input.recentAmbientResponseCount, 0);
      if (repository.countAmbientResponsesSince && substantive === 0) {
        ambientCount = await repository.countAmbientResponsesSince(groupId, new Date(now.getTime() - 10 * 60_000), now);
      }
      if (ambientCount > 0 && substantive > 0 && ambientCount * ambientWindowMessages >= substantive) return suppressed(input, now, false, "ambient_rate_limit");
      if (options.settings.getBudgetSnapshot || options.settings.getStatusSnapshot) {
        const budget = options.settings.getBudgetSnapshot
          ? await options.settings.getBudgetSnapshot(groupId, now)
          : (await options.settings.getStatusSnapshot?.(groupId, now))?.budget ?? null;
        if (input.dailyBudgetExhausted || !budget || budget.remainingTokens <= 0) return suppressed(input, now, false, "daily_budget_exhausted");
      } else if (input.dailyBudgetExhausted) {
        return suppressed(input, now, false, "daily_budget_exhausted");
      }
    }

    const facts = dedupe((input.facts ?? []).map((fact) => requiredId(fact.id, "fact.id"))).map((id) => (input.facts ?? []).find((fact) => fact.id === id) as DecisionFact);
    const allowedFactIds = new Set(facts.map((fact) => fact.id));
    let decision: ModelDecision | undefined;
    let billed: BilledUsage | undefined;
    let requestId: string | undefined;
    let aiFailure: string | undefined;
    if (!aiClient) {
      aiFailure = "model_unavailable";
    } else {
      try {
        const response = await aiClient.structured<ModelDecision>({
          task: options.taskName?.trim() || "selective_response_decision",
          prompt: { decisionType: direct ? "direct" : "ambient", message: { type, text }, context: (input.context ?? null) as never, facts: facts.map((fact) => ({ id: fact.id, claim: fact.claim ?? "", category: fact.category ?? "", visibility: fact.visibility ?? "public_safe" })) },
          schema: DECISION_SCHEMA,
          validate: (value) => modelDecision(value, allowedFactIds),
        });
        decision = response.value;
        billed = response.billedUsage;
        requestId = response.requestId;
      } catch (error) {
        aiFailure = failureName(error);
        billed = error instanceof AiClientError ? error.billedUsage : undefined;
      }
    }
    if (aiFailure || !decision) {
      const usage = usageOf(billed);
      await repository.recordUsage({ groupId, decisionId: null, operation: "selective_response_decision", model: modelName, usage, occurredAt: now, requestId, billedUsage: billed });
      if (!direct) return suppressed(input, now, false, "model_failure");
      const safeNeutral = await safetyGate({ draft: neutralResponse, userText: input.userText, path: "direct", facts: [] });
      const fallback = safeNeutral.response ?? safeNeutral.neutralResponse ?? neutralResponse;
      const record = await persist(resultRecord(input, now, true, { respond: true, reason: "neutral_fallback", interestScore: null, answeredByHuman: false, safety: safeNeutral.status, draft: fallback, usedFactIds: [], suppressionReason: null }));
      return { ...record, direct: true, suppressionReason: null, safetyResult: safeNeutral, aiFailure };
    }
    const usage = usageOf(billed);
    const finalDecision = decision;
    const usageDecision = await options.settings.consumeAiBudget({ groupId, path: direct ? "direct" : "ambient", model: modelName, operation: "selective_response_decision", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, occurredAt: now, requestId });
    if (!settingsRecordsUsage) await repository.recordUsage({ groupId, decisionId: null, operation: "selective_response_decision", model: modelName, usage, occurredAt: now, requestId, billedUsage: billed });
    if (!usageDecision.allowed && !direct) return suppressed(input, now, false, usageDecision.reason === "inactive_group" ? "inactive_group" : "daily_budget_exhausted");
    if (!direct && finalDecision.answered_by_human) return suppressed(input, now, false, "human_answered", { answeredByHuman: true, interestScore: finalDecision.interest_score, safety: finalDecision.safety, usedFactIds: finalDecision.used_fact_ids });
    if (!finalDecision.respond) return suppressed(input, now, direct, "model_declined", { answeredByHuman: finalDecision.answered_by_human, interestScore: finalDecision.interest_score, safety: finalDecision.safety, draft: finalDecision.draft || null, usedFactIds: finalDecision.used_fact_ids });
    if (finalDecision.safety !== "allowed") {
      if (!direct) return suppressed(input, now, false, finalDecision.safety === "blocked" ? "safety_blocked" : "safety_uncertain", { answeredByHuman: finalDecision.answered_by_human, interestScore: finalDecision.interest_score, safety: finalDecision.safety, usedFactIds: finalDecision.used_fact_ids });
      const safeNeutral = await safetyGate({ draft: neutralResponse, userText: input.userText, path: "direct", facts: [] });
      const fallback = safeNeutral.response ?? safeNeutral.neutralResponse ?? neutralResponse;
      const record = await persist(resultRecord(input, now, true, { respond: true, reason: "neutral_fallback", interestScore: finalDecision.interest_score, answeredByHuman: finalDecision.answered_by_human, safety: safeNeutral.status, draft: fallback, usedFactIds: [] , suppressionReason: null }));
      return { ...record, direct: true, suppressionReason: null, safetyResult: safeNeutral };
    }
    const usedFacts = facts.filter((fact) => finalDecision.used_fact_ids.includes(fact.id));
    const safety = await safetyGate({ draft: finalDecision.draft, userText: input.userText, path: direct ? "direct" : "ambient", facts: safetyFacts(usedFacts) });
    if (safety.status !== "allowed") {
      if (!direct) return suppressed(input, now, false, safety.status === "blocked" ? "safety_blocked" : "safety_uncertain", { answeredByHuman: finalDecision.answered_by_human, interestScore: finalDecision.interest_score, safety: safety.status, usedFactIds: finalDecision.used_fact_ids });
      const fallback = safety.response ?? safety.neutralResponse ?? neutralResponse;
      const record = await persist(resultRecord(input, now, true, { respond: true, reason: "neutral_fallback", interestScore: finalDecision.interest_score, answeredByHuman: finalDecision.answered_by_human, safety: safety.status, draft: fallback, usedFactIds: [], suppressionReason: null }));
      return { ...record, direct: true, suppressionReason: null, safetyResult: safety };
    }
    const record = await persist(resultRecord(input, now, direct, { respond: true, reason: finalDecision.reason, interestScore: finalDecision.interest_score, answeredByHuman: finalDecision.answered_by_human, safety: safety.status, draft: safety.response ?? finalDecision.draft, usedFactIds: finalDecision.used_fact_ids, suppressionReason: null }));
    return { ...record, direct, suppressionReason: null, safetyResult: safety };
  };
  return { decide, evaluate: decide, makeDecision: decide, isDirectInvocation };
}

export const createSelectiveResponseDecisionEngine = createDecisionEngine;
export const createSelectiveResponseEngine = createDecisionEngine;

