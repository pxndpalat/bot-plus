import {
  parseGroupId,
  parseMemberId,
  parseMessageId,
  parseWebhookEventId,
} from "../../shared/index.ts";
import type { RawBody } from "./signature.ts";
import { assertLineSignature } from "./signature.ts";
import type {
  JsonObject,
  LineEvent,
  LineEventSource,
  LineMention,
  LineMessage,
  LineNonTextMessage,
  LineProfile,
  LineStickerMessage,
  LineTextMessage,
  ParsedLineWebhook,
} from "./types.ts";

export class LinePayloadValidationError extends Error {
  constructor(message = "Invalid LINE webhook payload") {
    super(message);
    this.name = "LinePayloadValidationError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new LinePayloadValidationError(`Invalid LINE ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventDate(value: unknown): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new LinePayloadValidationError("Invalid LINE event timestamp");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new LinePayloadValidationError("Invalid LINE event timestamp");
  return date;
}

function receivedDate(value: Date | undefined): Date {
  const result = value ? new Date(value.getTime()) : new Date();
  if (Number.isNaN(result.getTime())) throw new LinePayloadValidationError("Invalid received timestamp");
  return result;
}

function sourceOf(value: unknown): LineEventSource {
  if (!isRecord(value)) throw new LinePayloadValidationError("Invalid LINE event source");
  const type = value.type;
  if (type !== "group" && type !== "room" && type !== "user") {
    throw new LinePayloadValidationError("Invalid LINE event source type");
  }

  const source: {
    type: "group" | "room" | "user";
    groupId?: ReturnType<typeof parseGroupId>;
    roomId?: string;
    userId?: ReturnType<typeof parseMemberId>;
  } = { type };
  if (type === "group") source.groupId = parseGroupId(requiredString(value.groupId, "group id"));
  if (type === "room") source.roomId = requiredString(value.roomId, "room id");
  const userId = optionalString(value.userId);
  if (userId) source.userId = parseMemberId(userId);
  return source;
}

function metadataOf(message: Record<string, unknown>): JsonObject {
  const excluded = new Set(["id", "type", "text", "mention", "quotedMessageId", "quoteToken"]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message)) {
    if (!excluded.has(key)) result[key] = value;
  }
  return Object.freeze(result);
}

function quoteOf(message: Record<string, unknown>): { quotedMessageId?: ReturnType<typeof parseMessageId>; quoteToken?: string } {
  const quoted = optionalString(message.quotedMessageId);
  const quoteToken = optionalString(message.quoteToken);
  return {
    ...(quoted ? { quotedMessageId: parseMessageId(quoted) } : {}),
    ...(quoteToken ? { quoteToken } : {}),
  };
}

function mentionsOf(message: Record<string, unknown>): readonly LineMention[] {
  const mention = isRecord(message.mention) ? message.mention : undefined;
  const raw = mention?.mentionees;
  if (!Array.isArray(raw)) return [];
  const result: LineMention[] = [];
  for (const value of raw) {
    if (!isRecord(value)) continue;
    if (typeof value.index !== "number" || typeof value.length !== "number") continue;
    const userId = optionalString(value.userId);
    result.push({
      index: value.index,
      length: value.length,
      ...(userId ? { userId: parseMemberId(userId) } : {}),
      isSelf: value.isSelf === true,
    });
  }
  return Object.freeze(result);
}

function messageOf(value: unknown): LineMessage {
  if (!isRecord(value)) throw new LinePayloadValidationError("Invalid LINE message");
  const id = parseMessageId(requiredString(value.id, "message id"));
  const type = requiredString(value.type, "message type");
  const quote = quoteOf(value);
  if (type === "text") {
    return {
      type,
      id,
      text: requiredString(value.text, "text message"),
      mentions: mentionsOf(value),
      ...quote,
      metadata: metadataOf(value),
    } satisfies LineTextMessage;
  }
  if (type === "sticker") {
    return { type, id, ...quote, metadata: metadataOf(value) } satisfies LineStickerMessage;
  }

  const nonTextType: LineNonTextMessage["type"] =
    type === "image" || type === "video" || type === "audio" || type === "file" || type === "location" || type === "template" || type === "flex"
      ? type
      : "unknown";
  return { type: nonTextType, id, ...quote, metadata: metadataOf(value) } satisfies LineNonTextMessage;
}

function memberIdsOf(value: unknown): ReturnType<typeof parseMemberId>[] {
  if (!isRecord(value) || !Array.isArray(value.members)) return [];
  return value.members.flatMap((member) =>
    isRecord(member) && typeof member.userId === "string" ? [parseMemberId(member.userId)] : [],
  );
}

function normalizeEvent(value: unknown, receivedAt: Date): LineEvent | undefined {
  if (!isRecord(value)) return undefined;
  const rawType = value.type;
  if (rawType !== "message" && rawType !== "unsend" && rawType !== "join" && rawType !== "member-left" && rawType !== "memberLeft") {
    return undefined;
  }

  const webhookEventId = parseWebhookEventId(requiredString(value.webhookEventId, "webhook event id"));
  const eventAt = eventDate(value.timestamp);
  const source = sourceOf(value.source);
  const type = rawType === "memberLeft" ? "member-left" : rawType;
  const base = {
    webhookEventId,
    eventType: type,
    type,
    source,
    eventAt,
    timestamp: new Date(eventAt.getTime()),
    timestampMs: eventAt.getTime(),
    receivedAt: new Date(receivedAt.getTime()),
    redelivered:
      isRecord(value.deliveryContext) && value.deliveryContext.isRedelivery === true
        ? true
        : value.redelivered === true,
    ...(optionalString(value.replyToken) ? { replyToken: optionalString(value.replyToken) } : {}),
  } as const;

  if (type === "message") return { ...base, eventType: "message", type: "message", message: messageOf(value.message) };
  if (type === "unsend") {
    return {
      ...base,
      eventType: "unsend",
      type: "unsend",
      messageId: parseMessageId(
        isRecord(value.unsend) ? requiredString(value.unsend.messageId, "unsend message id") : "",
      ),
    };
  }
  return { ...base, eventType: type, type, memberIds: memberIdsOf(type === "join" ? value.joined : value.left) };
}

export function parseWebhookPayload(payload: unknown, receivedAt?: Date): ParsedLineWebhook {
  if (!isRecord(payload) || !Array.isArray(payload.events)) {
    throw new LinePayloadValidationError("Invalid LINE webhook envelope");
  }
  const received = receivedDate(receivedAt);
  const events: LineEvent[] = [];
  let ignoredEventCount = 0;
  for (const value of payload.events) {
    const event = normalizeEvent(value, received);
    if (event) events.push(event);
    else ignoredEventCount += 1;
  }
  return { events: Object.freeze(events), ignoredEventCount };
}

export function parseWebhookEvents(payload: unknown, receivedAt?: Date): readonly LineEvent[] {
  return parseWebhookPayload(payload, receivedAt).events;
}

export function parseWebhookBody(rawBody: RawBody, signature: string, channelSecret: string, receivedAt?: Date): ParsedLineWebhook {
  // Signature verification intentionally occurs before TextDecoder/JSON.parse.
  assertLineSignature(rawBody, signature, channelSecret);
  let payload: unknown;
  try {
    payload = JSON.parse(typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody));
  } catch {
    throw new LinePayloadValidationError("Invalid LINE webhook JSON");
  }
  return parseWebhookPayload(payload, receivedAt);
}

export const parseVerifiedWebhook = parseWebhookBody;
export const parseLineWebhook = parseWebhookBody;
export const parseLineWebhookBody = parseWebhookBody;

export function normalizeProfile(value: unknown, userId: string): LineProfile {
  const id = parseMemberId(userId);
  if (!isRecord(value)) return { userId: id };
  return {
    userId: id,
    ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
    ...(typeof value.pictureUrl === "string" ? { pictureUrl: value.pictureUrl } : {}),
    ...(typeof value.statusMessage === "string" ? { statusMessage: value.statusMessage } : {}),
    ...(typeof value.language === "string" ? { language: value.language } : {}),
  };
}
