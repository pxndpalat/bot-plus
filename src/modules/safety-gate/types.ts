import type { AiClient } from "../ai-client/index.ts";

/** The only outcomes a caller may act on. */
export type SafetyStatus = "allowed" | "blocked" | "uncertain";
export type SafetyPath = "direct" | "ambient";

/** Categories are intentionally stable machine values, not model prose. */
export type SafetyCategory =
  | "health"
  | "injury"
  | "religion"
  | "politics"
  | "sexuality"
  | "finance"
  | "illegal_activity"
  | "secret"
  | "real_time_location"
  | "violent_attack"
  | "prompt_injection"
  | "policy_override"
  | "none";

export type SafetyReason =
  | "allowed"
  | "secret_detected"
  | "real_time_location_detected"
  | "prompt_injection_detected"
  | "policy_override_detected"
  | "risky_fact"
  | "prohibited_category"
  | "model_blocked"
  | "model_uncertain"
  | "model_failure"
  | "invalid_input";

/** Metadata is deliberately smaller than a persona fact. Claims are never required. */
export interface SafetyFactMetadata {
  readonly id?: string;
  readonly visibility?: "public_safe" | "private" | "risky";
  readonly category?: string;
  readonly risky?: boolean;
}

export interface SafetyGateInput {
  /** The candidate text that would be sent to the group. */
  readonly draft: string;
  /** Optional source text used to detect attempts to override policy. */
  readonly userText?: string;
  /** Persona metadata used by the classifier; claims are not sent to the model. */
  readonly facts?: readonly SafetyFactMetadata[];
  /** Alias accepted by callers that call this value fact metadata. */
  readonly factMetadata?: readonly SafetyFactMetadata[];
  readonly path?: SafetyPath;
  readonly mode?: SafetyPath;
  readonly decisionType?: SafetyPath;
  /** Tone can change wording only; it is never included as policy. */
  readonly tone?: string;
}

export interface SafetyClassification {
  readonly status: SafetyStatus;
  readonly category: SafetyCategory;
  readonly reason: string;
}

export interface SafetyGateResult {
  readonly status: SafetyStatus;
  /** Aliases make the result convenient at decision and persistence boundaries. */
  readonly safety: SafetyStatus;
  readonly decision: SafetyStatus;
  readonly reason: SafetyReason;
  readonly reasonCode: SafetyReason;
  readonly category?: SafetyCategory;
  readonly machineReason: SafetyReason;
  readonly modelReason?: string;
  readonly path: SafetyPath;
  /** The candidate to send. Undefined means silence (ambient blocked/uncertain). */
  readonly response?: string;
  readonly reply?: string;
  readonly neutralResponse?: string;
}

export interface SafetyGateOptions {
  readonly aiClient?: AiClient;
  readonly classifier?: AiClient;
  /** Neutral text is intentionally generic and contains no draft or fact. */
  readonly neutralResponse?: string;
  readonly taskName?: string;
}

export const DEFAULT_NEUTRAL_RESPONSE = "ขอเลือกตอบแบบปลอดภัยก่อนนะ";
