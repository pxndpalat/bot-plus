import { Pool, type PoolClient, type QueryResult } from "pg";

const safeLocalHosts = new Set(["localhost", "127.0.0.1", "::1"]);
let harnessSequence = 0;

export interface PostgresMigrationContext {
  readonly client: PoolClient;
  readonly schema: string;
}

export type PostgresMigration = (context: PostgresMigrationContext) => Promise<void>;

export interface PostgresHarnessOptions {
  readonly databaseUrl: string;
  readonly schemaName?: string;
  readonly migrate?: PostgresMigration;
  readonly tables?: readonly string[];
  readonly maxConnections?: number;
}

export interface PostgresTestHarness {
  readonly databaseUrl: string;
  readonly schema: string;
  readonly pool: Pool;
  runMigrations(): Promise<void>;
  reset(): Promise<void>;
  withConnection<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Only local, explicitly test-named databases are accepted. In particular,
 * DATABASE_URL is never used implicitly: callers must opt in with
 * TEST_DATABASE_URL or pass an equivalent explicit URL.
 */
export function assertSafeTestDatabaseUrl(databaseUrl: string): string {
  if (!databaseUrl.trim())
    throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must use postgres:// or postgresql://");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!safeLocalHosts.has(hostname)) {
    throw new Error("Refusing PostgreSQL integration tests against a non-local host");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/(^|[-_])test([_-]|$)/i.test(databaseName) && !/^test$/i.test(databaseName)) {
    throw new Error("Refusing PostgreSQL integration tests unless database name contains 'test'");
  }
  return parsed.toString();
}

export function requireTestDatabaseUrl(value?: string): string {
  const candidate = arguments.length === 0 ? process.env.TEST_DATABASE_URL : value;
  if (candidate === undefined) {
    throw new Error("TEST_DATABASE_URL is not set; refusing to use DATABASE_URL for tests");
  }
  return assertSafeTestDatabaseUrl(candidate);
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier))
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  return `"${identifier}"`;
}

function createSchemaName(): string {
  harnessSequence += 1;
  return `test_${process.pid}_${harnessSequence}`;
}

export function createPostgresTestHarness(options: PostgresHarnessOptions): PostgresTestHarness {
  const databaseUrl = assertSafeTestDatabaseUrl(options.databaseUrl);
  const schema = options.schemaName ?? createSchemaName();
  quoteIdentifier(schema);
  const pool = new Pool({ connectionString: databaseUrl, max: options.maxConnections ?? 4 });

  const setSearchPath = async (client: PoolClient): Promise<void> => {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
  };

  return {
    databaseUrl,
    schema,
    pool,
    runMigrations: async () => {
      await usingConnection(pool, async (client) => {
        await setSearchPath(client);
        if (options.migrate) await options.migrate({ client, schema });
      });
    },
    reset: async () => {
      await usingConnection(pool, async (client) => {
        await setSearchPath(client);
        const result = await client.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
          [schema],
        );
        const tables = options.tables ?? result.rows.map((row) => row.tablename);
        if (tables.length > 0) {
          const qualified = tables
            .map((table) => `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`)
            .join(", ");
          await client.query(`TRUNCATE TABLE ${qualified} RESTART IDENTITY CASCADE`);
        }
      });
    },
    withConnection: async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
      return usingConnection(pool, async (client) => {
        await setSearchPath(client);
        return work(client);
      });
    },
    close: async () => {
      await usingConnection(pool, async (client) => {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      });
      await pool.end();
    },
  };
}

async function usingConnection<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

export type { QueryResult };
