import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDatabase, stopTestDatabase, type TestDatabase } from '../../test/db.js';
import { SettingsService, SettingsValidationError, deepMerge } from './service.js';

afterAll(stopTestDatabase);

describe('deepMerge', () => {
  it('merges nested objects and replaces arrays and scalars', () => {
    expect(deepMerge({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2] }, e: 2 })).toEqual({
      a: { b: 1, c: [2] },
      d: 1,
      e: 2,
    });
  });
});

describe('SettingsService', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await freshDatabase();
  });

  it('returns spec defaults on an empty database', async () => {
    const s = await new SettingsService(db.pool).get();
    expect(s.limits).toMatchObject({
      max_iterations: 4,
      per_run_usd: 25,
      per_day_usd: 200,
      timezone: 'UTC',
    });
    expect(s.mates.intake.model).toBe('claude-sonnet-5-5');
    expect(s.mates.implementer.model).toBe('claude-opus-5-5');
    expect(s.jira.comment_prefix).toBe('🤖 Mates:');
    expect(s.pricing).toEqual({});
    expect(s.scm.providers).toEqual([]);
  });

  it('persists partial updates and validates them', async () => {
    const svc = new SettingsService(db.pool);
    const { settings, ignored } = await svc.update(
      {
        limits: { max_iterations: 6 },
        scm: { providers: [{ id: 'gl', type: 'gitlab', base_url: 'https://gitlab.com' }] },
      },
      'ana@example.com',
    );
    expect(ignored).toEqual([]);
    expect(settings.limits.max_iterations).toBe(6);
    expect(settings.limits.per_run_usd).toBe(25);
    expect(settings.scm.providers[0]).toMatchObject({ id: 'gl', draft_mrs: true, labels: [] });

    const fresh = new SettingsService(db.pool);
    expect((await fresh.get()).limits.max_iterations).toBe(6);
    const row = await db.pool.query<{ updated_by: string }>(
      "SELECT updated_by FROM settings WHERE key = 'limits'",
    );
    expect(row.rows[0]?.updated_by).toBe('ana@example.com');

    await expect(svc.update({ limits: { max_iterations: 99 } }, 'x')).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
    await expect(svc.update({ nope: {} }, 'x')).rejects.toThrow(/unknown section/);
    await expect(svc.update('string', 'x')).rejects.toBeInstanceOf(SettingsValidationError);
    expect((await svc.get()).limits.max_iterations).toBe(6);
  });

  it('lets Helm values win and reports them as managed', async () => {
    const svc = new SettingsService(db.pool, {
      config: {
        maxIterations: 3,
        models: { implementer: 'claude-opus-5-5-helm' },
        budgets: { perDayUsd: 50 },
      },
      runner: { image: 'ghcr.io/x/runner:1' },
    });
    expect(svc.managedPaths()).toEqual(
      expect.arrayContaining([
        'limits.max_iterations',
        'mates.implementer.model',
        'limits.per_day_usd',
        'runner.image',
      ]),
    );
    const s = await svc.get();
    expect(s.limits.max_iterations).toBe(3);
    expect(s.mates.implementer.model).toBe('claude-opus-5-5-helm');
    expect(s.runner.image).toBe('ghcr.io/x/runner:1');

    const { settings, ignored } = await svc.update(
      { limits: { max_iterations: 8, per_run_usd: 30 } },
      'x',
    );
    expect(ignored).toEqual(['limits.max_iterations']);
    expect(settings.limits.max_iterations).toBe(3);
    expect(settings.limits.per_run_usd).toBe(30);
  });
});
