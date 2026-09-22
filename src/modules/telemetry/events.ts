import { ValidationError } from "../../shared/index.ts";

export const TELEMETRY_EVENT_NAMES = {
  latency: "latency",
  tokenUsage: "token_usage",
  decisionOutcome: "decision_outcome",
  suppressionReason: "suppression_reason",
  replyTokenAge: "reply_token_age",
  personaExtraction: "persona_extraction",
  personaCorrection: "persona_correction",
  safetyRejection: "safety_rejection",
  feedback: "feedback",
  duplicateResponse: "duplicate_response",
} as const;

export const EVENT_NAMES = TELEMETRY_EVENT_NAMES;

export type TelemetryEventName = typeof TELEMETRY_EVENT_NAMES[keyof typeof TELEMETRY_EVENT_NAMES];
export type DecisionOutcome = "respond" | "suppress" | "cancel" | "uncertain" | "blocked" | "error";
export type FeedbackSignal = "positive" | "negative" | "silent" | "follow_up";

export interface EventCorrelation {
  readonly webhookId?: string;
  readonly jobId?: string;
  readonly decisionId?: string;
  readonly responseId?: string;
}

export interface TelemetryEventBase {
  readonly event: TelemetryEventName;
  readonly occurredAt?: string;
  readonly correlationId?: string;
  readonly correlation?: EventCorrelation;
  readonly metadata?: Record<string, unknown>;
}

export interface LatencyEvent extends TelemetryEventBase {
  readonly event: "latency";
  readonly operation: string;
  readonly durationMs: number;
  readonly success?: boolean;
}

export interface TokenUsageEvent extends TelemetryEventBase {
  readonly event: "token_usage";
  readonly operation: string;
  readonly model?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface DecisionOutcomeEvent extends TelemetryEventBase {
  readonly event: "decision_outcome";
  readonly outcome: DecisionOutcome;
  readonly path?: "direct" | "ambient" | "command";
}

export interface SuppressionReasonEvent extends TelemetryEventBase {
  readonly event: "suppression_reason";
  readonly reason: string;
  readonly path?: "direct" | "ambient" | "command";
}

export interface ReplyTokenAgeEvent extends TelemetryEventBase {
  readonly event: "reply_token_age";
  readonly ageMs: number;
  readonly expired: boolean;
}

export interface PersonaExtractionEvent extends TelemetryEventBase {
  readonly event: "persona_extraction";
  readonly extractedCount: number;
  readonly category?: string;
}

export interface PersonaCorrectionEvent extends TelemetryEventBase {
  readonly event: "persona_correction";
  readonly correctedCount: number;
  readonly category?: string;
}

export interface SafetyRejectionEvent extends TelemetryEventBase {
  readonly event: "safety_rejection";
  readonly reason: string;
  readonly category?: string;
}

export interface FeedbackEvent extends TelemetryEventBase {
  readonly event: "feedback";
  readonly signal: FeedbackSignal;
  readonly source?: "explicit" | "follow_up" | "silent_timeout";
}

export interface DuplicateResponseEvent extends TelemetryEventBase {
  readonly event: "duplicate_response";
  readonly idempotencyKey: string;
  readonly duplicate: true;
}

export type TelemetryEvent =
  | LatencyEvent
  | TokenUsageEvent
  | DecisionOutcomeEvent
  | SuppressionReasonEvent
  | ReplyTokenAgeEvent
  | PersonaExtractionEvent
  | PersonaCorrectionEvent
  | SafetyRejectionEvent
  | FeedbackEvent
  | DuplicateResponseEvent;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ValidationError("Telemetry event must be an object");
  return value as UnknownRecord;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ValidationError(`Telemetry event ${field} must be a non-empty string`);
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ValidationError(`Telemetry event ${field} must be a non-negative number`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const number = nonNegativeNumber(value, field);
  if (!Number.isInteger(number)) throw new ValidationError(`Telemetry event ${field} must be an integer`);
  return number;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function correlation(value: unknown): EventCorrelation | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ValidationError("Telemetry event correlation must be an object");
  const input = value as Record<string, unknown>;
  return {
    webhookId: optionalString(input.webhookId, "correlation.webhookId"),
    jobId: optionalString(input.jobId, "correlation.jobId"),
    decisionId: optionalString(input.decisionId, "correlation.decisionId"),
    responseId: optionalString(input.responseId, "correlation.responseId"),
  };
}

function metadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ValidationError("Telemetry event metadata must be an object");
  return value as Record<string, unknown>;
}

function occurredAt(value: unknown): string {
  if (value === undefined) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(requiredString(value, "occurredAt"));
  if (Number.isNaN(date.getTime())) throw new ValidationError("Telemetry event occurredAt must be a valid date");
  return date.toISOString();
}

function base(input: UnknownRecord, event: TelemetryEventName): TelemetryEventBase {
  const eventValue = input.event ?? input.name;
  if (eventValue !== event) throw new ValidationError(`Telemetry event must have event=${event}`);
  const correlationValue = correlation(input.correlation);
  return {
    event,
    occurredAt: occurredAt(input.occurredAt ?? input.timestamp),
    correlationId: optionalString(input.correlationId, "correlationId"),
    correlation: correlationValue,
    metadata: metadata(input.metadata),
  };
}

function path(value: unknown): "direct" | "ambient" | "command" | undefined {
  if (value === undefined) return undefined;
  if (value !== "direct" && value !== "ambient" && value !== "command") throw new ValidationError("Telemetry event path is invalid");
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ValidationError(`Telemetry event ${field} must be boolean`);
  return value;
}

function feedbackSource(value: unknown): FeedbackEvent["source"] {
  if (value === undefined) return undefined;
  if (value !== "explicit" && value !== "follow_up" && value !== "silent_timeout") throw new ValidationError("Telemetry feedback source is invalid");
  return value;
}

function outcome(value: unknown): DecisionOutcome {
  if (value !== "respond" && value !== "suppress" && value !== "cancel" && value !== "uncertain" && value !== "blocked" && value !== "error") {
    throw new ValidationError("Telemetry decision outcome is invalid");
  }
  return value;
}

export function validateTelemetryEvent(input: unknown): TelemetryEvent {
  const value = record(input);
  const event = value.event ?? value.name;
  switch (event) {
    case "latency":
      return { ...base(value, "latency"), event: "latency", operation: requiredString(value.operation, "operation"), durationMs: nonNegativeNumber(value.durationMs, "durationMs"), success: optionalBoolean(value.success, "success") };
    case "token_usage":
      return { ...base(value, "token_usage"), event: "token_usage", operation: requiredString(value.operation, "operation"), model: optionalString(value.model, "model"), inputTokens: nonNegativeInteger(value.inputTokens, "inputTokens"), outputTokens: nonNegativeInteger(value.outputTokens, "outputTokens"), totalTokens: nonNegativeInteger(value.totalTokens, "totalTokens") };
    case "decision_outcome":
      return { ...base(value, "decision_outcome"), event: "decision_outcome", outcome: outcome(value.outcome), path: path(value.path) };
    case "suppression_reason":
      return { ...base(value, "suppression_reason"), event: "suppression_reason", reason: requiredString(value.reason, "reason"), path: path(value.path) };
    case "reply_token_age":
      if (typeof value.expired !== "boolean") throw new ValidationError("Telemetry event expired must be boolean");
      return { ...base(value, "reply_token_age"), event: "reply_token_age", ageMs: nonNegativeNumber(value.ageMs, "ageMs"), expired: value.expired };
    case "persona_extraction":
      return { ...base(value, "persona_extraction"), event: "persona_extraction", extractedCount: nonNegativeInteger(value.extractedCount, "extractedCount"), category: optionalString(value.category, "category") };
    case "persona_correction":
      return { ...base(value, "persona_correction"), event: "persona_correction", correctedCount: nonNegativeInteger(value.correctedCount, "correctedCount"), category: optionalString(value.category, "category") };
    case "safety_rejection":
      return { ...base(value, "safety_rejection"), event: "safety_rejection", reason: requiredString(value.reason, "reason"), category: optionalString(value.category, "category") };
    case "feedback":
      if (value.signal !== "positive" && value.signal !== "negative" && value.signal !== "silent" && value.signal !== "follow_up") throw new ValidationError("Telemetry feedback signal is invalid");
      return { ...base(value, "feedback"), event: "feedback", signal: value.signal, source: feedbackSource(value.source) };
    case "duplicate_response":
      if (value.duplicate !== true) throw new ValidationError("Telemetry duplicate response must set duplicate=true");
      return { ...base(value, "duplicate_response"), event: "duplicate_response", idempotencyKey: requiredString(value.idempotencyKey, "idempotencyKey"), duplicate: true };
    default:
      throw new ValidationError("Unknown telemetry event name");
  }
}

export function createTelemetryEvent<T extends TelemetryEvent>(event: T): T {
  return validateTelemetryEvent(event) as T;
}
