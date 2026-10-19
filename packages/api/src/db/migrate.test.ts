import { afterAll, describe, expect, it } from 'vitest';
import { freshDatabase, stopTestDatabase } from '../../test/db.js';
import { migrate, pendingMigrations, readMigrations } from './migrate.js';

afterAll(stopTestDatabase);

describe('migrate', () => {
  it('applies every file once and reports nothing pending afterwards', async () => {
    const db = await freshDatabase();
    try {
      const names = (await readMigrations()).map((m) => m.name);
      expect(names.length).toBeGreaterThan(0);
      expect(await pendingMigrations(db.pool)).toEqual([]);
      expect(await migrate(db.pool)).toEqual([]);
      const rows = await db.pool.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name',
      );
      expect(rows.rows.map((r) => r.name)).toEqual(names);
    } finally {
      await db.close();
    }
  });

  it('rolls back a failing migration and leaves it pending', async () => {
    const db = await freshDatabase();
    try {
      const bad = { name: '9999_bad.sql', sql: 'CREATE TABLE t_ok (id int); SELECT nope;' };
      await expect(migrate(db.pool, [bad])).rejects.toThrow(/9999_bad/);
      const exists = await db.pool.query<{ r: string | null }>(`SELECT to_regclass('t_ok') AS r`);
      expect(exists.rows[0]?.r).toBeNull();
    } finally {
      await db.close();
    }
  });
});
