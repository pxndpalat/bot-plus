import { strict as assert } from "node:assert";
import { test } from "bun:test";
import type { LineEvent } from "../line-adapter/index.ts";
import { createWebhookIngestHandler } from "./index.ts";

const event = {
  webhookEventId: "event-1",
  eventType: "message",
  type: "message",
  source: { type: "group", groupId: "group-1", userId: "member-1" },
  eventAt: new Date("2026-01-01T00:00:00.000Z"),
  timestamp: new Date("2026-01-01T00:00:00.000Z"),
  timestampMs: Date.parse("2026-01-01T00:00:00.000Z"),
  receivedAt: new Date("2026-01-01T00:00:01.000Z"),
  redelivered: false,
  replyToken: "reply-token",
  message: {
    type: "text",
    id: "line-message-1",
    text: "hello",
    mentions: [],
    metadata: {},
  },
} as unknown as LineEvent;

test("verified handler delegates only to the persistence port", async () => {
  const events: LineEvent[] = [];
  const handler = createWebhookIngestHandler({
    recordVerifiedEvent: async (received) => {
      events.push(received);
      return { duplicate: false, webhookEventId: String(received.webhookEventId), jobs: [] };
    },
  });
  const result = await handler.handleVerifiedEvent(event);
  assert.equal(result.duplicate, false);
  assert.equal(events.length, 1);
  assert.equal(events[0], event);
});

test("database errors propagate to the HTTP layer", async () => {
  const failure = new Error("database unavailable");
  const handler = createWebhookIngestHandler({ recordVerifiedEvent: async () => { throw failure; } });
  await assert.rejects(() => handler.handleVerifiedEvent(event), failure);
});

