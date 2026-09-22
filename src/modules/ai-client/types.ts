export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface JsonSchema {
  readonly $schema?: string;
  readonly title?: string;
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly [key: string]: unknown;
}

export type StructuredValidator<T> =
  | ((value: unknown) => T)
  | { readonly parse: (value: unknown) => T }
  | { readonly safeParse: (value: unknown) => { readonly success: boolean; readonly data?: T; readonly error?: unknown } };

export type PromptPayload = JsonValue | readonly JsonValue[];

export interface StructuredResponseRequest<T> {
  readonly task: string;
  readonly prompt: PromptPayload;
  readonly schema: JsonSchema;
  readonly validate?: StructuredValidator<T>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export type UsageStatus = "known" | "unknown";

export interface BilledUsage {
  readonly status: UsageStatus;
  readonly usage?: AiUsage;
}

export interface UsageAccountingEvent {
  readonly task: string;
  readonly model: string;
  readonly attempt: number;
  readonly billedUsage: BilledUsage;
  readonly outcome: "success" | "timeout" | "invalid_json" | "invalid_schema" | "provider_error";
}

export interface UsageAccountingPort {
  readonly record: (event: UsageAccountingEvent) => Promise<void> | void;
}

export interface AiProviderRequest {
  readonly model: string;
  readonly input: string;
  readonly instructions?: string;
  readonly text: {
    readonly format: {
      readonly type: "json_schema";
      readonly name: string;
      readonly strict: true;
      readonly schema: JsonSchema;
    };
  };
  readonly max_output_tokens: number;
}

export interface AiProviderResponse {
  readonly outputText?: string;
  readonly output?: unknown;
  readonly usage?: Partial<AiUsage>;
  readonly requestId?: string;
}

export interface AiResponsesTransport {
  readonly create: (request: AiProviderRequest, options: { readonly signal: AbortSignal; readonly timeoutMs: number }) => Promise<AiProviderResponse>;
}

export interface StructuredResponseResult<T> {
  readonly value: T;
  readonly billedUsage: BilledUsage;
  readonly attempts: number;
  readonly requestId?: string;
}

export type AiFailureCode = "timeout" | "invalid_json" | "invalid_schema" | "provider_error" | "output_too_large" | "request_invalid";

export class AiClientError extends Error {
  readonly code: AiFailureCode;
  readonly attempts: number;
  readonly billedUsage: BilledUsage;
  readonly retryable: boolean;

  constructor(code: AiFailureCode, options: { attempts: number; billedUsage: BilledUsage; retryable?: boolean; cause?: unknown }) {
    super(`AI request failed: ${code}`, { cause: options.cause });
    this.name = "AiClientError";
    this.code = code;
    this.attempts = options.attempts;
    this.billedUsage = options.billedUsage;
    this.retryable = options.retryable ?? false;
  }
}

export interface AiClient {
  readonly structured: <T>(request: StructuredResponseRequest<T>) => Promise<StructuredResponseResult<T>>;
  readonly requestStructured: <T>(request: StructuredResponseRequest<T>) => Promise<StructuredResponseResult<T>>;
  readonly complete: <T>(request: StructuredResponseRequest<T>) => Promise<StructuredResponseResult<T>>;
}
