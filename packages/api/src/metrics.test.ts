import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@mates/core';
import { Metrics } from './metrics.js';

const ev = (
  type: RunEvent['type'],
  payload: unknown,
  invocation_id: string | null = null,
  id = 1,
): RunEvent =>
  ({ id, run_id: 'r', invocation_id, ts: new Date().toISOString(), type, payload }) as RunEvent;

describe('Metrics', () => {
  it('derives the §14 metrics from committed events', async () => {
    const m = new Metrics();
    m.observe([
      ev('run.stage_changed', { from: 'queued', to: 'intake', reason: 'x' }),
      ev(
        'invocation.scheduled',
        { mate: 'implementer', iteration: 1, job_name: 'j', model: 'opus' },
        'i1',
      ),
      ev(
        'invocation.finished',
        { exit_code: 0, duration_ms: 90_000, session_id: null, result: null, transcript_ref: null },
        'i1',
      ),
      ev(
        'usage.recorded',
        {
          model: 'opus',
          input_tokens: 100,
          output_tokens: 20,
          cache_read_tokens: 5,
          cache_write_tokens: 1,
          cost_usd: 1.5,
        },
        'i1',
      ),
      ev(
        'invocation.scheduled',
        { mate: 'reviewer', iteration: 2, job_name: 'j2', model: 'opus' },
        'r2',
      ),
      ev(
        'review.verdict',
        { decision: 'approve', blocking: [], non_blocking: [], summary: '' },
        'r2',
      ),
      ev('invocation.failed', { reason: 'cancelled', detail: '' }, 'i1'),
    ]);
    const text = await m.registry.metrics();
    expect(text).toContain('mates_runs_total{stage="intake"} 1');
    expect(text).toContain('mates_invocations_total{mate="implementer",status="succeeded"} 1');
    expect(text).toContain('mates_invocations_total{mate="implementer",status="cancelled"} 1');
    expect(text).toContain(
      'mates_invocation_duration_seconds_bucket{le="120",mate="implementer"} 1',
    );
    expect(text).toContain('mates_cost_usd_total{mate="implementer",model="opus"} 1.5');
    expect(text).toContain('mates_tokens_total{mate="implementer",model="opus",kind="input"} 100');
    expect(text).toContain('mates_iterations_to_approval_bucket{le="2"} 1');
    expect(text).toContain('process_cpu_seconds_total');
  });

  it('counts merge-request failures as SCM API errors', async () => {
    const m = new Metrics();
    m.observe([
      ev('run.failed', { reason: 'mr_failed', detail: 'HTTP 502' }),
      ev('run.failed', { reason: 'out_of_scope', detail: '' }),
    ]);
    expect(await m.registry.metrics()).toMatch(/mates_scm_api_errors_total(\{[^}]*\})? 1\n/);
  });
});
