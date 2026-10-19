import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from '../src/db/migrate.js';
import { createPool, type Pool } from '../src/db/pool.js';

/**
 * Shared Postgres for integration tests. One container per test file; each
 * `freshDatabase()` call creates a new database inside it so tests do not
 * share state. Set `MATES_TEST_DATABASE_URL` to use an existing server
 * (CI service container) instead of starting one.
 */
export interface TestDatabase {
  readonly pool: Pool;
  readonly url: string;
  close(): Promise<void>;
}

let container: StartedPostgreSqlContainer | undefined;
let adminUrl: string | undefined;
const open = new Set<Pool>();

async function serverUrl(): Promise<string> {
  if (adminUrl) return adminUrl;
  const fromEnv = process.env.MATES_TEST_DATABASE_URL;
  if (fromEnv) {
    adminUrl = fromEnv;
    return adminUrl;
  }
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  adminUrl = container.getConnectionUri();
  return adminUrl;
}

export async function freshDatabase(): Promise<TestDatabase> {
  const base = new URL(await serverUrl());
  const name = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = createPool(base.toString());
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  open.add(pool);
  await migrate(pool);
  return {
    pool,
    url: url.toString(),
    close: async () => {
      open.delete(pool);
      await pool.end();
    },
  };
}

/** Ends every pool still open, then stops the container (if we started one). */
export async function stopTestDatabase(): Promise<void> {
  await Promise.all([...open].map((p) => p.end().catch(() => undefined)));
  open.clear();
  if (container) {
    await container.stop();
    container = undefined;
    adminUrl = undefined;
  }
}
