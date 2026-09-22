import { Pool } from "pg";
import { CompiledQuery, Kysely, PostgresDialect } from "kysely";
import {
  Migrator,
  NO_MIGRATIONS,
  type MigrationProvider,
  type MigrationResultSet,
} from "kysely/migration";
import { MIGRATION_NAME, migration } from "./migrations/index.ts";
import type { Database } from "./types.ts";

export * from "./types.ts";
export { MIGRATION_NAME } from "./migrations/index.ts";

const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return { [MIGRATION_NAME]: migration };
  },
};

export function createDatabase(connectionString = process.env.DATABASE_URL): {
  db: Kysely<Database>;
  pool: Pool;
} {
  if (!connectionString) throw new Error("DATABASE_URL is required to connect to PostgreSQL");
  const pool = new Pool({ connectionString });
  return {
    db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
    pool,
  };
}

function assertMigrationSuccess(result: MigrationResultSet): MigrationResultSet {
  if (result.error) throw result.error;
  return result;
}

export async function migrateToLatest(db: Kysely<Database>): Promise<MigrationResultSet> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  return assertMigrationSuccess(await migrator.migrateToLatest());
}

/** Convenience entry point for a release command such as `bun -e`. */
export async function runMigrationsFromEnvironment(
  connectionString = process.env.DATABASE_URL,
): Promise<MigrationResultSet> {
  const { db } = createDatabase(connectionString);
  try {
    return await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
}

export async function rollbackLastMigration(db: Kysely<Database>): Promise<MigrationResultSet> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  return assertMigrationSuccess(await migrator.migrateDown());
}

/**
 * Drop all migrations and apply them again. Intended for isolated test databases.
 * Production callers should use migrateToLatest/rollbackLastMigration instead.
 */
export async function rebuildDatabase(db: Kysely<Database>): Promise<MigrationResultSet> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  assertMigrationSuccess(await migrator.migrateTo(NO_MIGRATIONS));
  return assertMigrationSuccess(await migrator.migrateToLatest());
}

export async function getMigrationStatus(db: Kysely<Database>): Promise<{
  applied: readonly string[];
  latest: string;
  ready: boolean;
}> {
  try {
    const result = await db.executeQuery<{ name: string }>(
      CompiledQuery.raw("SELECT name FROM kysely_migration ORDER BY name ASC"),
    );
    const applied = result.rows.map((row) => row.name);
    return { applied, latest: MIGRATION_NAME, ready: applied.includes(MIGRATION_NAME) };
  } catch {
    return { applied: [], latest: MIGRATION_NAME, ready: false };
  }
}
