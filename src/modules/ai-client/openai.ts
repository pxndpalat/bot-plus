import OpenAI from "openai";
import type { AiProviderRequest, AiProviderResponse, AiResponsesTransport } from "./types.ts";

interface OpenAIResponseLike {
  readonly output_text?: unknown;
  readonly output?: unknown;
  readonly id?: unknown;
  readonly usage?: {
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
    readonly total_tokens?: unknown;
  };
}

export interface OpenAIResponsesClientLike {
  readonly responses: {
    readonly create: (body: Record<string, unknown>, options?: { readonly signal?: AbortSignal; readonly timeout?: number }) => Promise<unknown>;
  };
}

function asResponse(value: unknown): OpenAIResponseLike {
  if (typeof value !== "object" || value === null) throw new Error("Invalid provider response");
  return value as OpenAIResponseLike;
}

export function createOpenAIResponsesTransport(client: OpenAIResponsesClientLike): AiResponsesTransport {
  return {
    async create(request: AiProviderRequest, options): Promise<AiProviderResponse> {
      const response = asResponse(await client.responses.create({
        model: request.model,
        input: request.input,
        ...(request.instructions ? { instructions: request.instructions } : {}),
        text: request.text,
        max_output_tokens: request.max_output_tokens,
        // Tools, headers, and provider policy overrides are intentionally not accepted here.
      }, { signal: options.signal, timeout: options.timeoutMs }));
      const usage = response.usage;
      return {
        outputText: typeof response.output_text === "string" ? response.output_text : undefined,
        output: response.output,
        requestId: typeof response.id === "string" ? response.id : undefined,
        usage: usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number" && typeof usage.total_tokens === "number"
          ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens }
          : undefined,
      };
    },
  };
}

export const createOpenAITransport = createOpenAIResponsesTransport;

export interface OpenAIClientOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
}

export function createOpenAIResponsesClient(options: OpenAIClientOptions): OpenAIResponsesClientLike {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) throw new TypeError("OpenAI API key is required");
  const client = new OpenAI({ apiKey: options.apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}) });
  return client as unknown as OpenAIResponsesClientLike;
}

export const createOpenAIClient = createOpenAIResponsesClient;
