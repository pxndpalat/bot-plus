import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { createDatabase, migrateToLatest } from "../../index.ts";
import { KyselySettingsRepository } from "./index.ts";

test("Kysely settings repository serializes concurrent ambient budget reservations", async () => {
  const connectionString = process.env.TEST_SETTINGS_DATABASE_URL;
  if (!connectionString) return;

  const { db } = createDatabase(connectionString);
  const groupId = `settings-integration-${crypto.randomUUID()}`;
  try {
    await migrateToLatest(db);
    await db.insertInto("groups").values({ id: groupId, line_group_id: groupId }).execute();
    const repository = new KyselySettingsRepository(db);
    const at = new Date("2026-02-01T05:00:00.000Z");
    await repository.updateGroupSettings(
      groupId,
      { dailyTokenBudget: 100 },
      {
        action: "test.settings.initialize",
        actorLineUserId: "U-test-admin",
        occurredAt: at,
      },
    );

    const results = await Promise.all([
      repository.consumeAiBudget({
        groupId,
        path: "ambient",
        model: "test-model",
        operation: "judge",
        inputTokens: 60,
        outputTokens: 0,
        occurredAt: at,
      }),
      repository.consumeAiBudget({
        groupId,
        path: "ambient",
        model: "test-model",
        operation: "judge",
        inputTokens: 60,
        outputTokens: 0,
        occurredAt: at,
      }),
    ]);
    assert.equal(results.filter((result) => result.allowed).length, 1);
    assert.equal(results.filter((result) => result.reason === "daily_budget_exhausted").length, 1);

    const status = await repository.getStatusSnapshot(groupId, at);
    assert.equal(status?.budget.usedTokens, 60);
    assert.equal(status?.databaseReady, true);
  } finally {
    await db.deleteFrom("groups").where("id", "=", groupId).execute();
    await db.destroy();
  }
});
