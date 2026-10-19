import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDatabase, stopTestDatabase, type TestDatabase } from '../test/db.js';
import { createLogger } from './logger.js';
import { Retention } from './retention.js';
import { SettingsService } from './settings/service.js';

afterAll(stopTestDatabase);

describe('Retention', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await freshDatabase();
  });

  it('drops old transcripts and old finished runs, keeps the rest', async () => {
    const t = await db.pool.query<{ id: string }>(
      `INSERT INTO tickets (external_key, title) VALUES ('API-1', 'x') RETURNING id`,
    );
    const old = await db.pool.query<{ id: string }>(
      `INSERT INTO runs (ticket_id, status, max_iterations, created_by, created_at, finished_at) VALUES ($1, 'done', 4, 't', now() - interval '400 days', now() - interval '399 days') RETURNING id`,
      [t.rows[0]!.id],
    );
    const t2 = await db.pool.query<{ id: string }>(
      `INSERT INTO tickets (external_key, title) VALUES ('API-2', 'y') RETURNING id`,
    );
    const recent = await db.pool.query<{ id: string }>(
      `INSERT INTO runs (ticket_id, status, max_iterations, created_by, created_at, finished_at) VALUES ($1, 'done', 4, 't', now() - interval '2 days', now() - interval '1 day') RETURNING id`,
      [t2.rows[0]!.id],
    );
    for (const [runId, age] of [
      [old.rows[0]!.id, '20 days'],
      [recent.rows[0]!.id, '20 days'],
      [recent.rows[0]!.id, '1 day'],
    ] as const) {
      await db.pool.query(
        `INSERT INTO blobs (run_id, kind, content_type, size_bytes, data, created_at) VALUES ($1, 'transcript', 'application/gzip', 1, '\\x00', now() - $2::interval)`,
        [runId, age],
      );
    }
    await db.pool.query(
      `INSERT INTO blobs (run_id, kind, content_type, size_bytes, data, created_at) VALUES ($1, 'diff', 'text/x-diff', 1, '\\x00', now() - interval '20 days')`,
      [recent.rows[0]!.id],
    );
    await db.pool.query(
      `INSERT INTO events (run_id, type, payload) VALUES ($1, 'run.created', '{}')`,
      [old.rows[0]!.id],
    );

    const settings = new SettingsService(db.pool);
    const result = await new Retention({
      db: db.pool,
      settings,
      log: createLogger('silent'),
    }).run();
    expect(result).toEqual({ transcripts: 2, runs: 1 });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM runs')).rows[0]).toEqual({ n: 1 });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM events')).rows[0]).toEqual({
      n: 0,
    });
    const blobs = await db.pool.query<{ kind: string }>('SELECT kind FROM blobs ORDER BY kind');
    expect(blobs.rows.map((b) => b.kind)).toEqual(['diff', 'transcript']);
  });
});
