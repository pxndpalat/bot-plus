import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { CompiledQuery } from "kysely";
import {
  createDatabase,
  migrateToLatest,
  rebuildDatabase,
  rollbackLastMigration,
} from "./index.ts";

test("PostgreSQL migration contract rebuilds, enforces invariants, and exposes critical indexes", async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) return;

  const { db } = createDatabase(connectionString);
  try {
    await rebuildDatabase(db);
    const now = new Date("2026-01-02T03:04:05.000Z");

    await db
      .insertInto("groups")
      .values({ id: "group-1", line_group_id: "line-group-1" })
      .execute();
    await db
      .insertInto("members")
      .values({
        id: "member-1",
        group_id: "group-1",
        line_user_id: "line-user-1",
        joined_at: now,
        memory_opted_out: false,
      })
      .execute();
    await db
      .insertInto("webhook_events")
      .values({
        id: "event-1",
        webhook_event_id: "webhook-1",
        group_id: "group-1",
        event_type: "message",
        event_at: now,
        received_at: now,
        redelivered: false,
        payload: {},
      })
      .execute();
    await db
      .insertInto("messages")
      .values({
        id: "message-1",
        webhook_event_id: "event-1",
        group_id: "group-1",
        sender_member_id: "member-1",
        line_message_id: "line-message-1",
        message_type: "text",
        text_content: "hello",
        media_metadata: {},
        sent_at: now,
        received_at: now,
        reply_token: "reply-token",
        reply_token_received_at: now,
        reply_token_expires_at: new Date(now.getTime() + 60_000),
      })
      .execute();

    const roundTrip = await db
      .selectFrom("messages")
      .select("sent_at")
      .where("id", "=", "message-1")
      .executeTakeFirstOrThrow();
    assert.equal(roundTrip.sent_at.toISOString(), now.toISOString());

    await assert.rejects(
      db
        .insertInto("messages")
        .values({
          id: "message-2",
          webhook_event_id: "event-1",
          group_id: "group-1",
          sender_member_id: "member-1",
          line_message_id: "line-message-1",
          message_type: "text",
          text_content: "duplicate",
          media_metadata: {},
          sent_at: now,
          received_at: now,
        })
        .execute(),
    );

    await assert.rejects(
      db
        .insertInto("messages")
        .values({
          id: "message-3",
          webhook_event_id: "event-1",
          group_id: "group-1",
          sender_member_id: "member-1",
          line_message_id: "line-message-3",
          message_type: "text",
          text_content: "bad token timing",
          media_metadata: {},
          sent_at: now,
          received_at: now,
          reply_token: "reply-token-3",
          reply_token_received_at: now,
          reply_token_expires_at: now,
        })
        .execute(),
    );

    await db
      .insertInto("persona_observations")
      .values({
        id: "observation-1",
        group_id: "group-1",
        subject_member_id: "member-1",
        source_message_id: "message-1",
        extracted_by_member_id: "member-1",
        category: "food",
        claim: "likes noodles",
        source_strength: "self_explicit",
        confidence: 0.9,
        visibility: "public_safe",
        status: "active",
        observed_at: now,
        metadata: {},
      })
      .execute();

    await assert.rejects(
      db
        .insertInto("persona_facts")
        .values({
          id: "fact-without-observation",
          group_id: "group-1",
          subject_member_id: "member-1",
          category: "food",
          claim: "likes noodles",
          confidence: 0.9,
          visibility: "public_safe",
          active: true,
          first_seen_at: now,
          last_seen_at: now,
          expires_or_decay_at: new Date(now.getTime() + 180 * 86_400_000),
        })
        .execute(),
    );

    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("persona_facts")
        .values({
          id: "fact-1",
          group_id: "group-1",
          subject_member_id: "member-1",
          category: "food",
          claim: "likes noodles",
          confidence: 0.9,
          visibility: "public_safe",
          active: true,
          first_seen_at: now,
          last_seen_at: now,
          expires_or_decay_at: new Date(now.getTime() + 180 * 86_400_000),
        })
        .execute();
      await trx
        .insertInto("persona_fact_observations")
        .values({ fact_id: "fact-1", observation_id: "observation-1", is_supporting: true })
        .execute();
    });

    await assert.rejects(
      db
        .insertInto("members")
        .values({
          id: "member-2",
          group_id: "missing-group",
          line_user_id: "line-user-2",
          joined_at: now,
          memory_opted_out: false,
        })
        .execute(),
    );

    const indexes = await db.executeQuery<{ indexname: string }>(
      CompiledQuery.raw(
        "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname IN ('messages_context_idx', 'delayed_jobs_due_poll_idx', 'persona_facts_retrieval_idx')",
      ),
    );
    assert.deepEqual(indexes.rows.map((row) => row.indexname).sort(), [
      "delayed_jobs_due_poll_idx",
      "messages_context_idx",
      "persona_facts_retrieval_idx",
    ]);

    await rollbackLastMigration(db);
    const rolledBack = await db.executeQuery<{ regclass: string | null }>(
      CompiledQuery.raw("SELECT to_regclass('public.groups') AS regclass"),
    );
    assert.equal(rolledBack.rows[0]?.regclass, null);
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
});
