import type { AiProviderRequest, AiProviderResponse, AiResponsesTransport } from "./types.ts";

export interface FakeAiResponsesTransport extends AiResponsesTransport {
  readonly calls: readonly AiProviderRequest[];
  readonly responses: readonly AiProviderResponse[];
  readonly enqueueResponse: (response: AiProviderResponse) => void;
  readonly enqueueError: (error: Error) => void;
  readonly reset: () => void;
}

export function createFakeAiResponsesTransport(initialResponses: readonly AiProviderResponse[] = []): FakeAiResponsesTransport {
  const calls: AiProviderRequest[] = [];
  const responses: AiProviderResponse[] = [...initialResponses];
  const errors: Error[] = [];
  return {
    calls,
    responses,
    enqueueResponse: (response) => responses.push(response),
    enqueueError: (error) => errors.push(error),
    create: async (request) => {
      calls.push(request);
      const error = errors.shift();
      if (error) throw error;
      const response = responses.shift();
      if (!response) throw new Error("Fake AI response queue is empty");
      return response;
    },
    reset: () => {
      calls.length = 0;
      responses.length = 0;
      errors.length = 0;
    },
  };
}

export const createFakeAiClientTransport = createFakeAiResponsesTransport;
