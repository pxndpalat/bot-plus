import type { LineMessageEvent, LineReplyPort, ResponseClaimProof } from "../line-adapter/index.ts";
import type { CommandHandler, CommandParseResult, CommandParserInput, CommandResult, ParsedCommand } from "../command-service/index.ts";
import type { ConversationService, RenderedContext } from "../conversation-service/index.ts";
import type { DecisionEngine, DecisionResult, DecisionRequest } from "../decision-engine/index.ts";
import type { PersonaFact, PersonaService } from "../persona-service/index.ts";
import type { SafetyGate } from "../safety-gate/index.ts";
import type { Clock, TransactionBoundary } from "../../shared/index.ts";
import type { TelemetryEvent } from "../telemetry/index.ts";

export type DirectOutcome = "sent" | "suppressed" | "duplicate" | "expired" | "unknown";
export type ResponseState = "claimed" | "sent" | "unknown" | "suppressed" | "cancelled";

export interface ResponseClaim {
  readonly responseId: string;
  readonly idempotencyKey: string;
  readonly groupId: string;
  readonly sourceMessageId: string | null;
  readonly decisionId: string | null;
  readonly state: ResponseState;
  readonly claimedAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly suppressionReason: string | null;
}

export interface ResponseClaimInput {
  readonly responseId?: string;
  readonly idempotencyKey: string;
  readonly groupId: string;
  readonly sourceMessageId?: string | null;
  readonly decisionId?: string | null;
  readonly replyToken?: string | null;
  readonly replyTokenReceivedAt?: Date | null;
  readonly replyTokenExpiresAt?: Date | null;
  readonly claimedAt: Date;
}

export interface ResponseClaimResult {
  readonly claimed: boolean;
  readonly duplicate: boolean;
  readonly response: ResponseClaim;
  readonly claimProof?: ResponseClaimProof;
}

/** Persistence seam for the irreversible response claim. Implementations must make claim atomic by idempotency key. */
export interface ResponseClaimStore {
  claim(input: ResponseClaimInput): Promise<ResponseClaimResult>;
  markSent(responseId: string, deliveredAt: Date): Promise<ResponseClaim>;
  markUnknown(responseId: string, reason: string, at: Date): Promise<ResponseClaim>;
  markSuppressed(input: ResponseClaimInput, reason: string): Promise<ResponseClaim>;
}

/** Lightweight adapter shape for compositions that persist the rest of bot responses elsewhere. */
export interface DirectResponseClaimPort {
  claim(input: { readonly idempotencyKey: string; readonly groupId: string; readonly sourceMessageId: string; readonly decisionId?: string | null; readonly now: Date }): Promise<ResponseClaimProof | null>;
}

export interface DirectPipelineInput {
  readonly groupId?: string;
  readonly event?: LineMessageEvent;
  readonly sourceMessageId?: string;
  readonly eventId?: string;
  readonly jobId?: string;
  readonly idempotencyKey?: string;
  readonly actorLineUserId?: string;
  readonly text?: string | null;
  readonly messageType?: string;
  readonly mentions?: readonly { readonly isSelf?: boolean; readonly userId?: string }[];
  readonly quotedMessageId?: string | null;
  readonly replyToken?: string | null;
  readonly replyTokenReceivedAt?: Date | null;
  readonly replyTokenExpiresAt?: Date | null;
  readonly receivedAt?: Date;
  readonly eventAt?: Date;
  readonly episodeId?: string;
  readonly context?: unknown;
  readonly now?: Date;
  readonly command?: ParsedCommand;
  readonly parsedCommand?: CommandParseResult;
  readonly facts?: readonly PersonaFact[];
  readonly decisionInput?: Omit<DecisionRequest, "groupId" | "decisionType" | "path" | "sourceMessageId" | "now" | "message" | "text" | "messageType" | "mentions" | "quotedMessageId">;
  readonly authorized?: boolean;
}

export interface DirectPipelineResult {
  readonly outcome: DirectOutcome;
  readonly idempotencyKey: string;
  readonly responseId?: string;
  readonly message?: string;
  readonly command?: CommandResult;
  readonly decision?: DecisionResult;
  readonly context?: RenderedContext;
  readonly latencyMs: number;
  readonly retry: false;
  readonly error?: string;
}

export interface DirectTelemetryPort {
  emit(event: TelemetryEvent): void;
}

export interface DirectSuppressionPort {
  record(input: { readonly groupId: string; readonly sourceMessageId?: string; readonly reason: string; readonly occurredAt: Date; readonly metadata?: Readonly<Record<string, unknown>> }): Promise<void> | void;
}

export interface DirectPipelineOptions {
  readonly reply: LineReplyPort;
  readonly responseClaims: ResponseClaimStore | DirectResponseClaimPort;
  readonly decisionEngine?: Pick<DecisionEngine, "decide">;
  readonly decision?: Pick<DecisionEngine, "decide">;
  readonly safetyGate?: Pick<SafetyGate, "evaluate">;
  readonly safety?: Pick<SafetyGate, "evaluate">;
  readonly conversation?: Pick<ConversationService, "buildContext" | "renderContext">;
  readonly commandHandler?: Pick<CommandHandler, "handle">;
  readonly commandParser?: (input: CommandParserInput) => CommandParseResult;
  readonly persona?: Pick<PersonaService, "getFacts">;
  readonly telemetry?: DirectTelemetryPort;
  readonly suppression?: DirectSuppressionPort;
  readonly clock?: Clock;
  readonly transaction?: TransactionBoundary;
  readonly replyTokenSafetyMarginMs?: number;
  readonly replyTokenMaxAgeMs?: number;
  readonly idGenerator?: () => string;
  readonly neutralResponse?: string;
}

export const DEFAULT_REPLY_TOKEN_SAFETY_MARGIN_MS = 45_000;

