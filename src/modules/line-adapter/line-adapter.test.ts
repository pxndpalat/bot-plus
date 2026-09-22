import { createHmac } from "node:crypto";
import { strict as assert } from "node:assert";
import { test } from "bun:test";
import {
  InvalidLineSignatureError,
  MissingResponseClaimError,
  createProfilePort,
  createReplyPort,
  createResponseClaimProof,
  mapTransportError,
  parseWebhookBody,
  parseWebhookPayload,
} from "./index.ts";

const secret = "official-fixture-channel-secret";
const body = JSON.stringify({
  destination: "Ubot",
  events: [
    {
      type: "message",
      mode: "active",
      webhookEventId: "01H00000000000000000000000",
      deliveryContext: { isRedelivery: true, ignoredUnknown: "field" },
      timestamp: 1_735_732_800_000,
      source: { type: "group", groupId: "C-group", userId: "U-member" },
      replyToken: "reply-token-never-log",
      message: {
        id: "message-1",
        type: "text",
        text: "hello @bot",
        quoteToken: "quote-token",
        quotedMessageId: "message-0",
        mention: { mentionees: [{ index: 6, length: 4, userId: "U-bot", isSelf: true }] },
        unknownProviderField: { retained: true },
      },
    },
    {
      type: "message",
      webhookEventId: "01H00000000000000000000001",
      timestamp: 1_735_732_800_000,
      source: { type: "group", groupId: "C-group" },
      message: { id: "sticker-1", type: "sticker", packageId: "1", stickerId: "2" },
    },
    {
      type: "message",
      webhookEventId: "01H00000000000000000000002",
      timestamp: 1_735_732_800_000,
      source: { type: "group", groupId: "C-group" },
      message: { id: "image-1", type: "image", contentProvider: { type: "line" } },
    },
    {
      type: "unsend",
      webhookEventId: "01H00000000000000000000003",
      timestamp: 1_735_732_800_000,
      source: { type: "group", groupId: "C-group", userId: "U-member" },
      unsend: { messageId: "message-0" },
    },
    {
      type: "join",
      webhookEventId: "01H00000000000000000000004",
      timestamp: 1_735_732_800_000,
      source: { type: "group", groupId: "C-group" },
      joined: { members: [{ userId: "U-member" }] },
    },
    {
      type: "memberLeft",
      webhookEventId: "01H00000000000000000000005",
      timestamp: 1_735_732_800_000,
      source: { type: "group", groupId: "C-group" },
      left: { members: [{ userId: "U-member" }] },
    },
    { type: "follow", ignored: true },
  ],
});

function signatureFor(value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64");
}

test("verifies official-style signature over raw bytes and normalizes supported events", () => {
  const parsed = parseWebhookBody(body, signatureFor(body), secret, new Date("2026-01-01T00:00:00Z"));
  assert.equal(parsed.events.length, 6);
  assert.equal(parsed.ignoredEventCount, 1);

  const message = parsed.events[0];
  assert.equal(message?.type, "message");
  if (message?.type !== "message") throw new Error("expected message event");
  assert.equal(message.source.groupId, "C-group");
  assert.equal(message.source.userId, "U-member");
  assert.equal(message.redelivered, true);
  assert.equal(message.replyToken, "reply-token-never-log");
  assert.equal(message.message.type, "text");
  assert.equal(message.message.quotedMessageId, "message-0");
  assert.equal(message.message.mentions[0]?.isSelf, true);
  assert.deepEqual(message.message.metadata, { unknownProviderField: { retained: true } });
});

test("rejects invalid signatures before attempting to parse body", () => {
  assert.throws(
    () => parseWebhookBody("not-json", "invalid-signature", secret),
    InvalidLineSignatureError,
  );
});

test("transport ports are mockable and require a response claim proof", async () => {
  const calls: string[] = [];
  const client = {
    reply: async (replyToken: string) => {
      calls.push(replyToken);
      throw Object.assign(new Error("provider details contain reply-token-never-log"), { status: 503 });
    },
    profile: async () => ({ displayName: "Member" }),
  };
  const reply = createReplyPort(client);
  await assert.rejects(
    () => reply.reply({ replyToken: "reply-token-never-log", messages: [{ type: "text", text: "hi" }], claimProof: { idempotencyKey: "fake" } }),
    MissingResponseClaimError,
  );
  await assert.rejects(
    () => reply.reply({ replyToken: "reply-token-never-log", messages: [{ type: "text", text: "hi" }], claimProof: createResponseClaimProof("claim-1") }),
    (error: unknown) => {
      assert.equal((error as { outcome: string }).outcome, "transient");
      assert.doesNotMatch((error as Error).message, /reply-token-never-log/);
      return true;
    },
  );
  assert.deepEqual(calls, ["reply-token-never-log"]);

  const profile = createProfilePort(client);
  assert.equal((await profile.lookup("U-member" as never)).displayName, "Member");
});

test("transport errors map to safe outcomes", () => {
  assert.equal(mapTransportError({ status: 429 }).outcome, "transient");
  assert.equal(mapTransportError({ statusCode: 401 }).outcome, "permanent");
  assert.equal(mapTransportError(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })).outcome, "unknown");
});

test("payload parser ignores unknown event types and fields", () => {
  const parsed = parseWebhookPayload(
    { events: [{ type: "unknown-future-event", foo: "bar" }] },
    new Date("2026-01-01T00:00:00Z"),
  );
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.ignoredEventCount, 1);
});

