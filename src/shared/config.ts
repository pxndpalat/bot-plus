import { z } from "zod";
import { toMemberId, type MemberId } from "./domain.ts";
import { ValidationError } from "./errors.ts";
import { DURATION, parseDuration, type DurationMs } from "./time.ts";

export type Environment = Readonly<{
  lineChannelSecret: string;
  lineChannelAccessToken: string;
  openAiApiKey: string;
  openAiModel: string;
  databaseUrl: string;
  adminLineUserIds: readonly MemberId[];
  rawMessageRetentionDays: number;
  contentLogRetentionDays: number;
  personaDecayDays: number;
  ambientDelayMin: DurationMs;
  ambientDelayMax: DurationMs;
  cooldownMin: DurationMs;
  cooldownMax: DurationMs;
  replyTokenSafetyMargin: DurationMs;
  contextLimit: number;
  contextWindow: DurationMs;
}>;

export type AppEnvironment = Environment;
export type EnvironmentInput = Readonly<Record<string, string | undefined>>;

/** Raw boundary schema. Conversion to typed runtime values happens below. */
export const environmentSchema = z.object({
  LINE_CHANNEL_SECRET: z.string().trim().min(1),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().trim().min(1),
  OPENAI_API_KEY: z.string().trim().min(1),
  OPENAI_MODEL: z.string().trim().min(1).default("gpt-5-nano"),
  DATABASE_URL: z.string().trim().min(1),
  ADMIN_LINE_USER_IDS: z.string().trim().min(1),
  RAW_MESSAGE_RETENTION_DAYS: z.string().optional(),
  CONTENT_LOG_RETENTION_DAYS: z.string().optional(),
  PERSONA_DECAY_DAYS: z.string().optional(),
  AMBIENT_DELAY_MIN_SECONDS: z.string().optional(),
  AMBIENT_DELAY_MAX_SECONDS: z.string().optional(),
  COOLDOWN_MIN_SECONDS: z.string().optional(),
  COOLDOWN_MAX_SECONDS: z.string().optional(),
  REPLY_TOKEN_SAFETY_MARGIN_SECONDS: z.string().optional(),
  CONTEXT_LIMIT: z.string().optional(),
  CONTEXT_WINDOW_MINUTES: z.string().optional()
});

const defaultValue = {
  rawMessageRetentionDays: 30,
  contentLogRetentionDays: 7,
  personaDecayDays: 180,
  ambientDelayMinSeconds: 15,
  ambientDelayMaxSeconds: 30,
  cooldownMinSeconds: 3 * 60,
  cooldownMaxSeconds: 5 * 60,
  replyTokenSafetyMarginSeconds: 45,
  contextLimit: 30,
  contextWindowMinutes: 10
} as const;

function required(input: EnvironmentInput, key: string): string {
  const value = input[key]?.trim();
  if (!value) throw new ValidationError(`Missing required environment variable: ${key}`, { field: key });
  return value;
}

function positiveInteger(input: EnvironmentInput, key: string, fallback: number): number {
  const raw = input[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new ValidationError(`Environment variable ${key} must be a positive integer`, { field: key });
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`Environment variable ${key} must be a positive integer`, { field: key });
  }
  return value;
}

function durationSeconds(input: EnvironmentInput, key: string, fallback: number): DurationMs {
  const seconds = positiveInteger(input, key, fallback);
  return parseDuration(`${seconds}s`);
}

function durationMinutes(input: EnvironmentInput, key: string, fallback: number): DurationMs {
  const minutes = positiveInteger(input, key, fallback);
  return parseDuration(`${minutes}m`);
}

function adminIds(input: EnvironmentInput): readonly MemberId[] {
  const raw = required(input, "ADMIN_LINE_USER_IDS");
  const values = raw.split(",").map((id) => id.trim()).filter(Boolean);
  if (values.length === 0) throw new ValidationError("ADMIN_LINE_USER_IDS must contain at least one id", { field: "ADMIN_LINE_USER_IDS" });
  try {
    return Object.freeze(values.map(toMemberId));
  } catch (error) {
    throw new ValidationError("ADMIN_LINE_USER_IDS contains an invalid id", {
      field: "ADMIN_LINE_USER_IDS",
      reason: error instanceof Error ? error.message : "invalid id"
    });
  }
}

function checkRange(min: DurationMs, max: DurationMs, name: string): void {
  if (min > max) throw new ValidationError(`${name} minimum must not exceed maximum`, { field: name });
}

export function parseEnvironment(input: EnvironmentInput): Environment {
  // Run the schema for consistent strict boundary validation and then provide
  // field-level errors for the numeric/default values.
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ValidationError(issue?.message ?? "Invalid environment", { field: issue?.path.join(".") });
  }

  const ambientDelayMin = durationSeconds(input, "AMBIENT_DELAY_MIN_SECONDS", defaultValue.ambientDelayMinSeconds);
  const ambientDelayMax = durationSeconds(input, "AMBIENT_DELAY_MAX_SECONDS", defaultValue.ambientDelayMaxSeconds);
  const cooldownMin = durationSeconds(input, "COOLDOWN_MIN_SECONDS", defaultValue.cooldownMinSeconds);
  const cooldownMax = durationSeconds(input, "COOLDOWN_MAX_SECONDS", defaultValue.cooldownMaxSeconds);
  const replyTokenSafetyMargin = durationSeconds(
    input,
    "REPLY_TOKEN_SAFETY_MARGIN_SECONDS",
    defaultValue.replyTokenSafetyMarginSeconds
  );
  checkRange(ambientDelayMin, ambientDelayMax, "ambientDelay");
  checkRange(cooldownMin, cooldownMax, "cooldown");

  return Object.freeze({
    lineChannelSecret: required(input, "LINE_CHANNEL_SECRET"),
    lineChannelAccessToken: required(input, "LINE_CHANNEL_ACCESS_TOKEN"),
    openAiApiKey: required(input, "OPENAI_API_KEY"),
    openAiModel: input.OPENAI_MODEL?.trim() || "gpt-5-nano",
    databaseUrl: required(input, "DATABASE_URL"),
    adminLineUserIds: adminIds(input),
    rawMessageRetentionDays: positiveInteger(input, "RAW_MESSAGE_RETENTION_DAYS", defaultValue.rawMessageRetentionDays),
    contentLogRetentionDays: positiveInteger(input, "CONTENT_LOG_RETENTION_DAYS", defaultValue.contentLogRetentionDays),
    personaDecayDays: positiveInteger(input, "PERSONA_DECAY_DAYS", defaultValue.personaDecayDays),
    ambientDelayMin,
    ambientDelayMax,
    cooldownMin,
    cooldownMax,
    replyTokenSafetyMargin,
    contextLimit: positiveInteger(input, "CONTEXT_LIMIT", defaultValue.contextLimit),
    contextWindow: durationMinutes(input, "CONTEXT_WINDOW_MINUTES", defaultValue.contextWindowMinutes)
  });
}

export function loadEnvironment(): Environment {
  return parseEnvironment(process.env);
}

export const DEFAULT_ENVIRONMENT = Object.freeze({
  ...defaultValue,
  ambientDelayMin: DURATION.ambientDelayMin,
  ambientDelayMax: DURATION.ambientDelayMax,
  cooldownMin: DURATION.cooldownMin,
  cooldownMax: DURATION.cooldownMax,
  replyTokenSafetyMargin: DURATION.replyTokenSafetyMargin,
  contextWindow: DURATION.contextWindow
});
