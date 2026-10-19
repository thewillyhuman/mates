import type { FastifyInstance } from 'fastify';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { RunEvent } from '@mates/core';
import type { Pool } from './db/pool.js';
import type { EventBus } from './runs/bus.js';

/**
 * Prometheus metrics (§14). Fed from the committed event stream so they
 * stay in step with the log without touching the orchestrator; the queue
 * depth is refreshed from the database.
 */
export class Metrics {
  readonly registry = new Registry();
  readonly runsTotal = new Counter({
    name: 'mates_runs_total',
    help: 'Runs entering a stage',
    labelNames: ['stage'],
    registers: [this.registry],
  });
  readonly invocationsTotal = new Counter({
    name: 'mates_invocations_total',
    help: 'Finished invocations',
    labelNames: ['mate', 'status'],
    registers: [this.registry],
  });
  readonly invocationDuration = new Histogram({
    name: 'mates_invocation_duration_seconds',
    help: 'Invocation wall time',
    labelNames: ['mate'],
    buckets: [30, 60, 120, 300, 600, 1200, 1800, 2700, 3600],
    registers: [this.registry],
  });
  readonly costUsd = new Counter({
    name: 'mates_cost_usd_total',
    help: 'Reported cost in USD',
    labelNames: ['mate', 'model'],
    registers: [this.registry],
  });
  readonly tokens = new Counter({
    name: 'mates_tokens_total',
    help: 'Tokens by kind',
    labelNames: ['mate', 'model', 'kind'],
    registers: [this.registry],
  });
  readonly iterationsToApproval = new Histogram({
    name: 'mates_iterations_to_approval',
    help: 'Iterations until the reviewer approved',
    buckets: [1, 2, 3, 4, 5, 6, 8, 10],
    registers: [this.registry],
  });
  readonly queueDepth = new Gauge({
    name: 'mates_queue_depth',
    help: 'Runs in the queued stage',
    registers: [this.registry],
  });
  readonly trackerPollErrors = new Counter({
    name: 'mates_tracker_poll_errors_total',
    help: 'Failed tracker polls',
    registers: [this.registry],
  });
  readonly scmApiErrors = new Counter({
    name: 'mates_scm_api_errors_total',
    help: 'Failed SCM API calls',
    registers: [this.registry],
  });

  /** Mates of known invocations, so usage events can be labelled. */
  private readonly mates = new Map<string, string>();

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  /** Observes committed events (one bus subscription per process). */
  observe(events: readonly RunEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'run.stage_changed':
          this.runsTotal.inc({ stage: e.payload.to });
          break;
        case 'invocation.scheduled':
          if (e.invocation_id) this.mates.set(e.invocation_id, e.payload.mate);
          break;
        case 'invocation.finished': {
          const mate = this.mateOf(e.invocation_id);
          this.invocationsTotal.inc({
            mate,
            status: e.payload.exit_code === 0 ? 'succeeded' : 'failed',
          });
          this.invocationDuration.observe({ mate }, e.payload.duration_ms / 1000);
          break;
        }
        case 'invocation.failed':
          this.invocationsTotal.inc({
            mate: this.mateOf(e.invocation_id),
            status: e.payload.reason === 'cancelled' ? 'cancelled' : 'failed',
          });
          break;
        case 'run.failed':
          // Merge-request calls are the only SCM API calls on the run path (§7.5).
          if (e.payload.reason === 'mr_failed') this.scmApiErrors.inc();
          break;
        case 'usage.recorded': {
          const mate = this.mateOf(e.invocation_id);
          if (e.payload.cost_usd)
            this.costUsd.inc({ mate, model: e.payload.model }, e.payload.cost_usd);
          this.tokens.inc({ mate, model: e.payload.model, kind: 'input' }, e.payload.input_tokens);
          this.tokens.inc(
            { mate, model: e.payload.model, kind: 'output' },
            e.payload.output_tokens,
          );
          this.tokens.inc(
            { mate, model: e.payload.model, kind: 'cache_read' },
            e.payload.cache_read_tokens,
          );
          this.tokens.inc(
            { mate, model: e.payload.model, kind: 'cache_write' },
            e.payload.cache_write_tokens,
          );
          break;
        }
        case 'review.verdict':
          if (e.payload.decision === 'approve') {
            const iteration = Number(
              e.payload.blocking.length === 0 ? (this.iterationHint.get(e.run_id) ?? 1) : 1,
            );
            this.iterationsToApproval.observe(iteration);
          }
          break;
        default:
          break;
      }
      if (e.type === 'invocation.scheduled' && e.payload.mate === 'reviewer')
        this.iterationHint.set(e.run_id, e.payload.iteration);
    }
  }
  private readonly iterationHint = new Map<string, number>();

  private mateOf(invocationId: string | null): string {
    return (invocationId && this.mates.get(invocationId)) || 'unknown';
  }

  async refreshQueueDepth(db: Pool): Promise<void> {
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM runs WHERE status = 'queued'`,
    );
    this.queueDepth.set(Number(r.rows[0]?.n ?? 0));
  }

  subscribe(bus: EventBus): () => void {
    return bus.subscribe('*', (events) => this.observe(events));
  }
}

export async function metricsRoute(app: FastifyInstance, metrics: Metrics): Promise<void> {
  app.get('/metrics', async (_req, reply) =>
    reply
      .header('content-type', metrics.registry.contentType)
      .send(await metrics.registry.metrics()),
  );
}
