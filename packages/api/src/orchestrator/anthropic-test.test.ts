import { describe, expect, it } from 'vitest';
import { FakeJobsClient } from '../kubernetes/jobs.js';
import { createLogger } from '../logger.js';
import { AnthropicTest, parseTestOutput } from './anthropic-test.js';

describe('parseTestOutput', () => {
  it('reads model, latency and cost from the json result', () => {
    const r = parseTestOutput(
      'noise\n' +
        JSON.stringify({
          type: 'result',
          is_error: false,
          result: 'OK',
          total_cost_usd: 0.0012,
          duration_api_ms: 812,
          modelUsage: { 'claude-sonnet-5-5': {} },
        }),
    );
    expect(r).toEqual({
      ok: true,
      message: 'claude answered with claude-sonnet-5-5 in 812 ms',
      details: { model: 'claude-sonnet-5-5', latency_ms: 812, cost_usd: 0.0012 },
    });
    expect(
      parseTestOutput(JSON.stringify({ is_error: true, result: 'Not logged in' })),
    ).toMatchObject({ ok: false, message: expect.stringContaining('Not logged in') as string });
    expect(parseTestOutput('garbage')).toMatchObject({ ok: false });
  });
});

describe('AnthropicTest', () => {
  const base = {
    log: createLogger('silent'),
    namespace: 'mates',
    release: 'mates',
    image: 'runner:1',
    serviceAccount: 'mates-runner',
    pollMs: 5,
    timeoutMs: 500,
  };

  it('runs a locked-down job with only the api key and reports its result', async () => {
    const jobs = new FakeJobsClient();
    const test = new AnthropicTest({ ...base, jobs, fakeClaude: false });
    const run = test.run();
    await new Promise((r) => setTimeout(r, 20));
    const name = [...jobs.jobs.keys()][0]!;
    const job = jobs.jobs.get(name)!;
    const c = job.spec!.template.spec!.containers[0]!;
    expect(c.command![0]).toBe('claude');
    expect(c.env!.map((e) => e.name)).toEqual(['HOME', 'ANTHROPIC_API_KEY']);
    expect(c.securityContext).toMatchObject({
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
    expect(job.spec!.template.spec!.automountServiceAccountToken).toBe(false);
    jobs.logs.set(
      name,
      JSON.stringify({
        result: 'OK',
        total_cost_usd: 0.001,
        duration_ms: 500,
        modelUsage: { 'claude-sonnet-5-5': {} },
      }),
    );
    jobs.status.set(name, { active: 0, succeeded: 1 });
    expect(await run).toMatchObject({
      ok: true,
      details: { model: 'claude-sonnet-5-5', job: name },
    });
    expect(jobs.deleted).toContain(name);
  });

  it('times out and cleans up', async () => {
    const jobs = new FakeJobsClient();
    const r = await new AnthropicTest({ ...base, jobs, fakeClaude: false, timeoutMs: 30 }).run();
    expect(r).toMatchObject({
      ok: false,
      message: expect.stringContaining('did not finish') as string,
    });
    expect(jobs.jobs.size).toBe(0);
  });

  it('short-circuits in fake mode', async () => {
    expect(
      await new AnthropicTest({ ...base, jobs: new FakeJobsClient(), fakeClaude: true }).run(),
    ).toMatchObject({ ok: true, details: { model: 'fake' } });
  });
});
