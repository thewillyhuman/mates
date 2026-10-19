import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopTestDatabase } from './db.js';
import { testApp, type TestApp } from './harness.js';
import { configureLoop, loopDriver } from './loop-driver.js';

describe('tickets, users and api tokens', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await testApp();
    await configureLoop(t);
    const { trigger, play, reconcile } = loopDriver(t);
    const run = await trigger('API-601', 'Done ticket');
    await reconcile(run.id);
    await play(run.id, 'intake_implementable');
    await play(run.id, 'impl_iter1_green');
    await play(run.id, 'review_approve');
    const queued = await trigger('WEB-602', 'Queued ticket');
    void queued;
  });
  afterAll(async () => {
    await t.close();
    await stopTestDatabase();
  });

  it('lists tickets with their latest run and filters them', async () => {
    const all = await t.app.inject({ url: '/api/tickets', headers: t.as('viewer') });
    expect(all.statusCode).toBe(200);
    const tickets = all.json<{
      tickets: {
        key: string;
        runs: number;
        latestRun: { stage: string; costUsd: number; mrUrl: string | null } | null;
      }[];
    }>().tickets;
    expect(tickets.map((x) => x.key)).toEqual(['WEB-602', 'API-601']);
    const done = tickets.find((x) => x.key === 'API-601')!;
    expect(done.runs).toBe(1);
    expect(done.latestRun).toMatchObject({ stage: 'done' });
    expect(done.latestRun!.costUsd).toBeCloseTo(0.0412 + 1.8734 + 0.8117, 3);
    expect(done.latestRun!.mrUrl).toContain('/merge_requests/');

    const byProject = await t.app.inject({
      url: '/api/tickets?project=WEB',
      headers: t.as('viewer'),
    });
    expect(byProject.json<{ tickets: { key: string }[] }>().tickets.map((x) => x.key)).toEqual([
      'WEB-602',
    ]);
    const byStage = await t.app.inject({ url: '/api/tickets?stage=done', headers: t.as('viewer') });
    expect(byStage.json<{ tickets: { key: string }[] }>().tickets.map((x) => x.key)).toEqual([
      'API-601',
    ]);
    const byQuery = await t.app.inject({ url: '/api/tickets?q=queued', headers: t.as('viewer') });
    expect(byQuery.json<{ tickets: { key: string }[] }>().tickets.map((x) => x.key)).toEqual([
      'WEB-602',
    ]);
  });

  it('exports CSV and serves a ticket with its runs', async () => {
    const csv = await t.app.inject({ url: '/api/tickets.csv', headers: t.as('viewer') });
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.trim().split('\n');
    expect(lines[0]).toBe(
      'key,title,project,repo,runs,latest_stage,iterations,cost_usd,mr_url,mr_state,created_at,finished_at',
    );
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.startsWith('API-601'))).toContain(',done,1/4,');

    const one = await t.app.inject({ url: '/api/tickets/API-601', headers: t.as('viewer') });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({
      ticket: { key: 'API-601', repoId: 'webhook-service' },
      runs: [{ stage: 'done' }],
    });
    expect(
      (await t.app.inject({ url: '/api/tickets/NOPE-1', headers: t.as('viewer') })).statusCode,
    ).toBe(404);
  });

  it('manages users as admin with self-protection', async () => {
    expect((await t.app.inject({ url: '/api/users', headers: t.as('operator') })).statusCode).toBe(
      403,
    );
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/users',
      payload: {
        email: 'new@example.com',
        displayName: 'New',
        role: 'viewer',
        password: 'password-for-tests',
      },
      headers: t.as('admin'),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/users',
          payload: {
            email: 'new@example.com',
            displayName: 'Dup',
            role: 'viewer',
            password: 'password-for-tests',
          },
          headers: t.as('admin'),
        })
      ).statusCode,
    ).toBe(409);
    const promoted = await t.app.inject({
      method: 'PUT',
      url: `/api/users/${id}`,
      payload: { role: 'operator' },
      headers: t.as('admin'),
    });
    expect(promoted.json()).toMatchObject({ role: 'operator' });
    const list = await t.app.inject({ url: '/api/users', headers: t.as('admin') });
    expect(list.json<{ users: { email: string }[] }>().users.map((u) => u.email)).toContain(
      'new@example.com',
    );
    const me = (await t.app.inject({ url: '/api/auth/me', headers: t.as('admin') })).json<{
      id: string;
    }>();
    expect(
      (
        await t.app.inject({
          method: 'PUT',
          url: `/api/users/${me.id}`,
          payload: { role: 'viewer' },
          headers: t.as('admin'),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/users/${me.id}`, headers: t.as('admin') }))
        .statusCode,
    ).toBe(400);
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/api/users/${id}`, headers: t.as('admin') }))
        .statusCode,
    ).toBe(204);
  });

  it('issues personal api tokens that authenticate without a session or csrf', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/api-tokens',
      payload: { name: 'ci' },
      headers: t.as('operator'),
    });
    expect(created.statusCode).toBe(201);
    const { token, id } = created.json<{ token: string; id: string }>();
    expect(token.startsWith('mates_')).toBe(true);

    const me = await t.app.inject({
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json()).toMatchObject({ email: 'operator@example.com' });
    const mutate = await t.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { ticket_key: 'API-603' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mutate.statusCode).toBe(201);
    expect(
      (await t.app.inject({ url: '/api/auth/me', headers: { authorization: 'Bearer mates_nope' } }))
        .statusCode,
    ).toBe(401);

    const mine = await t.app.inject({ url: '/api/api-tokens', headers: t.as('operator') });
    expect(
      mine.json<{ tokens: { id: string; lastUsedAt: string | null }[] }>().tokens.map((x) => x.id),
    ).toEqual([id]);
    expect(
      mine.json<{ tokens: { lastUsedAt: string | null }[] }>().tokens[0]!.lastUsedAt,
    ).not.toBeNull();
    expect(
      (
        await t.app.inject({
          method: 'DELETE',
          url: `/api/api-tokens/${id}`,
          headers: t.as('viewer'),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'DELETE',
          url: `/api/api-tokens/${id}`,
          headers: t.as('operator'),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await t.app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } }))
        .statusCode,
    ).toBe(401);
  });

  it('runs the anthropic test through the credential test endpoint', async () => {
    await t.credentials.set('anthropic_api_key', 'sk-ant-test', 'admin@example.com');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/settings/credentials/anthropic_api_key/test',
      headers: t.as('admin'),
    });
    expect(res.json()).toMatchObject({ ok: true, details: { model: 'fake' } });
    expect(
      (
        await t.app.inject({
          url: '/api/settings/credentials/anthropic_api_key',
          headers: t.as('admin'),
        })
      ).json(),
    ).toMatchObject({ set: true });
  });
});
