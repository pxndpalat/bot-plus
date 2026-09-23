import type { AiClient, AiUsage, BilledUsage, JsonSchema } from "../ai-client/index.ts";
import type { GroupSettings, SettingsRepository } from "../settings/index.ts";
import type { SafetyGate, SafetyGateResult } from "../safety-gate/index.ts";

export type DecisionType = "direct" | "ambient";
export type DecisionSafety = "allowed" | "blocked" | "uncertain";

export type SuppressionReason =
  | "non_text"
  | "sticker_only"
  | "low_signal"
  | "duplicate"
  | "muted"
  | "inactive_group"
  | "ambient_disabled"
  | "cooldown"
  | "ambient_rate_limit"
  | "daily_budget_exhausted"
  | "unauthorized"
  | "human_answered"
  | "stale_context"
  | "model_declined"
  | "safety_blocked"
  | "safety_uncertain"
  | "model_failure"
  | "invalid_model_output"
  | "missing_settings";

export interface DecisionMention {
  readonly isSelf?: boolean;
  readonly userId?: string;
}

export interface DecisionMessage {
  readonly id?: string;
  readonly type?: string;
  readonly text?: string | null;
  readonly mentions?: readonly DecisionMention[];
  readonly quotedMessageId?: string | null;
  readonly authorKind?: "human" | "bot";
}

export interface DecisionFact {
  readonly id: string;
  readonly claim?: string;
  readonly category?: string;
  readonly visibility?: "public_safe" | "private" | "risky";
  readonly confidence?: number;
}

export interface DecisionContext {
  readonly messages?: readonly unknown[];
  readonly [key: string]: unknown;
}

/** Input to the policy engine. Optional fields make the seam usable by both webhook and job pipelines. */
export interface DecisionRequest {
  readonly groupId: string;
  readonly decisionType?: DecisionType;
  readonly path?: DecisionType;
  readonly sourceMessageId?: string;
  readonly episodeId?: string;
  readonly responseId?: string | null;
  readonly message?: DecisionMessage;
  readonly text?: string | null;
  readonly messageType?: string;
  readonly mentions?: readonly DecisionMention[];
  readonly botMentioned?: boolean;
  readonly quotedMessageId?: string | null;
  readonly knownBotResponseMessageIds?: readonly string[];
  readonly knownBotResponseIds?: readonly string[];
  readonly repliedToKnownBotResponse?: boolean;
  readonly parsedCommand?: boolean | { readonly recognized?: boolean } | null;
  readonly directInvocation?: boolean;
  readonly authorized?: boolean;
  readonly duplicate?: boolean;
  readonly responseBudgetExceeded?: boolean;
  readonly dailyBudgetExhausted?: boolean;
  readonly answeredByHuman?: boolean;
  readonly staleContext?: boolean;
  readonly context?: DecisionContext | unknown;
  readonly facts?: readonly DecisionFact[];
  readonly userText?: string;
  readonly recentSubstantiveMessageCount?: number;
  readonly recentAmbientResponseCount?: number;
  readonly lastAmbientResponseAt?: Date | null;
  readonly now?: Date;
}

export interface DecisionRecord {
  readonly id: string;
  readonly groupId: string;
  readonly sourceMessageId: string | null;
  readonly episodeId: string | null;
  readonly responseId: string | null;
  readonly decisionType: DecisionType;
  readonly respond: boolean;
  readonly reason: string;
  readonly interestScore: number | null;
  readonly answeredByHuman: boolean | null;
  readonly safety: DecisionSafety;
  readonly draft: string | null;
  readonly usedFactIds: readonly string[];
  readonly suppressionReason: SuppressionReason | null;
  readonly createdAt: Date;
}

export interface DecisionUsage {
  readonly id?: string;
  readonly groupId: string;
  readonly decisionId?: string | null;
  readonly operation: string;
  readonly model: string;
  readonly usage: AiUsage;
  readonly occurredAt: Date;
  readonly requestId?: string | null;
  readonly billedUsage?: BilledUsage;
}

export interface DecisionRepository {
  createDecision(record: DecisionRecord): Promise<DecisionRecord>;
  recordUsage(usage: DecisionUsage): Promise<void>;
  getLastAmbientResponseAt?(groupId: string, before: Date): Promise<Date | null>;
  countAmbientResponsesSince?(groupId: string, since: Date, until: Date): Promise<number>;
}

export interface DecisionSettingsPort {
  getGroupSettings(groupId: string): Promise<GroupSettings | null>;
  consumeAiBudget(input: {
    readonly groupId: string;
    readonly path: "ambient" | "direct";
    readonly model: string;
    readonly operation: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly occurredAt?: Date;
    readonly requestId?: string;
  }): Promise<{ readonly allowed: boolean; readonly reason?: string; readonly remainingTokens: number }>;
  getBudgetSnapshot?(groupId: string, at: Date): Promise<{ readonly usedTokens: number; readonly limitTokens: number; readonly remainingTokens: number } | null>;
  getStatusSnapshot?(groupId: string, at: Date): Promise<{ readonly budget: { readonly usedTokens: number; readonly limitTokens: number; readonly remainingTokens: number } } | null>;
}

export interface DecisionEngineOptions {
  readonly aiClient?: AiClient;
  readonly safetyGate: Pick<SafetyGate, "evaluate"> | ((input: Parameters<SafetyGate["evaluate"]>[0]) => Promise<SafetyGateResult>);
  readonly settings: DecisionSettingsPort | SettingsRepository;
  readonly repository?: DecisionRepository;
  readonly model?: string;
  readonly now?: () => Date;
  readonly idGenerator?: () => string;
  readonly neutralResponse?: string;
  readonly taskName?: string;
  readonly cooldownMs?: number;
  readonly ambientWindowMessages?: number;
}

export interface ModelDecision {
  readonly respond: boolean;
  readonly reason: string;
  readonly interest_score: number;
  readonly answered_by_human: boolean;
  readonly safety: DecisionSafety;
  readonly draft: string;
  readonly used_fact_ids: readonly string[];
}

export interface DecisionResult extends DecisionRecord {
  readonly direct: boolean;
  readonly suppressionReason: SuppressionReason | null;
  readonly safetyResult?: SafetyGateResult;
  readonly aiFailure?: string;
}

export const DECISION_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    respond: { type: "boolean" },
    reason: { type: "string", minLength: 1, maxLength: 200 },
    interest_score: { type: "number", minimum: 0, maximum: 1 },
    answered_by_human: { type: "boolean" },
    safety: { type: "string", enum: ["allowed", "blocked", "uncertain"] },
    draft: { type: "string", maxLength: 2_000 },
    used_fact_ids: { type: "array", items: { type: "string", minLength: 1, maxLength: 128 }, maxItems: 32 },
  },
  required: ["respond", "reason", "interest_score", "answered_by_human", "safety", "draft", "used_fact_ids"],
} as const);

export function isDirectInvocation(input: Pick<DecisionRequest, "directInvocation" | "mentions" | "message" | "botMentioned" | "quotedMessageId" | "knownBotResponseMessageIds" | "knownBotResponseIds" | "repliedToKnownBotResponse" | "parsedCommand">): boolean {
  if (input.directInvocation === true) return true;
  if (input.repliedToKnownBotResponse === true) return true;
  if (input.botMentioned === true) return true;
  const mentions = input.mentions ?? input.message?.mentions ?? [];
  if (mentions.some((mention) => mention.isSelf === true)) return true;
  const quoted = input.quotedMessageId ?? input.message?.quotedMessageId;
  if (quoted && [...(input.knownBotResponseMessageIds ?? []), ...(input.knownBotResponseIds ?? [])].includes(quoted)) return true;
  if (input.parsedCommand === true) return true;
  if (typeof input.parsedCommand === "object" && input.parsedCommand !== null) {
    const parsed = input.parsedCommand as { readonly recognized?: unknown; readonly kind?: unknown; readonly command?: unknown };
    return parsed.recognized === true || parsed.kind === "command" || typeof parsed.command === "string";
  }
  return false;
}

export const detectDirectInvocation = isDirectInvocation;

export function messageText(input: DecisionRequest): string {
  return input.text ?? input.message?.text ?? "";
}

export function messageType(input: DecisionRequest): string {
  return input.messageType ?? input.message?.type ?? "text";
}

