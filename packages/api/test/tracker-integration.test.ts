import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopTestDatabase } from './db.js';
import { testApp, type TestApp } from './harness.js';

type Detail = {
  id: string;
  ticket: { key: string; title: string; url: string | null };
  projection: { stage: string; blockedReason: string | null };
};

describe('tracker integration', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await testApp();
    await t.settings.update(
      { jira: { trigger: { kind: 'assignee', value: 'mates' } } },
      'admin@example.com',
    );
    t.tracker.seed('API-198', 'Retry policy for webhook delivery', {
      description: 'Cap retries.',
      acceptance_criteria: 'AC1',
      comments: [],
    });
    t.tracker.seed('API-204', 'Paginate /orders response');
  });
  afterAll(async () => {
    await t.close();
    await stopTestDatabase();
  });

  const detail = async (id: string) =>
    (await t.app.inject({ url: `/api/runs/${id}`, headers: t.as('viewer') })).json<Detail>();

  it('enriches a manually triggered run from the tracker', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { ticket_key: 'API-198' },
      headers: t.as('operator'),
    });
    expect(res.statusCode).toBe(201);
    const d = res.json<Detail>();
    expect(d.ticket).toMatchObject({
      key: 'API-198',
      title: 'Retry policy for webhook delivery',
      url: 'https://jira.example.com/browse/API-198',
    });
    const row = await t.db.pool.query<{ details: { description: string } }>(
      "SELECT details FROM tickets WHERE external_key = 'API-198'",
    );
    expect(row.rows[0]?.details.description).toBe('Cap retries.');
  });

  it('rejects webhooks without the secret and accepts matching issue updates once', async () => {
    const payload = [
      { type: 'issue_updated', key: 'API-204', id: 'id-API-204', matchesRule: true },
    ];
    const bad = await t.app.inject({
      method: 'POST',
      url: '/webhooks/jira',
      payload,
      headers: { 'x-mates-secret': 'wrong' },
    });
    expect(bad.statusCode).toBe(401);
    const ok = await t.app.inject({
      method: 'POST',
      url: '/webhooks/jira',
      payload,
      headers: { 'x-mates-secret': 'fake-secret' },
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toEqual({ events: 1, created: 1, requeued: 0 });
    const again = await t.app.inject({
      method: 'POST',
      url: '/webhooks/jira',
      payload,
      headers: { 'x-mates-secret': 'fake-secret' },
    });
    expect(again.json()).toEqual({ events: 1, created: 0, requeued: 0 });
    const board = await t.app.inject({ url: '/api/runs', headers: t.as('viewer') });
    const keys = board
      .json<{ runs: { ticket: { key: string }; createdAt: string }[] }>()
      .runs.map((r) => r.ticket.key);
    expect(keys).toContain('API-204');
    expect(keys.filter((k) => k === 'API-204')).toHaveLength(1);
  });

  it('ignores issue updates that do not match the rule', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/webhooks/jira',
      payload: [{ type: 'issue_updated', key: 'API-999', id: 'x', matchesRule: false }],
      headers: { 'x-mates-secret': 'fake-secret' },
    });
    expect(res.json()).toEqual({ events: 1, created: 0, requeued: 0 });
  });

  it('re-queues a run blocked on clarification when a human comments, not when Mates does', async () => {
    const id = (await t.app.inject({ url: '/api/runs', headers: t.as('viewer') }))
      .json<{ runs: { id: string; ticket: { key: string } }[] }>()
      .runs.find((r) => r.ticket.key === 'API-198')!.id;
    const { appendEvents } = await import('../src/runs/events.js');
    await appendEvents(t.db.pool, t.bus, id, [
      { type: 'run.stage_changed', payload: { from: 'queued', to: 'intake', reason: 'scheduled' } },
      {
        type: 'intake.needs_clarification',
        payload: { questions: ['Which tier?'], tracker_comment_id: 'c-1' },
      },
      {
        type: 'run.stage_changed',
        payload: { from: 'intake', to: 'blocked', reason: 'needs_clarification' },
      },
    ]);
    expect((await detail(id)).projection).toMatchObject({
      stage: 'blocked',
      blockedReason: 'needs_clarification',
    });

    const self = await t.app.inject({
      method: 'POST',
      url: '/webhooks/jira',
      payload: [
        {
          type: 'comment_created',
          key: 'API-198',
          id: 'id',
          commentId: '1',
          author: 'Mates',
          authorIsSelf: true,
          body: '🤖 Mates: question',
        },
      ],
      headers: { 'x-mates-secret': 'fake-secret' },
    });
    expect(self.json()).toMatchObject({ requeued: 0 });
    expect((await detail(id)).projection.stage).toBe('blocked');

    t.tracker.seed('API-198', 'Retry policy for webhook delivery', {
      comments: [{ id: '2', author: 'Ana', body: 'Free tier.', created_at: '' }],
    });
    const human = await t.app.inject({
      method: 'POST',
      url: '/webhooks/jira',
      payload: [
        {
          type: 'comment_created',
          key: 'API-198',
          id: 'id',
          commentId: '2',
          author: 'Ana',
          authorIsSelf: false,
          body: 'Free tier.',
        },
      ],
      headers: { 'x-mates-secret': 'fake-secret' },
    });
    expect(human.json()).toMatchObject({ requeued: 1 });
    expect((await detail(id)).projection.stage).toBe('queued');
    const row = await t.db.pool.query<{ details: { comments: unknown[] } }>(
      "SELECT details FROM tickets WHERE external_key = 'API-198'",
    );
    expect(row.rows[0]?.details.comments).toHaveLength(1);
  });

  it('polls the tracker: starts runs for triggered tickets and requeues on new comments', async () => {
    t.tracker.seed('API-300', 'Polled ticket');
    t.tracker.triggered = [
      { key: 'API-300', id: 'id-API-300', summary: 'Polled ticket', updated: '' },
      { key: 'API-204', id: 'id-API-204', summary: 'x', updated: '' },
    ];
    expect(await t.poller.tick()).toEqual({ created: 1, requeued: 0 });
    expect(await t.poller.tick()).toEqual({ created: 0, requeued: 0 });

    const runs = (await t.app.inject({ url: '/api/runs', headers: t.as('viewer') })).json<{
      runs: { id: string; ticket: { key: string } }[];
    }>().runs;
    const polled = runs.find((r) => r.ticket.key === 'API-300')!;
    const { appendEvents } = await import('../src/runs/events.js');
    await appendEvents(t.db.pool, t.bus, polled.id, [
      { type: 'run.stage_changed', payload: { from: 'queued', to: 'intake', reason: 'scheduled' } },
      {
        type: 'intake.needs_clarification',
        payload: { questions: ['?'], tracker_comment_id: null },
      },
      {
        type: 'run.stage_changed',
        payload: { from: 'intake', to: 'blocked', reason: 'needs_clarification' },
      },
    ]);
    t.tracker.seed('API-300', 'Polled ticket', {
      comments: [{ id: 'm1', author: 'Mates', body: '🤖 Mates: ?', created_at: '' }],
    });
    expect(await t.poller.tick()).toEqual({ created: 0, requeued: 0 });
    t.tracker.seed('API-300', 'Polled ticket', {
      comments: [
        { id: 'm1', author: 'Mates', body: '🤖 Mates: ?', created_at: '' },
        { id: 'h1', author: 'Ana', body: 'answer', created_at: '' },
      ],
    });
    expect(await t.poller.tick()).toEqual({ created: 0, requeued: 1 });
    expect((await detail(polled.id)).projection.stage).toBe('queued');
  });

  it('runs the credential tests through the adapters', async () => {
    const jira = await t.app.inject({
      method: 'POST',
      url: '/api/settings/credentials/jira_token/test',
      headers: t.as('admin'),
    });
    expect(jira.statusCode).toBe(200);
    expect(jira.json()).toMatchObject({ ok: true, message: 'fake tracker' });
    const scm = await t.app.inject({
      method: 'POST',
      url: '/api/settings/credentials/scm_gitlab_token/test',
      headers: t.as('admin'),
    });
    expect(scm.json()).toMatchObject({ ok: true, details: { repos: ['example/repo'] } });
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/settings/credentials/scm_nope_token/test',
      headers: t.as('admin'),
    });
    expect(unknown.json()).toMatchObject({
      ok: false,
      message: expect.stringContaining('configure provider "nope"') as string,
    });
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/settings/credentials/jira_token/test',
          headers: t.as('operator'),
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('without a tracker', () => {
  it('creates placeholder tickets and refuses webhooks', async () => {
    const bare = await testApp({ integrations: { tracker: undefined, scm: {} } });
    try {
      const res = await bare.app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { ticket_key: 'XY-1' },
        headers: bare.as('operator'),
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json<Detail>().ticket).toMatchObject({ key: 'XY-1', title: 'XY-1', url: null });
      expect(
        (await bare.app.inject({ method: 'POST', url: '/webhooks/jira', payload: {} })).statusCode,
      ).toBe(503);
      expect(await bare.poller.tick()).toEqual({ created: 0, requeued: 0 });
    } finally {
      await bare.close();
    }
  });
});
