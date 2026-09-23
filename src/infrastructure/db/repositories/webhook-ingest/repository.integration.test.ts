import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { parseWebhookPayload } from "../../../../modules/line-adapter/index.ts";
import { createDatabase, rebuildDatabase } from "../../index.ts";
import { createWebhookIngestRepository } from "./index.ts";

test("webhook repository deduplicates redelivery and persists jobs atomically", async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) return;

  const { db } = createDatabase(connectionString);
  try {
    await rebuildDatabase(db);
    const payload = {
      events: [{
        type: "message",
        webhookEventId: "webhook-ingest-integration-1",
        timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
        deliveryContext: { isRedelivery: false },
        source: { type: "group", groupId: "C-integration", userId: "U-integration" },
        replyToken: "reply-token-integration",
        message: {
          id: "line-message-integration-1",
          type: "text",
          text: "hello",
          mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] },
          unknownMetadata: { provider: true },
        },
      }],
    };
    const event = parseWebhookPayload(payload, new Date("2026-01-01T00:00:01.000Z")).events[0];
    if (!event) throw new Error("fixture event was not parsed");

    let sequence = 0;
    const repository = createWebhookIngestRepository(db, { idGenerator: () => `integration-id-${++sequence}` });
    const first = await repository.recordVerifiedEvent(event);
    const duplicate = await repository.recordVerifiedEvent({ ...event, redelivered: true });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(first.jobs.length, 2);
    assert.equal(duplicate.jobs.length, 0);

    const counts = await Promise.all([
      db.selectFrom("webhook_events").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("messages").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("delayed_jobs").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("group_settings").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    ]);
    assert.equal(Number(counts[0].count), 1);
    assert.equal(Number(counts[1].count), 1);
    assert.equal(Number(counts[2].count), 2);
    assert.equal(Number(counts[3].count), 1);
    const message = await db.selectFrom("messages").selectAll().executeTakeFirstOrThrow();
    assert.equal(message.text_content, "hello");
    assert.deepEqual(message.media_metadata, {
      provider: true,
      mentions: [{ index: 0, length: 4, isSelf: true }],
    });
    assert.equal(message.sent_at.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(message.received_at.toISOString(), "2026-01-01T00:00:01.000Z");
  } finally {
    await db.destroy();
  }
});
