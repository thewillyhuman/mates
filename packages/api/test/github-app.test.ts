import { teamManifestSchema } from '@mates/core';
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Integrations } from '../src/integrations.js';
import { createLogger } from '../src/logger.js';
import { InvocationSpawner, tokenSecretName } from '../src/orchestrator/spawner.js';
import { jobName, type Invocation } from '../src/runs/invocations.js';
import { stopTestDatabase } from './db.js';
import { INTERNAL_KEY, testApp, type TestApp } from './harness.js';

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** Answers GitHub's installation-token endpoint; anything else is a 404. */
function fakeGitHub() {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = requestUrl(input);
    calls.push(url);
    if (url.endsWith('/access_tokens')) {
      const expires_at = new Date(Date.now() + 3_600_000).toISOString();
      return Response.json({ token: 'ghs_app', expires_at }, { status: 201 });
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, fetch: fetchFn };
}

describe('GitHub App providers (§8.5)', () => {
  let t: TestApp;
  let gh: ReturnType<typeof fakeGitHub>;
  let integrations: Integrations;

  beforeAll(async () => {
    t = await testApp();
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    await t.settings.replaceSection(
      'scm',
      {
        providers: [
          {
            id: 'gh',
            type: 'github',
            base_url: 'https://github.com',
            auth: 'app',
            app_id: '7',
            installation_id: '42',
          },
          { id: 'gl', type: 'gitlab', base_url: 'https://gitlab.example.com' },
        ],
      },
      'admin@example.com',
    );
    await t.credentials.set(
      'scm_gh_app_private_key',
      await exportPKCS8(privateKey),
      'admin@example.com',
    );
    await t.credentials.set('scm_gl_token', 'glpat-x', 'admin@example.com');
    gh = fakeGitHub();
    integrations = new Integrations(t.settings, t.credentials, 'http://mates.test', {}, gh.fetch);
  });
  afterAll(async () => {
    await t.close();
    await stopTestDatabase();
  });

  it('builds the adapter on a minted installation token', async () => {
    const scm = await integrations.scm('gh');
    expect(await scm!.cloneCredential()).toEqual({ username: 'x-access-token', token: 'ghs_app' });
    expect(gh.calls).toEqual(['https://api.github.com/app/installations/42/access_tokens']);
  });

  it('hands the token to the runner through the per-invocation Secret, PATs stay in the credentials Secret', async () => {
    expect(await integrations.runnerGitToken('gl')).toBeUndefined();
    const spawner = new InvocationSpawner({
      db: t.db.pool,
      bus: t.bus,
      jobs: t.jobs,
      log: createLogger('silent'),
      internalKey: INTERNAL_KEY,
      release: 'mates',
      namespace: 'mates',
      apiInternalUrl: 'http://mates.mates.svc:8080',
      fakeClaude: true,
      helm: {},
      defaultRunnerImage: 'mates-runner:test',
      runnerGitToken: (id) => integrations.runnerGitToken(id),
    });
    const runId = '12345678-0000-4000-8000-000000000000';
    const invocation: Invocation = {
      id: 'inv-app-1',
      runId,
      seq: 1,
      mate: 'implementer',
      iteration: 1,
      status: 'pending',
      jobName: jobName(runId, 1, 'implementer'),
      podName: null,
      model: 'claude-sonnet-5-5',
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      sessionId: null,
      createdAt: new Date(),
    };
    const manifest = teamManifestSchema.parse({
      version: 1,
      team: { name: 'billing', conventions: 'CONVENTIONS.md' },
      repos: [{ id: 'svc', scm: 'gh', project: 'org/svc' }],
    });
    await spawner.createJobFor(invocation, await t.settings.get(), manifest, 'svc', 'gh');

    const secret = t.jobs.secrets.get(tokenSecretName(invocation.id))!;
    expect(Buffer.from(secret.data!.git_token!, 'base64').toString()).toBe('ghs_app');
    const env = t.jobs.jobs.get(invocation.jobName)!.spec!.template.spec!.containers[0]!.env!;
    expect(env.find((e) => e.name === 'GIT_TOKEN')!.valueFrom!.secretKeyRef).toEqual({
      name: tokenSecretName(invocation.id),
      key: 'git_token',
      optional: true,
    });
    // The same cached token served the adapter and the runner: one mint in total.
    expect(gh.calls).toHaveLength(1);
  });
});
