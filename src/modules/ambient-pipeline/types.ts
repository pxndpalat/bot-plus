import type { LineReplyMessage, LineReplyPort, ResponseClaimProof } from "../line-adapter/index.ts";
import type { ConversationService } from "../conversation-service/index.ts";
import type { ClaimedJob, JobHandlerResult } from "../job-runner/index.ts";
import type { DecisionEngine, DecisionFact, DecisionResult } from "../decision-engine/index.ts";
import type { SafetyGate, SafetyGateResult } from "../safety-gate/index.ts";

export const AMBIENT_MIN_DELAY_MS = 15_000;
export const AMBIENT_MAX_DELAY_MS = 30_000;
export const AMBIENT_REPLY_TOKEN_MAX_AGE_MS = 45_000;

export type AmbientSuppressionReason =
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
  | "human_answered"
  | "stale_context"
  | "model_declined"
  | "safety_blocked"
  | "safety_uncertain"
  | "model_failure"
  | "invalid_model_output"
  | "missing_settings"
  | "stale_reply_token"
  | "duplicate_response"
  | "transport_failure"
  | "missing_reply_token"
  | "not_due"
  | "invalid_candidate";

export interface AmbientClock {
  now(): Date;
}

export interface AmbientRandom {
  next(): number;
}

export interface AmbientCandidateInput {
  readonly groupId: string;
  readonly sourceMessageId: string;
  readonly eventId?: string;
  readonly messageType: string;
  readonly text?: string | null;
  readonly replyToken?: string;
  readonly replyTokenReceivedAt?: Date;
  readonly receivedAt: Date;
  readonly eventAt?: Date;
  readonly relevantMessageIds?: readonly string[];
  readonly facts?: readonly DecisionFact[];
  readonly senderMemberId?: string;
  readonly episodeId?: string;
  readonly context?: unknown;
  readonly idempotencyKey?: string;
  readonly duplicate?: boolean;
}

export interface AmbientCandidate extends AmbientCandidateInput {
  readonly idempotencyKey: string;
  readonly dueAt: Date;
}

export interface AmbientSchedulePort {
  schedule(candidate: AmbientCandidate): Promise<void | AmbientCandidate>;
}

export interface AmbientResponseClaimPort {
  /** Returns null when another worker already claimed this response. */
  claim(input: { readonly idempotencyKey: string; readonly groupId: string; readonly sourceMessageId: string; readonly now: Date }): Promise<ResponseClaimProof | null>;
}

export interface AmbientSuppression {
  readonly groupId: string;
  readonly sourceMessageId?: string;
  readonly reason: AmbientSuppressionReason;
  readonly occurredAt: Date;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AmbientSuppressionPort {
  record(suppression: AmbientSuppression): Promise<void>;
}

/** Hydrates a claimed delayed job from the conversation/message repository after restart. */
export interface AmbientCandidateLoader {
  load(job: ClaimedJob): Promise<AmbientCandidate | null>;
}

export interface AmbientPipelineDependencies {
  readonly conversation: Pick<ConversationService, "buildContext" | "renderContext" | "evaluateCandidate">;
  readonly decision: Pick<DecisionEngine, "decide">;
  readonly reply: LineReplyPort;
  readonly responseClaims: AmbientResponseClaimPort;
  readonly schedule?: AmbientSchedulePort;
  readonly candidateLoader?: AmbientCandidateLoader;
  readonly suppression?: AmbientSuppressionPort;
  readonly safety?: Pick<SafetyGate, "evaluate">;
  readonly clock?: AmbientClock;
  readonly random?: AmbientRandom;
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly replyTokenMaxAgeMs?: number;
}

export interface AmbientCandidateResult {
  readonly scheduled: boolean;
  readonly candidate?: AmbientCandidate;
  readonly suppressionReason?: AmbientSuppressionReason;
}

export interface AmbientProcessResult {
  readonly outcome: "sent" | "suppressed" | "cancelled" | "unknown";
  readonly reason?: AmbientSuppressionReason;
  readonly decision?: DecisionResult;
  readonly safety?: SafetyGateResult;
}

export interface AmbientPipeline {
  createCandidate(input: AmbientCandidateInput): Promise<AmbientCandidateResult>;
  process(candidate: AmbientCandidate): Promise<AmbientProcessResult>;
  handleJob(job: ClaimedJob): Promise<JobHandlerResult>;
}

export interface AmbientReplyPort extends LineReplyPort {
  reply(request: { readonly replyToken: string; readonly messages: readonly LineReplyMessage[]; readonly claimProof: ResponseClaimProof }): Promise<void>;
}

export type AmbientJobHandler = (job: ClaimedJob) => Promise<JobHandlerResult>;
