import type {
  GroupId,
  MemberId,
  MessageId,
  WebhookEventId,
} from "../../shared/index.ts";

export type JsonObject = Readonly<Record<string, unknown>>;

export interface LineEventSource {
  readonly type: "group" | "room" | "user";
  readonly groupId?: GroupId;
  readonly roomId?: string;
  readonly userId?: MemberId;
}

export interface LineMention {
  readonly index: number;
  readonly length: number;
  readonly userId?: MemberId;
  readonly isSelf: boolean;
}

export interface LineTextMessage {
  readonly type: "text";
  readonly id: MessageId;
  readonly text: string;
  readonly mentions: readonly LineMention[];
  readonly quotedMessageId?: MessageId;
  readonly quoteToken?: string;
  readonly metadata: JsonObject;
}

export interface LineStickerMessage {
  readonly type: "sticker";
  readonly id: MessageId;
  readonly metadata: JsonObject;
  readonly quotedMessageId?: MessageId;
  readonly quoteToken?: string;
}

export interface LineNonTextMessage {
  readonly type: "image" | "video" | "audio" | "file" | "location" | "template" | "flex" | "unknown";
  readonly id: MessageId;
  readonly metadata: JsonObject;
  readonly quotedMessageId?: MessageId;
  readonly quoteToken?: string;
}

export type LineMessage = LineTextMessage | LineStickerMessage | LineNonTextMessage;

interface LineEventBase {
  readonly webhookEventId: WebhookEventId;
  readonly eventType: "message" | "unsend" | "join" | "member-left";
  readonly type: "message" | "unsend" | "join" | "member-left";
  readonly source: LineEventSource;
  readonly eventAt: Date;
  /** Alias retained for consumers that use the LINE envelope vocabulary. */
  readonly timestamp: Date;
  /** Milliseconds since Unix epoch, useful when preserving LINE ordering. */
  readonly timestampMs: number;
  readonly receivedAt: Date;
  readonly redelivered: boolean;
  /** Present only when LINE supplied a reply token. It is never logged by this module. */
  readonly replyToken?: string;
}

export interface LineMessageEvent extends LineEventBase {
  readonly eventType: "message";
  readonly type: "message";
  readonly message: LineMessage;
}

export interface LineUnsendEvent extends LineEventBase {
  readonly eventType: "unsend";
  readonly type: "unsend";
  readonly messageId: MessageId;
}

export interface LineMemberEvent extends LineEventBase {
  readonly eventType: "join" | "member-left";
  readonly type: "join" | "member-left";
  readonly memberIds: readonly MemberId[];
}

export type LineEvent = LineMessageEvent | LineUnsendEvent | LineMemberEvent;

export interface ParsedLineWebhook {
  readonly events: readonly LineEvent[];
  readonly ignoredEventCount: number;
}

export interface LineReplyTextMessage {
  readonly type: "text";
  readonly text: string;
  readonly [key: string]: unknown;
}

/** Provider-independent reply payload. It deliberately does not expose SDK types. */
export type LineReplyMessage = LineReplyTextMessage | JsonObject;

export interface LineProfile {
  readonly userId: MemberId;
  readonly displayName?: string;
  readonly pictureUrl?: string;
  readonly statusMessage?: string;
  readonly language?: string;
}

export interface ResponseClaimProof {
  readonly responseId?: string;
  readonly idempotencyKey: string;
}

export interface ReplyRequest {
  readonly replyToken: string;
  readonly messages: readonly LineReplyMessage[];
  readonly claimProof: ResponseClaimProof;
}

export interface LineReplyPort {
  reply(request: ReplyRequest): Promise<void>;
}

export interface LineProfilePort {
  lookup(userId: MemberId): Promise<LineProfile>;
}

export interface LineTransportClient {
  /** The adapter accepts either naming style used by small provider fakes. */
  readonly reply?: (replyToken: string, messages: readonly LineReplyMessage[]) => Promise<unknown>;
  readonly replyMessage?: (replyToken: string, messages: readonly LineReplyMessage[]) => Promise<unknown>;
  readonly profile?: (userId: string) => Promise<unknown>;
  readonly getProfile?: (userId: string) => Promise<unknown>;
}

export type LineTransportOutcome = "transient" | "permanent" | "unknown";
