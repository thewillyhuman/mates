import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';

/**
 * Forward-only SQL migrations (decision 0002).
 *
 * Files in `migrations/` are named `NNNN_description.sql` and applied in
 * lexical order, each in its own transaction, under a session advisory lock
 * so two API replicas starting at once cannot interleave. Applied names are
 * recorded in `schema_migrations`.
 */

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

/** Arbitrary constant; must be the same in every process touching this DB. */
const LOCK_KEY = 0x6d617465; // "mate"

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

export async function readMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (name) => ({ name, sql: await readFile(path.join(dir, name), 'utf8') })),
  );
}

/** Applies every migration not yet recorded. Returns the names applied. */
export async function migrate(pool: Pool, migrations?: Migration[]): Promise<string[]> {
  const all = migrations ?? (await readMigrations());
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (r) => r.name,
      ),
    );
    for (const m of all) {
      if (done.has(m.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(m.name);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}

/** Names of migrations on disk that are not recorded in the database. */
export async function pendingMigrations(pool: Pool): Promise<string[]> {
  const all = await readMigrations();
  const exists = await pool.query<{ ok: boolean }>(
    `SELECT to_regclass('schema_migrations') IS NOT NULL AS ok`,
  );
  if (!exists.rows[0]?.ok) return all.map((m) => m.name);
  const done = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
      (r) => r.name,
    ),
  );
  return all.filter((m) => !done.has(m.name)).map((m) => m.name);
}
