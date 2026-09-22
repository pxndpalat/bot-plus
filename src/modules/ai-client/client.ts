import type { StructuredLogger } from "../telemetry/index.ts";
import {
  AiClientError,
  type AiClient,
  type AiProviderResponse,
  type AiResponsesTransport,
  type AiUsage,
  type BilledUsage,
  type JsonSchema,
  type PromptPayload,
  type StructuredResponseRequest,
  type StructuredResponseResult,
  type StructuredValidator,
  type UsageAccountingEvent,
  type UsageAccountingPort,
} from "./types.ts";

const DEFAULT_MODEL = "gpt-5-nano";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32_768;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const MAX_RETRIES = 1;
const PROTECTED_PROMPT_KEY = /^(?:system|instructions?|policy|tools?|tool_choice|authorization|headers?|api[_-]?key|token|model)$/i;

class RequestTimeout extends Error {
  constructor() {
    super("AI request timed out");
    this.name = "RequestTimeout";
  }
}

class InvalidJsonOutput extends Error {
  constructor() {
    super("AI output was not valid JSON");
    this.name = "InvalidJsonOutput";
  }
}

class InvalidSchemaOutput extends Error {
  constructor() {
    super("AI output did not match the schema");
    this.name = "InvalidSchemaOutput";
  }
}

interface ClientOptions {
  readonly transport: AiResponsesTransport;
  readonly model?: string;
  readonly policy?: string;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly maxPromptBytes?: number;
  readonly maxOutputBytes?: number;
  readonly usagePort?: UsageAccountingPort;
  readonly logger?: Pick<StructuredLogger, "info" | "warn" | "error">;
}

export type AiClientOptions = ClientOptions;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonSchema {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  return Object.entries(value).every(([, item]) => isJsonValue(item, seen));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function requestError(message: string): AiClientError {
  return new AiClientError("request_invalid", {
    attempts: 0,
    billedUsage: { status: "unknown" },
    cause: new Error(message),
  });
}

function assertSafePrompt(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value !== "object") throw requestError("Prompt payload must be JSON serializable");
  if (seen.has(value)) throw requestError("Prompt payload must not contain circular references");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertSafePrompt(item, seen);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (PROTECTED_PROMPT_KEY.test(key)) throw requestError(`Prompt payload contains protected field ${key}`);
    assertSafePrompt(item, seen);
  }
}

function serializePrompt(prompt: PromptPayload, maxBytes: number): string {
  assertSafePrompt(prompt);
  const serialized = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
  if (serialized === undefined || byteLength(serialized) > maxBytes) throw requestError("Prompt payload exceeds the configured limit");
  return serialized;
}

function assertSchema(schema: JsonSchema): void {
  if (!isJsonValue(schema) || typeof schema !== "object" || Array.isArray(schema)) throw requestError("Schema must be a JSON object");
  if (schema.type === "object" && schema.properties !== undefined && (typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties))) {
    throw requestError("Schema properties must be an object");
  }
}

function schemaTypeMatches(value: unknown, type: JsonSchema["type"]): boolean {
  if (!type) return true;
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function validateAgainstSchema(value: unknown, schema: JsonSchema, path = "$", seen = new WeakSet<object>()): void {
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) throw new InvalidSchemaOutput();
  if (schema.enum !== undefined && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) throw new InvalidSchemaOutput();
  if (schema.anyOf !== undefined && !schema.anyOf.some((candidate) => {
    try {
      validateAgainstSchema(value, candidate, path, seen);
      return true;
    } catch {
      return false;
    }
  })) throw new InvalidSchemaOutput();
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validateAgainstSchema(value, candidate, path, seen);
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) throw new InvalidSchemaOutput();
  }
  if (!schemaTypeMatches(value, schema.type)) throw new InvalidSchemaOutput();
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new InvalidSchemaOutput();
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new InvalidSchemaOutput();
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new InvalidSchemaOutput();
    if (schema.maximum !== undefined && value > schema.maximum) throw new InvalidSchemaOutput();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new InvalidSchemaOutput();
    seen.add(value);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new InvalidSchemaOutput();
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new InvalidSchemaOutput();
    if (schema.items) value.forEach((item, index) => validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${index}]`, seen));
    return;
  }
  if (typeof value === "object" && value !== null && schema.type === "object") {
    if (seen.has(value)) throw new InvalidSchemaOutput();
    seen.add(value);
    const object = value as Record<string, unknown>;
    for (const required of schema.required ?? []) if (!(required in object)) throw new InvalidSchemaOutput();
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(object)) {
      const propertySchema = properties[key];
      if (propertySchema) validateAgainstSchema(item, propertySchema, `${path}.${key}`, seen);
      else if (schema.additionalProperties !== true) throw new InvalidSchemaOutput();
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateAgainstSchema(item, schema.additionalProperties, `${path}.${key}`, seen);
    }
  }
}

function customValidate<T>(value: unknown, validator: StructuredValidator<T> | undefined): T {
  if (!validator) return value as T;
  try {
    if (typeof validator === "function") return validator(value);
    if ("parse" in validator) return validator.parse(value);
    const result = validator.safeParse(value);
    if (!result.success) throw new InvalidSchemaOutput();
    return result.data as T;
  } catch (error) {
    if (error instanceof InvalidSchemaOutput) throw error;
    throw new InvalidSchemaOutput();
  }
}

function outputText(response: AiProviderResponse): string | unknown {
  if (typeof response.outputText === "string") return response.outputText;
  if (typeof response.output === "string") return response.output;
  if (response.output !== undefined && !Array.isArray(response.output)) return response.output;
  if (Array.isArray(response.output)) {
    const chunks: string[] = [];
    for (const item of response.output) {
      const object = asRecord(item);
      if (object?.type === "message" && Array.isArray(object.content)) {
        for (const content of object.content) {
          const block = asRecord(content);
          if (block?.type === "output_text" && typeof block.text === "string") chunks.push(block.text);
        }
      }
    }
    if (chunks.length > 0) return chunks.join("");
  }
  throw new InvalidJsonOutput();
}

function normalizeUsage(value: Partial<AiUsage> | undefined): BilledUsage {
  if (!value) return { status: "unknown" };
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  const totalTokens = value.totalTokens;
  if (![inputTokens, outputTokens, totalTokens].every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0)) return { status: "unknown" };
  return { status: "known", usage: { inputTokens: inputTokens as number, outputTokens: outputTokens as number, totalTokens: totalTokens as number } };
}

function combineUsage(current: BilledUsage, next: BilledUsage): BilledUsage {
  if (current.status === "unknown" || next.status === "unknown") return { status: "unknown" };
  return {
    status: "known",
    usage: {
      inputTokens: (current.usage?.inputTokens ?? 0) + (next.usage?.inputTokens ?? 0),
      outputTokens: (current.usage?.outputTokens ?? 0) + (next.usage?.outputTokens ?? 0),
      totalTokens: (current.usage?.totalTokens ?? 0) + (next.usage?.totalTokens ?? 0),
    },
  };
}

function isTimeout(error: unknown): boolean {
  if (error instanceof RequestTimeout) return true;
  if (!(error instanceof Error)) return false;
  const text = `${error.name} ${error.message}`.toLowerCase();
  return text.includes("timeout") || text.includes("timed out") || text.includes("etimedout") || text.includes("abort");
}

function sanitizedProviderError(): AiClientError {
  return new AiClientError("provider_error", { attempts: 1, billedUsage: { status: "unknown" } });
}

async function callWithTimeout(transport: AiResponsesTransport, request: Parameters<AiResponsesTransport["create"]>[0], timeoutMs: number): Promise<AiProviderResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = transport.create(request, { signal: controller.signal, timeoutMs });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeout());
    }, timeoutMs);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createAiClient(options: AiClientOptions): AiClient {
  const model = options.model?.trim() || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const maxPromptBytes = options.maxPromptBytes ?? 65_536;
  const defaultMaxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!model || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0 || !Number.isInteger(maxPromptBytes) || maxPromptBytes <= 0 || !Number.isInteger(defaultMaxOutputBytes) || defaultMaxOutputBytes <= 0) {
    throw new TypeError("Invalid AI client configuration");
  }

  const structured = async <T>(request: StructuredResponseRequest<T>): Promise<StructuredResponseResult<T>> => {
    if (typeof request.task !== "string" || request.task.trim().length === 0 || request.task.length > 64) throw requestError("Task must be a non-empty name of at most 64 characters");
    assertSchema(request.schema);
    const prompt = serializePrompt(request.prompt, maxPromptBytes);
    const outputLimit = request.maxOutputBytes ?? defaultMaxOutputBytes;
    if (!Number.isInteger(outputLimit) || outputLimit <= 0) throw requestError("Invalid output limit");
    const providerRequest = {
      model,
      input: prompt,
      ...(options.policy ? { instructions: options.policy } : {}),
      text: { format: { type: "json_schema" as const, name: request.task.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64), strict: true as const, schema: request.schema } },
      max_output_tokens: maxOutputTokens,
    };
    const requestTimeoutMs = request.timeoutMs ?? timeoutMs;
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) throw requestError("Invalid timeout");

    let billedUsage: BilledUsage = { status: "known", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    let attempts = 0;
    for (;;) {
      attempts += 1;
      options.logger?.info("ai.request", { task: request.task, model, attempt: attempts });
      try {
        const providerResponse = await callWithTimeout(options.transport, providerRequest, requestTimeoutMs);
        const attemptUsage = normalizeUsage(providerResponse.usage);
        billedUsage = combineUsage(billedUsage, attemptUsage);
        let rawOutput = outputText(providerResponse);
        if (typeof rawOutput === "string") {
          if (byteLength(rawOutput) > outputLimit) throw new AiClientError("output_too_large", { attempts, billedUsage });
          try {
            rawOutput = JSON.parse(rawOutput) as unknown;
          } catch {
            throw new InvalidJsonOutput();
          }
        } else if (byteLength(JSON.stringify(rawOutput) ?? "") > outputLimit) {
          throw new AiClientError("output_too_large", { attempts, billedUsage });
        }
        validateAgainstSchema(rawOutput, request.schema);
        const value = customValidate(rawOutput, request.validate);
        const outcome: UsageAccountingEvent["outcome"] = "success";
        await recordUsage(options.usagePort, { task: request.task, model, attempt: attempts, billedUsage: attemptUsage, outcome });
        return { value, billedUsage, attempts, requestId: providerResponse.requestId };
      } catch (error) {
        const attemptUsage = error instanceof AiClientError ? error.billedUsage : { status: "unknown" as const };
        if (error instanceof AiClientError && error.code === "output_too_large") {
          await recordUsage(options.usagePort, { task: request.task, model, attempt: attempts, billedUsage: attemptUsage, outcome: "provider_error" });
          throw error;
        }
        const timeout = isTimeout(error);
        const invalidJson = error instanceof InvalidJsonOutput;
        const invalidSchema = error instanceof InvalidSchemaOutput;
        const retryable = timeout || invalidJson || invalidSchema;
        const failureCode = timeout ? "timeout" : invalidJson ? "invalid_json" : "invalid_schema";
        const attemptBilledUsage = error instanceof AiClientError ? error.billedUsage : timeout ? { status: "unknown" as const } : attemptUsage;
        if (!timeout && !invalidJson && !invalidSchema) {
          const failure = sanitizedProviderError();
          const failed = new AiClientError(failure.code, { attempts, billedUsage: combineUsage(billedUsage, attemptBilledUsage), cause: undefined });
          await recordUsage(options.usagePort, { task: request.task, model, attempt: attempts, billedUsage: attemptBilledUsage, outcome: "provider_error" });
          options.logger?.warn("ai.failure", { task: request.task, model, attempt: attempts, code: failed.code });
          throw failed;
        }
        await recordUsage(options.usagePort, { task: request.task, model, attempt: attempts, billedUsage: attemptBilledUsage, outcome: failureCode });
        if (retryable && attempts <= MAX_RETRIES) {
          options.logger?.warn("ai.retry", { task: request.task, model, attempt: attempts, code: failureCode });
          continue;
        }
        const failed = new AiClientError(failureCode, { attempts, billedUsage: combineUsage(billedUsage, attemptBilledUsage), retryable: false });
        options.logger?.warn("ai.failure", { task: request.task, model, attempt: attempts, code: failureCode });
        throw failed;
      }
    }
  };

  return { structured, requestStructured: structured, complete: structured };
}

async function recordUsage(port: UsageAccountingPort | undefined, event: UsageAccountingEvent): Promise<void> {
  if (!port) return;
  try {
    await port.record(event);
  } catch {
    // Usage accounting must not turn a model response into a second response.
  }
}

export const createStructuredAiClient = createAiClient;
