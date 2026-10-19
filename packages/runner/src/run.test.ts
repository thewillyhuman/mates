import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { InvocationContext, NewEvent } from '@mates/core';
import { RunnerApi } from './api.js';
import type { RunnerEnv } from './env.js';
import { seedOrigin } from './test-helpers.js';
import type { Log } from './log.js';
import { runInvocation } from './run.js';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const log: Log = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** An in-memory mates-api: serves the context bundle, records events and blobs. */
async function fakeApi(ctx: InvocationContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mates-ctx-'));
  await writeFile(path.join(dir, 'invocation.json'), JSON.stringify(ctx));
  await writeFile(path.join(dir, 'brief.md'), '# brief');
  await writeFile(path.join(dir, 'system.md'), 'system');
  await mkdir(path.join(dir, 'team'));
  await exec('tar', [
    '-czf',
    path.join(dir, 'bundle.tgz'),
    '-C',
    dir,
    'invocation.json',
    'brief.md',
    'system.md',
    'team',
  ]);
  const { readFile } = await import('node:fs/promises');
  const bundle = await readFile(path.join(dir, 'bundle.tgz'));
  const events: NewEvent[] = [];
  const blobs: { kind: string; body: Buffer; type: string }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (u.endsWith('/context')) return new Response(bundle, { status: 200 });
    if (u.endsWith('/events')) {
      events.push(...(JSON.parse(init!.body as string) as NewEvent[]));
      return new Response('{"accepted":1,"dropped":0}', { status: 202 });
    }
    const m = /\/blobs\/(\w+)$/.exec(u);
    if (m) {
      const body = init!.body;
      blobs.push({
        kind: m[1]!,
        body: Buffer.isBuffer(body) ? body : Buffer.from(body as string),
        type: (init!.headers as Record<string, string>)['content-type']!,
      });
      return new Response(JSON.stringify({ id: `blob-${blobs.length}` }), { status: 201 });
    }
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  return { events, blobs, fetchFn };
}

function context(origin: string, overrides: Partial<InvocationContext> = {}): InvocationContext {
  return {
    invocation_id: 'inv-1',
    run_id: 'run-1',
    mate: 'implementer',
    iteration: 1,
    ticket: { key: 'API-198', title: 'Retry policy for webhook delivery', url: null },
    repo: {
      id: 'webhook-service',
      clone_url: origin,
      default_branch: 'main',
      base_branch: 'main',
      branch: 'mates/API-198-retry-policy-for-webhook-delivery',
      setup: 'true',
      test: 'python3 -m unittest discover -s tests -v',
      lint: '',
      env: {},
      paths_hint: [],
    },
    git: { username: 'x-access-token', author_name: 'Mates', author_email: 'mates@example.com' },
    claude: {
      model: 'claude-opus-5-5',
      allowed_tools: ['Read', 'Edit'],
      disallowed_tools: ['Bash(git push *)'],
      permission_mode: 'acceptEdits',
      max_budget_usd: 5,
      max_turns: 50,
      timeout_seconds: 60,
      json_schema_file: null,
      effort: null,
    },
    commit: { trailer: 'Jira: {ticket}', default_summary: 'Retry policy for webhook delivery' },
    branching: { pattern: 'mates/{ticket}-{slug}' },
    setup_timeout_seconds: 60,
    test_timeout_seconds: 60,
    fake: { scenario: 'impl_iter1_green', patch: 'impl_iter1_green.patch' },
    ...overrides,
  };
}

async function envFor(ctx: InvocationContext): Promise<RunnerEnv> {
  const ws = await mkdtemp(path.join(tmpdir(), 'mates-ws-'));
  return {
    apiUrl: 'http://api',
    token: 'tok',
    invocationId: ctx.invocation_id,
    runId: ctx.run_id,
    mate: ctx.mate,
    iteration: ctx.iteration,
    fakeClaude: true,
    gitToken: 'git-secret-token',
    anthropicApiKey: undefined,
    workspace: ws,
    contextDir: path.join(ws, 'context'),
    fixturesDir: path.join(ROOT, 'fixtures/claude'),
    secrets: ['git-secret-token', 'tok'],
  };
}

describe('runInvocation (fake Claude)', () => {
  it('implements, pushes the run branch, reports tests, blobs and the result', async () => {
    const origin = await seedOrigin();
    const ctx = context(origin);
    const fake = await fakeApi(ctx);
    const env = await envFor(ctx);
    const api = new RunnerApi({
      ...env,
      secrets: env.secrets,
      log,
      fetch: fake.fetchFn,
      flushIntervalMs: 10,
    });
    const code = await runInvocation({ env, log, api, signal: new AbortController().signal });
    expect(code).toBe(0);

    const types = fake.events.map((e) => e.type);
    expect(types[0]).toBe('invocation.started');
    expect(types).toContain('invocation.tool_use');
    expect(types.filter((t) => t === 'invocation.text').length).toBeGreaterThan(0);
    expect(types.slice(-4)).toEqual([
      'implementation.pushed',
      'implementation.addressed',
      'implementation.tests',
      'invocation.finished',
    ]);

    const pushed = fake.events.find((e) => e.type === 'implementation.pushed')!;
    expect(pushed.payload).toMatchObject({
      files_changed: 2,
      additions: 9,
      deletions: 2,
      changed_in_iteration: true,
      diff_ref: 'blob-1',
    });
    const tests = fake.events.find((e) => e.type === 'implementation.tests')!;
    expect(tests.payload).toMatchObject({
      passed: 3,
      failed: 0,
      skipped: 0,
      runner: 'unittest',
      log_ref: 'blob-2',
    });
    const finished = fake.events.find((e) => e.type === 'invocation.finished')!;
    expect(finished.payload).toMatchObject({ exit_code: 0, transcript_ref: 'blob-3' });
    expect((finished.payload as { result: { total_cost_usd: number } }).result.total_cost_usd).toBe(
      1.8734,
    );

    // Blobs: diff, tests log (from the tool result the fixture recorded), gzipped transcript.
    expect(fake.blobs.map((b) => b.kind)).toEqual(['diff', 'tests_log', 'transcript']);
    expect(fake.blobs[0]!.body.toString()).toContain('max_attempts');
    expect(gunzipSync(fake.blobs[2]!.body).toString()).toMatch(/"type":\s*"result"/);

    // The branch exists on the origin with the commit message from the addressed block.
    const { stdout } = await exec(
      'git',
      ['log', '-1', '--format=%s%n%b', 'mates/API-198-retry-policy-for-webhook-delivery'],
      { cwd: origin },
    );
    expect(stdout).toContain('API-198: Cap retry attempts at five');
    expect(stdout).toContain('Jira: API-198');
    expect(JSON.stringify(fake.events)).not.toContain('git-secret-token');
  });

  it('reports an empty iteration without pushing', async () => {
    const origin = await seedOrigin();
    const ctx = context(origin, { fake: { scenario: 'impl_empty_diff', patch: null } });
    const fake = await fakeApi(ctx);
    const env = await envFor(ctx);
    const api = new RunnerApi({ ...env, log, fetch: fake.fetchFn, flushIntervalMs: 10 });
    expect(await runInvocation({ env, log, api, signal: new AbortController().signal })).toBe(0);
    const pushed = fake.events.find((e) => e.type === 'implementation.pushed')!;
    expect(pushed.payload).toMatchObject({
      files_changed: 0,
      changed_in_iteration: false,
      diff_ref: null,
    });
    const { stdout } = await exec('git', ['branch', '--list', 'mates/*'], { cwd: origin });
    expect(stdout.trim()).toBe('');
  });

  it('fails with setup_failed when setup exits non-zero', async () => {
    const origin = await seedOrigin();
    const ctx = context(origin, {
      repo: { ...context(origin).repo!, setup: 'echo broken >&2; exit 3' },
    });
    const fake = await fakeApi(ctx);
    const env = await envFor(ctx);
    const api = new RunnerApi({ ...env, log, fetch: fake.fetchFn, flushIntervalMs: 10 });
    expect(await runInvocation({ env, log, api, signal: new AbortController().signal })).toBe(1);
    const failed = fake.events.at(-1)!;
    expect(failed.type).toBe('invocation.failed');
    expect(failed.payload).toMatchObject({ reason: 'setup_failed' });
    expect((failed.payload as { detail: string }).detail).toContain('broken');
  });

  it('runs the reviewer on the existing branch without pushing', async () => {
    const origin = await seedOrigin();
    // Seed the run branch first with an implementer pass.
    const impl = context(origin);
    const implFake = await fakeApi(impl);
    const implEnv = await envFor(impl);
    await runInvocation({
      env: implEnv,
      log,
      api: new RunnerApi({ ...implEnv, log, fetch: implFake.fetchFn, flushIntervalMs: 10 }),
      signal: new AbortController().signal,
    });

    const ctx = context(origin, {
      invocation_id: 'inv-2',
      mate: 'reviewer',
      fake: { scenario: 'review_approve', patch: null },
    });
    const fake = await fakeApi(ctx);
    const env = { ...(await envFor(ctx)), invocationId: 'inv-2' };
    const api = new RunnerApi({ ...env, log, fetch: fake.fetchFn, flushIntervalMs: 10 });
    expect(await runInvocation({ env, log, api, signal: new AbortController().signal })).toBe(0);
    const types = fake.events.map((e) => e.type);
    expect(types).not.toContain('implementation.pushed');
    expect(types.at(-1)).toBe('invocation.finished');
    const finished = fake.events.at(-1)!.payload as {
      result: { structured_output: { decision: string } };
    };
    expect(finished.result.structured_output.decision).toBe('approve');
  });

  it('runs intake without a repository', async () => {
    const ctx = context('unused', {
      mate: 'intake',
      iteration: 0,
      repo: null,
      fake: { scenario: 'intake_implementable', patch: null },
    });
    const fake = await fakeApi(ctx);
    const env = await envFor(ctx);
    const api = new RunnerApi({ ...env, log, fetch: fake.fetchFn, flushIntervalMs: 10 });
    expect(await runInvocation({ env, log, api, signal: new AbortController().signal })).toBe(0);
    const finished = fake.events.at(-1)!;
    expect(finished.type).toBe('invocation.finished');
    expect(
      (finished.payload as { result: { structured_output: { decision: string } } }).result
        .structured_output.decision,
    ).toBe('implementable');
  });

  it('reports cancellation when aborted', async () => {
    const origin = await seedOrigin();
    const ctx = context(origin);
    const fake = await fakeApi(ctx);
    const env = await envFor(ctx);
    const api = new RunnerApi({ ...env, log, fetch: fake.fetchFn, flushIntervalMs: 10 });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    expect(await runInvocation({ env, log, api, signal: abort.signal })).toBe(143);
    expect(fake.events.at(-1)!.payload).toMatchObject({ reason: 'cancelled' });
  });
});
