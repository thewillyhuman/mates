import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packageOf } from '../src/team-context/service.test.js';
import { stopTestDatabase } from './db.js';
import { testApp, type TestApp } from './harness.js';

describe('settings API', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await testApp({ helm: { config: { maxIterations: 3 } } });
  });
  afterAll(async () => {
    await t.close();
    await stopTestDatabase();
  });

  it('is admin-only and reports Helm-managed paths', async () => {
    expect(
      (await t.app.inject({ url: '/api/settings', headers: t.as('operator') })).statusCode,
    ).toBe(403);
    const res = await t.app.inject({ url: '/api/settings', headers: t.as('admin') });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      settings: { limits: { max_iterations: number } };
      managed: string[];
    }>();
    expect(body.settings.limits.max_iterations).toBe(3);
    expect(body.managed).toContain('limits.max_iterations');
  });

  it('updates settings, ignoring Helm-managed keys, and rejects invalid values', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        limits: { max_iterations: 9, per_run_usd: 40 },
        jira: { base_url: 'https://jira.example.com' },
      },
      headers: t.as('admin'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      settings: {
        limits: { max_iterations: number; per_run_usd: number };
        jira: { base_url: string };
      };
      ignored: string[];
    }>();
    expect(body.settings.limits).toMatchObject({ max_iterations: 3, per_run_usd: 40 });
    expect(body.settings.jira.base_url).toBe('https://jira.example.com');
    expect(body.ignored).toEqual(['limits.max_iterations']);

    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { limits: { per_run_usd: -1 } },
      headers: t.as('admin'),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe('invalid_settings');
  });

  it('stores credentials in the secret and exposes only their status', async () => {
    const before = await t.app.inject({
      url: '/api/settings/credentials/jira_token',
      headers: t.as('admin'),
    });
    expect(before.json()).toMatchObject({ name: 'jira_token', set: false, read_only: false });
    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/settings/credentials/jira_token',
      payload: { value: 'super-secret' },
      headers: t.as('admin'),
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ set: true });
    expect(JSON.stringify(put.json())).not.toContain('super-secret');
    expect((await t.secrets.get('mates-credentials'))?.jira_token).toBe('super-secret');
    expect(
      (await t.app.inject({ url: '/api/settings/credentials/nope', headers: t.as('admin') }))
        .statusCode,
    ).toBe(400);
    const del = await t.app.inject({
      method: 'DELETE',
      url: '/api/settings/credentials/jira_token',
      headers: t.as('admin'),
    });
    expect(del.statusCode).toBe(204);
    expect(
      (
        await t.app.inject({ url: '/api/settings/credentials/jira_token', headers: t.as('admin') })
      ).json(),
    ).toMatchObject({ set: false });
  });

  it('uploads a team-context package, validates it and lists versions', async () => {
    await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        scm: { providers: [{ id: 'gitea', type: 'gitea', base_url: 'http://gitea:3000' }] },
      },
      headers: t.as('admin'),
    });
    const good = await packageOf({
      'mates.yaml':
        'version: 1\nteam:\n  name: T\n  conventions: docs/c.md\nrepos:\n  - id: a\n    scm: gitea\n    project: x/a\n',
      'docs/c.md': '#',
    });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/settings/team-context',
      payload: good,
      headers: { ...t.as('admin'), 'content-type': 'application/gzip' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ version: 1, active: true, errors: [] });

    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/settings/team-context',
      payload: Buffer.from('nope'),
      headers: { ...t.as('admin'), 'content-type': 'application/gzip' },
    });
    expect(bad.statusCode).toBe(400);

    const list = await t.app.inject({ url: '/api/settings/team-context', headers: t.as('viewer') });
    expect(list.json<{ active: { version: number } | null; versions: unknown[] }>()).toMatchObject({
      active: { version: 1 },
    });
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/settings/team-context',
          payload: good,
          headers: { ...t.as('viewer'), 'content-type': 'application/gzip' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('serves and overrides prompt templates with placeholder validation', async () => {
    const get = await t.app.inject({
      url: '/api/settings/prompts/implementer',
      headers: t.as('viewer'),
    });
    expect(get.json()).toMatchObject({ name: 'implementer', overridden: false });
    expect(get.json<{ template: string }>().template).toContain('# Task — {{ticket.key}}');

    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/settings/prompts/implementer',
      payload: { template: 'no placeholders' },
      headers: t.as('admin'),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { message: string } }>().error.message).toContain('{{ticket.key}}');

    const ok = await t.app.inject({
      method: 'PUT',
      url: '/api/settings/prompts/implementer',
      payload: { template: 'custom {{ticket.key}} {{branch}} {{iteration}}' },
      headers: t.as('admin'),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      overridden: true,
      template: 'custom {{ticket.key}} {{branch}} {{iteration}}',
    });

    const reset = await t.app.inject({
      method: 'PUT',
      url: '/api/settings/prompts/implementer',
      payload: { template: null },
      headers: t.as('admin'),
    });
    expect(reset.json()).toMatchObject({ overridden: false });
    // The reset is persisted: a fresh read shows the default again.
    const after = await t.app.inject({
      url: '/api/settings/prompts/implementer',
      headers: t.as('viewer'),
    });
    expect(after.json()).toMatchObject({ overridden: false });
    expect(after.json<{ template: string }>().template).toContain('# Task — {{ticket.key}}');
  });
});
