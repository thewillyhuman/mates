import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { V1Job } from '@kubernetes/client-node';
import { mintInvocationToken } from '../src/auth/invocation-token.js';
import { listInvocations } from '../src/runs/invocations.js';
import { packageOf } from '../src/team-context/service.test.js';
import { stopTestDatabase } from './db.js';
import { INTERNAL_KEY, testApp, type TestApp } from './harness.js';

type Detail = {
  id: string;
  branch: string | null;
  projection: {
    stage: string;
    currentInvocation: { id: string; jobName: string } | null;
    invocations: { status: string }[];
  };
};

const manifest = `
version: 1
team:
  name: E2E team
  conventions: docs/conventions.md
repos:
  - id: webhook-service
    scm: gitea
    project: mates/webhook-service
    jira_projects: [API]
    test: python3 -m unittest
branching:
  pattern: "mates/{ticket}-{slug}"
`;

async function readTarEntries(buf: Buffer): Promise<Record<string, string>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mates-ctx-'));
  const file = path.join(dir, 'b.tgz');
  await writeFile(file, buf);
  await tar.x({ file, cwd: dir });
  const { readFile, readdir } = await import('node:fs/promises');
  const out: Record<string, string> = {};
  for (const name of await readdir(dir)) {
    if (name.endsWith('.tgz')) continue;
    const p = path.join(dir, name);
    const { stat } = await import('node:fs/promises');
    if ((await stat(p)).isFile()) out[name] = await readFile(p, 'utf8');
    else out[name] = '<dir>';
  }
  return out;
}

describe('orchestrator (M2 scope)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await testApp();
    await t.settings.update(
      {
        scm: {
          providers: [
            { id: 'gitea', type: 'gitea', base_url: 'http://gitea:3000', username: 'mates' },
          ],
        },
      },
      'admin@example.com',
    );
    await t.teamContext.upload(
      await packageOf({ 'mates.yaml': manifest, 'docs/conventions.md': '# conv' }),
      'admin@example.com',
    );
  });
  afterAll(async () => {
    await t.close();
    await stopTestDatabase();
  });

  async function trigger(key: string): Promise<Detail> {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { ticket_key: key },
      headers: t.as('operator'),
    });
    expect(res.statusCode).toBe(201);
    return res.json<Detail>();
  }
  async function detail(id: string): Promise<Detail> {
    return (await t.app.inject({ url: `/api/runs/${id}`, headers: t.as('viewer') })).json<Detail>();
  }

  it('moves a queued run to intake and spawns a deterministic Job with its token secret', async () => {
    const run = await trigger('API-198');
    expect(await t.orchestrator.reconcileRun(run.id)).toBe(true);
    const d = await detail(run.id);
    expect(d.projection.stage).toBe('intake');
    expect(d.branch).toBe('mates/API-198-api-198');
    const inv = d.projection.currentInvocation!;
    expect(inv.jobName).toMatch(/^mates-r[0-9a-f]{8}-i1-intake$/);

    const job = t.jobs.jobs.get(inv.jobName)!;
    expect(job).toBeDefined();
    expect(job.metadata!.labels).toMatchObject({
      'mates/run': run.id,
      'mates/invocation': inv.id,
      'mates/mate': 'intake',
    });
    const c = job.spec!.template.spec!.containers[0]!;
    expect(c.image).toBe('mates-runner:test');
    const env = Object.fromEntries(
      c.env!.map((e) => [e.name, e.value ?? e.valueFrom?.secretKeyRef?.key]),
    );
    expect(env).toMatchObject({
      MATES_API_URL: 'http://mates.mates.svc:8080',
      MATES_MATE: 'intake',
      MATES_FAKE_CLAUDE: '1',
      GIT_TOKEN: 'scm_gitea_token',
      MATES_INVOCATION_TOKEN: 'token',
    });
    const secretName = c.env!.find((e) => e.name === 'MATES_INVOCATION_TOKEN')!.valueFrom!
      .secretKeyRef!.name;
    const secret = t.jobs.secrets.get(secretName!)!;
    const token = Buffer.from(secret.data!.token!, 'base64').toString();
    expect(token.split('.')).toHaveLength(3);

    // A second reconcile pass does nothing while the invocation is pending (idempotent).
    await t.orchestrator.reconcileRun(run.id);
    expect(t.jobs.jobs.size).toBe(1);
    expect(await listInvocations(t.db.pool, run.id)).toHaveLength(1);

    // The runner can download its context bundle with that token.
    const ctx = await t.app.inject({
      url: `/internal/invocations/${inv.id}/context`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ctx.statusCode).toBe(200);
    expect(ctx.headers['content-type']).toBe('application/gzip');
    const files = await readTarEntries(ctx.rawPayload);
    expect(Object.keys(files).sort()).toEqual([
      'brief.md',
      'intake.schema.json',
      'invocation.json',
      'nudges.json',
      'prior_verdicts.json',
      'system.md',
      'team',
      'ticket.json',
    ]);
    const invocation = JSON.parse(files['invocation.json']!) as {
      repo: { clone_url: string; id: string } | null;
      fake: { scenario: string };
      claude: { json_schema_file: string };
    };
    expect(invocation.repo).toMatchObject({
      id: 'webhook-service',
      clone_url: 'http://gitea:3000/mates/webhook-service.git',
    });
    expect(invocation.fake.scenario).toBe('intake_implementable');
    expect(invocation.claude.json_schema_file).toBe('intake.schema.json');
    expect(files['brief.md']).toContain('# Intake — API-198');
    expect(files['system.md']).toContain('"E2E team"');

    // Blob upload and download round-trip.
    const up = await t.app.inject({
      method: 'POST',
      url: `/internal/invocations/${inv.id}/blobs/tests_log`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      payload: 'Ran 3 tests\n\nOK\n',
    });
    expect(up.statusCode).toBe(201);
    const blobId = up.json<{ id: string }>().id;
    const down = await t.app.inject({
      url: `/api/runs/${run.id}/blobs/${blobId}`,
      headers: t.as('viewer'),
    });
    expect(down.statusCode).toBe(200);
    expect(down.body).toBe('Ran 3 tests\n\nOK\n');
    expect(down.headers['content-type']).toBe('text/plain');
  });

  it('retries an infra failure once with a -r1 job, then fails the run', async () => {
    const run = await trigger('API-300');
    await t.orchestrator.reconcileRun(run.id);
    const first = (await detail(run.id)).projection.currentInvocation!;
    const token = await mintInvocationToken(
      INTERNAL_KEY,
      { invocationId: first.id, runId: run.id },
      600,
    );
    const fail = (id: string, tok: string) =>
      t.app.inject({
        method: 'POST',
        url: `/internal/invocations/${id}/events`,
        headers: { authorization: `Bearer ${tok}` },
        payload: [
          {
            type: 'invocation.failed',
            payload: { reason: 'setup_failed', detail: 'pip exploded' },
          },
        ],
      });
    expect((await fail(first.id, token)).statusCode).toBe(202);

    await t.orchestrator.reconcileRun(run.id);
    let d = await detail(run.id);
    expect(d.projection.stage).toBe('intake');
    const retry = d.projection.currentInvocation!;
    expect(retry.id).not.toBe(first.id);
    expect(retry.jobName).toMatch(/-i2-intake-r1$/);
    expect(t.jobs.jobs.has(retry.jobName)).toBe(true);

    const token2 = await mintInvocationToken(
      INTERNAL_KEY,
      { invocationId: retry.id, runId: run.id },
      600,
    );
    expect((await fail(retry.id, token2)).statusCode).toBe(202);
    await t.orchestrator.reconcileRun(run.id);
    d = await detail(run.id);
    expect(d.projection.stage).toBe('failed');
    expect(d.projection.currentInvocation).toBeNull();
    const events = await t.app.inject({
      url: `/api/runs/${run.id}/events`,
      headers: t.as('viewer'),
    });
    const failedEvent = events
      .json<{ events: { type: string; payload: { reason?: string } }[] }>()
      .events.find((e) => e.type === 'run.failed');
    expect(failedEvent?.payload.reason).toBe('setup_failed (after retry)');
  });

  it('fails a run without a retry when the failure is not infra', async () => {
    const run = await trigger('API-301');
    await t.orchestrator.reconcileRun(run.id);
    const inv = (await detail(run.id)).projection.currentInvocation!;
    const token = await mintInvocationToken(
      INTERNAL_KEY,
      { invocationId: inv.id, runId: run.id },
      600,
    );
    await t.app.inject({
      method: 'POST',
      url: `/internal/invocations/${inv.id}/events`,
      headers: { authorization: `Bearer ${token}` },
      payload: [{ type: 'invocation.failed', payload: { reason: 'runner_error', detail: 'boom' } }],
    });
    await t.orchestrator.reconcileRun(run.id);
    expect((await detail(run.id)).projection.stage).toBe('failed');
  });

  it('turns a failed Job into an invocation failure through the monitor', async () => {
    const run = await trigger('API-302');
    await t.orchestrator.reconcileRun(run.id);
    const inv = (await detail(run.id)).projection.currentInvocation!;
    t.jobs.status.set(inv.jobName, {
      active: 0,
      failed: 1,
      failureReason: 'DeadlineExceeded',
      failureMessage: 'too slow',
    });
    await t.monitor.tick();
    const d = await detail(run.id);
    expect(d.projection.invocations.at(-1)?.status).toBe('failed');
    const rows = await t.db.pool.query<{ status: string }>(
      'SELECT status FROM invocations WHERE id = $1',
      [inv.id],
    );
    expect(rows.rows[0]?.status).toBe('timed_out');
    // The reconciler then retries once (timed_out is an infra reason).
    await t.orchestrator.reconcileRun(run.id);
    expect((await detail(run.id)).projection.currentInvocation?.jobName).toMatch(/-r1$/);
  });

  it('cancels a run: deletes the job, marks the invocation and the stage', async () => {
    const run = await trigger('API-303');
    await t.orchestrator.reconcileRun(run.id);
    const inv = (await detail(run.id)).projection.currentInvocation!;
    const viewerAttempt = await t.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/cancel`,
      payload: { reason: 'x' },
      headers: t.as('viewer'),
    });
    expect(viewerAttempt.statusCode).toBe(403);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/cancel`,
      payload: { reason: 'duplicate' },
      headers: t.as('operator'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Detail>().projection.stage).toBe('cancelled');
    expect(res.json<Detail>().projection.currentInvocation).toBeNull();
    expect(t.jobs.deleted).toContain(inv.jobName);
    const rows = await t.db.pool.query<{ status: string }>(
      'SELECT status FROM invocations WHERE id = $1',
      [inv.id],
    );
    expect(rows.rows[0]?.status).toBe('cancelled');
    // Once cancelled the context endpoint refuses the runner.
    const token = await mintInvocationToken(
      INTERNAL_KEY,
      { invocationId: inv.id, runId: run.id },
      600,
    );
    const ctx = await t.app.inject({
      url: `/internal/invocations/${inv.id}/context`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ctx.statusCode).toBe(409);
  });

  it('fails a run when no team context is active', async () => {
    const fresh = await testApp();
    try {
      const res = await fresh.app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { ticket_key: 'API-9' },
        headers: fresh.as('operator'),
      });
      const id = res.json<Detail>().id;
      await fresh.orchestrator.reconcileRun(id);
      const d = (
        await fresh.app.inject({ url: `/api/runs/${id}`, headers: fresh.as('viewer') })
      ).json<Detail>();
      expect(d.projection.stage).toBe('failed');
    } finally {
      await fresh.close();
    }
  });
});

describe('job manifest from the spawner', () => {
  it('uses the mates.yaml runner_image override and helm image pull secrets', async () => {
    const t2 = await testApp({
      helm: { runner: { serviceAccount: 'rel-runner', imagePullSecrets: [{ name: 'regcred' }] } },
    });
    try {
      await t2.settings.update(
        { scm: { providers: [{ id: 'gl', type: 'gitlab', base_url: 'https://gitlab.com' }] } },
        'a',
      );
      await t2.teamContext.upload(
        await packageOf({
          'mates.yaml': manifest
            .replace('scm: gitea', 'scm: gl')
            .replace(
              'test: python3 -m unittest',
              'test: pnpm test\n    runner_image: ghcr.io/x/custom:1',
            ),
          'docs/conventions.md': '#',
        }),
        'a',
      );
      const res = await t2.app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { ticket_key: 'API-1' },
        headers: t2.as('operator'),
      });
      await t2.orchestrator.reconcileRun(res.json<Detail>().id);
      const job = [...t2.jobs.jobs.values()][0] as V1Job;
      const pod = job.spec!.template.spec!;
      expect(pod.containers[0]!.image).toBe('ghcr.io/x/custom:1');
      expect(pod.serviceAccountName).toBe('rel-runner');
      expect(pod.imagePullSecrets).toEqual([{ name: 'regcred' }]);
      expect(
        pod.containers[0]!.env!.find((e) => e.name === 'GIT_TOKEN')!.valueFrom!.secretKeyRef!.key,
      ).toBe('scm_gl_token');
    } finally {
      await t2.close();
    }
  });
});
