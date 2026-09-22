export interface MessageFixture {
  readonly id: string;
  readonly type: "text" | "sticker" | "image" | "video" | "audio" | "file";
  readonly text?: string;
  readonly quoteToken?: string;
  readonly quotedMessageId?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface MemberFixture {
  readonly userId: string;
  readonly groupId: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly joinedAt: string;
}

export interface WebhookEventFixture {
  readonly webhookEventId: string;
  readonly type: "message" | "unsend" | "join" | "member-left";
  readonly timestamp: number;
  readonly receivedAt: string;
  readonly redelivered: boolean;
  readonly source: Readonly<{ type: "group"; groupId: string; userId?: string }>;
  readonly replyToken?: string;
  readonly message?: MessageFixture;
}

export interface FixtureFactory {
  message(overrides?: Partial<MessageFixture>): MessageFixture;
  member(overrides?: Partial<MemberFixture>): MemberFixture;
  webhook(overrides?: Partial<WebhookEventFixture>): WebhookEventFixture;
  textWebhook(text: string, overrides?: Partial<WebhookEventFixture>): WebhookEventFixture;
}

export function createFixtureFactory(seed = 1): FixtureFactory {
  let sequence = seed;
  const id = (prefix: string): string => `${prefix}-${String(sequence++).padStart(3, "0")}`;
  const baseTimestamp = Date.UTC(2026, 0, 1, 12, 0, 0);

  return {
    message: (overrides = {}) => ({
      id: id("message"),
      type: "text",
      text: "hello",
      metadata: {},
      ...overrides,
    }),
    member: (overrides = {}) => ({
      userId: "U-test-member",
      groupId: "C-test-group",
      displayName: "Test Member",
      aliases: [],
      joinedAt: new Date(baseTimestamp).toISOString(),
      ...overrides,
    }),
    webhook: (overrides = {}) => ({
      webhookEventId: id("event"),
      type: "message",
      timestamp: baseTimestamp,
      receivedAt: new Date(baseTimestamp).toISOString(),
      redelivered: false,
      source: { type: "group", groupId: "C-test-group", userId: "U-test-member" },
      replyToken: "reply-token-test",
      message: undefined,
      ...overrides,
    }),
    textWebhook: (text, overrides = {}) => ({
      webhookEventId: id("event"),
      type: "message",
      timestamp: baseTimestamp,
      receivedAt: new Date(baseTimestamp).toISOString(),
      redelivered: false,
      source: { type: "group", groupId: "C-test-group", userId: "U-test-member" },
      replyToken: "reply-token-test",
      message: {
        id: id("message"),
        type: "text",
        text,
        metadata: {},
      },
      ...overrides,
    }),
  };
}

// The convenience builders intentionally create a fresh factory per call. A
// test importing these helpers must not share counters with another test file.
export const buildMessage = (overrides?: Partial<MessageFixture>): MessageFixture =>
  createFixtureFactory().message(overrides);
export const buildMember = (overrides?: Partial<MemberFixture>): MemberFixture =>
  createFixtureFactory().member(overrides);
export const buildWebhookEvent = (overrides?: Partial<WebhookEventFixture>): WebhookEventFixture =>
  createFixtureFactory().webhook(overrides);
export const buildTextWebhookEvent = (
  text: string,
  overrides?: Partial<WebhookEventFixture>,
): WebhookEventFixture => createFixtureFactory().textWebhook(text, overrides);
