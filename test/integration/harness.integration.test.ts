import { strict as assert } from "node:assert";
import { test } from "bun:test";
import {
  assertSafeTestDatabaseUrl,
  createPostgresTestHarness,
  requireTestDatabaseUrl,
} from "../support/index.ts";

test("PostgreSQL safety gate rejects production URLs", () => {
  assert.throws(
    () => assertSafeTestDatabaseUrl("postgres://user:pass@db.example.com/mallnew"),
    /non-local host/,
  );
  assert.throws(
    () => assertSafeTestDatabaseUrl("postgres://user:pass@localhost/mallnew"),
    /database name/,
  );
  assert.throws(() => requireTestDatabaseUrl(undefined), /TEST_DATABASE_URL is not set/);
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl === undefined) {
  test("PostgreSQL integration harness is opt-in", () => {
    assert.equal(testDatabaseUrl, undefined);
  });
} else {
  test("PostgreSQL harness uses an isolated schema and can migrate/reset", async () => {
    const harness = createPostgresTestHarness({
      databaseUrl: testDatabaseUrl,
      migrate: async ({ client }) => {
        await client.query(
          "CREATE TABLE IF NOT EXISTS harness_probe (id integer PRIMARY KEY, value text NOT NULL)",
        );
      },
    });
    try {
      await harness.runMigrations();
      await harness.withConnection(async (client) => {
        await client.query("INSERT INTO harness_probe (id, value) VALUES (1, 'ok')");
      });
      await harness.reset();
      const count = await harness.withConnection(async (client) => {
        const result = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM harness_probe",
        );
        return result.rows[0]?.count;
      });
      assert.equal(count, "0");
    } finally {
      await harness.close();
    }
  });
}
