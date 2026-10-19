import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { freshDatabase, stopTestDatabase, type TestDatabase } from './db.js';
import { buildApp, type AppDeps } from '../src/http/app.js';
import { Integrations } from '../src/integrations.js';
import { FakeJobsClient } from '../src/kubernetes/jobs.js';
import { createLogger } from '../src/logger.js';
import { MergeRequests } from '../src/orchestrator/merge-requests.js';
import { Orchestrator } from '../src/orchestrator/reconciler.js';
import { InvocationSpawner } from '../src/orchestrator/spawner.js';
import { TrackerSync } from '../src/orchestrator/tracker-sync.js';
import { EventBus } from '../src/runs/bus.js';
import { RunStarter } from '../src/runs/starter.js';
import { InMemorySecretStore } from '../src/secrets/store.js';
import { CredentialStore } from '../src/settings/credentials.js';
import { SettingsService } from '../src/settings/service.js';
import { Bootstrap } from '../src/setup/bootstrap.js';
import { TeamContextService } from '../src/team-context/service.js';

type Cookies = { cookies: { name: string; value: string }[] };

/** Cookies as the browser would send them back. */
function cookieHeader(res: Cookies): string {
  return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}
function csrf(res: Cookies): string {
  return res.cookies.find((c) => c.name === 'mates_csrf')!.value;
}

/** The non-auth dependencies of buildApp, for tests that only need setup + auth. */
function stubDeps(db: TestDatabase, bootstrap: Bootstrap): Omit<AppDeps, 'uiDir' | 'kubernetes'> {
  const log = createLogger('silent');
  const bus = new EventBus();
  const secrets = new InMemorySecretStore();
  const settings = new SettingsService(db.pool);
  const teamContext = new TeamContextService(db.pool, async () => []);
  const spawner = new InvocationSpawner({
    db: db.pool,
    bus,
    jobs: new FakeJobsClient(),
    log,
    internalKey: 'k'.repeat(32),
    release: 'mates',
    namespace: 'mates',
    apiInternalUrl: 'http://api',
    fakeClaude: true,
    helm: {},
    defaultRunnerImage: 'img',
  });
  const credentials = new CredentialStore(secrets, db.pool, 'mates', false);
  const integrations = new Integrations(settings, credentials, 'http://mates.test');
  return {
    db: db.pool,
    log,
    bootstrap,
    bus,
    internalKey: 'k'.repeat(32),
    settings,
    integrations,
    starter: new RunStarter({ db: db.pool, bus, settings, integrations, log }),
    credentials,
    teamContext,
    orchestrator: new Orchestrator({
      db: db.pool,
      bus,
      log,
      settings,
      teamContext,
      spawner,
      mergeRequests: new MergeRequests({
        integrations,
        log,
        publicUrl: 'http://mates.test',
        version: 'test',
      }),
      trackerSync: new TrackerSync({ integrations, log, publicUrl: 'http://mates.test' }),
    }),
    trackerSync: new TrackerSync({ integrations, log, publicUrl: 'http://mates.test' }),
    fakeClaude: true,
    secureCookies: false,
    version: 'test',
  };
}

describe('setup and auth over HTTP', () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let bootstrap: Bootstrap;

  beforeAll(async () => {
    db = await freshDatabase();
    bootstrap = new Bootstrap({
      db: db.pool,
      secrets: new InMemorySecretStore(),
      release: 'mates',
      log: createLogger('silent'),
    });
    app = await buildApp(stubDeps(db, bootstrap));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await db.close();
    await stopTestDatabase();
  });

  it('is healthy and ready', async () => {
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    const ready = await app.inject({ url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', checks: { database: { ok: true } } });
  });

  it('serves an OpenAPI 3.1 document', async () => {
    const res = await app.inject({ url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ openapi: '3.1.0' });
    expect(res.json<{ paths: object }>().paths).toHaveProperty('/api/setup/bootstrap');
  });

  it('reports that setup is required, then completes it and logs the admin in', async () => {
    expect((await app.inject({ url: '/api/setup/status' })).json()).toEqual({
      setupRequired: true,
    });
    const token = (await bootstrap.ensureToken())!;

    const bad = await app.inject({
      method: 'POST',
      url: '/api/setup/bootstrap',
      payload: { token: 'wrong', email: 'ana@example.com', password: 'hunter2hunter2' },
    });
    expect(bad.statusCode).toBe(401);

    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/bootstrap',
      payload: { token, email: 'ana@example.com', password: 'hunter2hunter2' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: 'ana@example.com', role: 'admin' });
    const session = res.cookies.find((c) => c.name === 'mates_session')!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe('Lax');

    const me = await app.inject({ url: '/api/auth/me', headers: { cookie: cookieHeader(res) } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'ana@example.com', role: 'admin' });

    expect((await app.inject({ url: '/api/setup/status' })).json()).toEqual({
      setupRequired: false,
    });
    const again = await app.inject({
      method: 'POST',
      url: '/api/setup/bootstrap',
      payload: { token, email: 'x@example.com', password: 'hunter2hunter2' },
    });
    expect(again.statusCode).toBe(410);
  });

  it('rejects a mutating request without the CSRF header', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ana@example.com', password: 'hunter2hunter2' },
    });
    expect(login.statusCode).toBe(200);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: cookieHeader(login) },
    });
    expect(noCsrf.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: cookieHeader(login), 'x-csrf-token': csrf(login) },
    });
    expect(ok.statusCode).toBe(204);
    const me = await app.inject({ url: '/api/auth/me', headers: { cookie: cookieHeader(login) } });
    expect(me.statusCode).toBe(401);
  });

  it('rejects wrong credentials and anonymous access', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ana@example.com', password: 'nope' },
    });
    expect(bad.statusCode).toBe(401);
    expect((await app.inject({ url: '/api/auth/me' })).statusCode).toBe(401);
  });

  it('serves the SPA with a fallback to index.html, but JSON 404s under /api', async () => {
    const uiDir = await mkdtemp(path.join(tmpdir(), 'mates-ui-'));
    await writeFile(path.join(uiDir, 'index.html'), '<!doctype html><title>Mates</title>');
    const ui = await buildApp({ ...stubDeps(db, bootstrap), uiDir });
    try {
      expect((await ui.inject({ url: '/' })).body).toContain('<title>Mates</title>');
      expect((await ui.inject({ url: '/runs/abc' })).body).toContain('<title>Mates</title>');
      const api = await ui.inject({ url: '/api/nope' });
      expect(api.statusCode).toBe(404);
      expect(api.json<{ error: { code: string } }>().error.code).toBe('not_found');
    } finally {
      await ui.close();
    }
  });

  it('answers 404 as JSON everywhere when no UI is built', async () => {
    const res = await app.inject({ url: '/runs/abc' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found');
  });

  it('answers 400 with details on invalid bodies', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation');
  });
});
