export interface LineTextMessage {
  readonly type: "text";
  readonly text: string;
}

export type LineMessage = LineTextMessage | Readonly<Record<string, unknown>>;

export interface LineReplyCall {
  readonly kind: "reply";
  readonly replyToken: string;
  readonly messages: readonly LineMessage[];
  readonly claimKey?: string;
}

export interface LinePushCall {
  readonly kind: "push";
  readonly targetId: string;
  readonly messages: readonly LineMessage[];
}

export type LineCall = LineReplyCall | LinePushCall;

export interface FakeLineClient {
  readonly calls: readonly LineCall[];
  readonly replies: readonly LineReplyCall[];
  readonly pushes: readonly LinePushCall[];
  reply(replyToken: string, messages: readonly LineMessage[], claimKey?: string): Promise<void>;
  push(targetId: string, messages: readonly LineMessage[]): Promise<void>;
  profile(userId: string): Promise<Readonly<Record<string, unknown>>>;
  setProfile(userId: string, profile: Readonly<Record<string, unknown>>): void;
  failNext(error: Error): void;
  reset(): void;
}

export interface FakeLineClientOptions {
  readonly profiles?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export function createFakeLineClient(options: FakeLineClientOptions = {}): FakeLineClient {
  const calls: LineCall[] = [];
  const profiles = new Map(Object.entries(options.profiles ?? {}));
  let nextError: Error | undefined;
  const takeError = (): void => {
    if (!nextError) return;
    const error = nextError;
    nextError = undefined;
    throw error;
  };

  return {
    calls,
    get replies() {
      return calls.filter((call): call is LineReplyCall => call.kind === "reply");
    },
    get pushes() {
      return calls.filter((call): call is LinePushCall => call.kind === "push");
    },
    reply: async (replyToken, messages, claimKey) => {
      takeError();
      calls.push({ kind: "reply", replyToken, messages: [...messages], claimKey });
    },
    push: async (targetId, messages) => {
      takeError();
      calls.push({ kind: "push", targetId, messages: [...messages] });
    },
    profile: async (userId) => {
      takeError();
      return profiles.get(userId) ?? { userId };
    },
    setProfile: (userId, profile) => {
      profiles.set(userId, profile);
    },
    failNext: (error) => {
      nextError = error;
    },
    reset: () => {
      calls.length = 0;
      nextError = undefined;
    },
  };
}

export interface OpenAIRequest {
  readonly input: unknown;
  readonly model?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface FakeOpenAIResponse {
  readonly output: unknown;
  readonly usage?: Readonly<Record<string, number>>;
}

export interface OpenAICall {
  readonly request: OpenAIRequest;
}

export interface FakeOpenAIClient {
  readonly calls: readonly OpenAICall[];
  respondWith(response: FakeOpenAIResponse): void;
  failNext(error: Error): void;
  responses(request: OpenAIRequest): Promise<FakeOpenAIResponse>;
  reset(): void;
}

export function createFakeOpenAI(initialResponse?: FakeOpenAIResponse): FakeOpenAIClient {
  const calls: OpenAICall[] = [];
  const responses: FakeOpenAIResponse[] = initialResponse ? [initialResponse] : [];
  let nextError: Error | undefined;
  return {
    calls,
    respondWith: (response) => responses.push(response),
    failNext: (error) => {
      nextError = error;
    },
    responses: async (request) => {
      calls.push({ request });
      if (nextError) {
        const error = nextError;
        nextError = undefined;
        throw error;
      }
      const response = responses.shift();
      if (!response) throw new Error("Fake OpenAI response queue is empty");
      return response;
    },
    reset: () => {
      calls.length = 0;
      responses.length = 0;
      nextError = undefined;
    },
  };
}
