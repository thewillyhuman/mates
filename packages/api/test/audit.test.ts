import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopTestDatabase } from './db.js';
import { testApp, type TestApp } from './harness.js';

describe('audit log', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await testApp();
  });
  afterAll(async () => {
    await t.close();
    await stopTestDatabase();
  });

  it('records mutating actions with their actor and serves them newest first to admins', async () => {
    await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { limits: { per_run_usd: 30 } },
      headers: t.as('admin'),
    });
    await t.app.inject({
      method: 'PUT',
      url: '/api/settings/credentials/jira_token',
      payload: { value: 'super-secret' },
      headers: t.as('admin'),
    });
    const run = await t.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { ticket_key: 'API-700' },
      headers: t.as('operator'),
    });
    const id = run.json<{ id: string }>().id;
    await t.app.inject({ method: 'POST', url: `/api/runs/${id}/pause`, headers: t.as('operator') });
    await t.app.inject({
      method: 'POST',
      url: `/api/runs/${id}/nudges`,
      payload: { text: 'hi' },
      headers: t.as('operator'),
    });

    expect(
      (await t.app.inject({ url: '/api/settings/audit', headers: t.as('operator') })).statusCode,
    ).toBe(403);
    const res = await t.app.inject({ url: '/api/settings/audit', headers: t.as('admin') });
    expect(res.statusCode).toBe(200);
    const entries = res.json<{
      entries: {
        actor: string;
        action: string;
        target: string;
        details: Record<string, unknown>;
      }[];
    }>().entries;
    expect(entries.map((e) => e.action)).toEqual([
      'audit.run.nudge',
      'audit.run.pause',
      'audit.run.create',
      'audit.credential.set',
      'audit.settings.update',
    ]);
    expect(entries[2]).toMatchObject({
      actor: 'operator@example.com',
      target: id,
      details: { ticket: 'API-700', created: true },
    });
    expect(entries[3]).toMatchObject({ actor: 'admin@example.com', target: 'jira_token' });
    expect(JSON.stringify(entries)).not.toContain('super-secret');

    const page = await t.app.inject({
      url: `/api/settings/audit?before=${entries[1]!.action ? 2 : 0}&limit=1`,
      headers: t.as('admin'),
    });
    expect(page.json<{ entries: unknown[] }>().entries).toHaveLength(1);
  });
});
