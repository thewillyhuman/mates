import {
  assertTransition,
  branchName,
  isTerminal,
  type Mate,
  type RunProjection,
  type Stage,
  type TeamManifest,
} from '@mates/core';
import type { Pool } from '../db/pool.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../runs/bus.js';
import { appendEvents, projectRunById } from '../runs/events.js';
import { listInvocations, markInvocationStatus, type Invocation } from '../runs/invocations.js';
import { findRun, findTicket, type Run, type Ticket } from '../runs/repository.js';
import type { SettingsService } from '../settings/service.js';
import type { TeamContextService } from '../team-context/service.js';
import { INFRA_REASONS } from './monitor.js';
import type { InvocationSpawner } from './spawner.js';

/**
 * The reconcile loop (§5.1 item 2). Every 5 s and on every event it looks
 * at each non-terminal run and decides the next action. Runs are claimed
 * with a per-run advisory lock, so overlapping passes never act twice.
 *
 * M2 scope: queued → intake spawn; infra failure retry (§7.5 rule 6);
 * cancellation. M4 adds the implementer/reviewer loop.
 */
export interface ReconcilerDeps {
  db: Pool;
  bus: EventBus;
  log: Logger;
  settings: SettingsService;
  teamContext: TeamContextService;
  spawner: InvocationSpawner;
  intervalMs?: number;
}

export interface RunContext {
  run: Run;
  ticket: Ticket;
  projection: RunProjection;
  invocations: Invocation[];
}

export class Orchestrator {
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly pending = new Set<string>();
  private busy = false;

  constructor(protected readonly deps: ReconcilerDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.reconcileAll(), this.deps.intervalMs ?? 5000);
    this.timer.unref();
    // Events make the loop run sooner for the affected run.
    this.unsubscribe = this.deps.bus.subscribe('*', (events) => {
      const runId = events[0]?.run_id;
      if (runId) {
        this.pending.add(runId);
        setImmediate(() => void this.drain());
      }
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending.size) {
        const [runId] = this.pending;
        this.pending.delete(runId!);
        await this.reconcileRun(runId!).catch((err: Error) =>
          this.deps.log.error({ err, run_id: runId }, 'reconcile failed'),
        );
      }
    } finally {
      this.busy = false;
    }
  }

  /** One pass over every non-terminal run. */
  async reconcileAll(): Promise<void> {
    const r = await this.deps.db.query<{ id: string }>(
      `SELECT id FROM runs WHERE status NOT IN ('done', 'cancelled', 'failed') ORDER BY created_at`,
    );
    for (const row of r.rows) {
      await this.reconcileRun(row.id).catch((err: Error) =>
        this.deps.log.error({ err, run_id: row.id }, 'reconcile failed'),
      );
    }
  }

  /**
   * Reconciles one run under a per-run advisory lock; returns false if
   * another pass holds it (decision 0013). A row lock would block the
   * cache refresh that `appendEvents` performs from another connection.
   */
  async reconcileRun(runId: string): Promise<boolean> {
    const client = await this.deps.db.connect();
    try {
      const got = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
        [runId],
      );
      if (!got.rows[0]?.ok) return false;
      try {
        const ctx = await this.load(runId);
        if (ctx && !isTerminal(ctx.projection.stage)) await this.decide(ctx);
      } finally {
        await client
          .query('SELECT pg_advisory_unlock(hashtext($1))', [runId])
          .catch(() => undefined);
      }
      return true;
    } finally {
      client.release();
    }
  }

  protected async load(runId: string): Promise<RunContext | undefined> {
    const run = await findRun(this.deps.db, runId);
    if (!run) return undefined;
    const ticket = (await findTicket(this.deps.db, run.ticketId))!;
    const [projection, invocations] = await Promise.all([
      projectRunById(this.deps.db, runId),
      listInvocations(this.deps.db, runId),
    ]);
    return { run, ticket, projection, invocations };
  }

  /** The decision table. Subclasses (M4) extend it; M2 handles intake, retries and nothing else. */
  protected async decide(ctx: RunContext): Promise<void> {
    const p = ctx.projection;
    const failed = this.unhandledFailure(ctx);
    if (failed) {
      await this.handleFailure(ctx, failed);
      return;
    }
    if (p.currentInvocation) return; // something is running; wait for it
    if (p.paused) return;
    if (p.stage === 'queued') await this.startIntake(ctx);
  }

  /** The most recent failed invocation that has not been retried or turned into a run failure. */
  protected unhandledFailure(ctx: RunContext): Invocation | undefined {
    const p = ctx.projection;
    const last = ctx.invocations.at(-1);
    if (!last || (last.status !== 'failed' && last.status !== 'timed_out')) return undefined;
    const view = p.invocations.find((i) => i.id === last.id);
    if (!view || view.status !== 'failed') return undefined;
    return last;
  }

  protected async handleFailure(ctx: RunContext, inv: Invocation): Promise<void> {
    const view = ctx.projection.invocations.find((i) => i.id === inv.id)!;
    const reason = view.failure?.reason ?? 'unknown';
    const infra = INFRA_REASONS.has(reason) || inv.status === 'timed_out';
    if (infra && inv.attempt === 0) {
      this.deps.log.warn(
        { run_id: ctx.run.id, invocation_id: inv.id, reason },
        'infra failure; retrying once',
      );
      await this.spawn(ctx, inv.mate, inv.iteration, 1);
      return;
    }
    await this.failRun(ctx, infra ? `${reason} (after retry)` : reason, view.failure?.detail ?? '');
  }

  protected async startIntake(ctx: RunContext): Promise<void> {
    await this.transition(ctx, 'intake', 'scheduled');
    await this.spawn(ctx, 'intake', 0, 0);
  }

  /** Spawns an invocation; a spawn error becomes `invocation.failed { spawn_failed }` for the retry logic. */
  protected async spawn(
    ctx: RunContext,
    mate: Mate,
    iteration: number,
    attempt: number,
  ): Promise<void> {
    const settings = await this.deps.settings.get();
    const active = await this.deps.teamContext.active();
    if (!active?.manifest) {
      await this.failRun(ctx, 'no_team_context', 'no valid team context is active');
      return;
    }
    const manifest = active.manifest;
    const repoId =
      mate === 'intake'
        ? (this.candidateRepo(ctx, manifest)?.id ?? null)
        : (ctx.projection.intake?.repo ?? null);
    const repo = repoId ? manifest.repos.find((r) => r.id === repoId) : undefined;
    try {
      await this.ensureBranch(ctx, manifest);
      await this.deps.spawner.spawn({
        runId: ctx.run.id,
        mate,
        iteration,
        attempt,
        settings,
        manifest,
        repoId,
        scmProviderId: repo?.scm ?? null,
      });
    } catch (err) {
      this.deps.log.error({ err, run_id: ctx.run.id, mate }, 'spawn failed');
      const invs = await listInvocations(this.deps.db, ctx.run.id);
      const last = invs.at(-1);
      if (last && last.status === 'pending' && last.mate === mate && last.attempt === attempt) {
        await markInvocationStatus(this.deps.db, last.id, 'failed');
        await appendEvents(this.deps.db, this.deps.bus, ctx.run.id, [
          {
            type: 'invocation.failed',
            payload: { reason: 'spawn_failed', detail: (err as Error).message },
            invocation_id: last.id,
          },
        ]);
      } else {
        await this.failRun(ctx, 'spawn_failed', (err as Error).message);
      }
    }
  }

  /** The one repo whose `jira_projects` lists the ticket's project, if unique. */
  protected candidateRepo(
    ctx: RunContext,
    manifest: TeamManifest,
  ): TeamManifest['repos'][number] | undefined {
    const project = ctx.ticket.projectKey ?? ctx.ticket.externalKey.split('-')[0];
    const matches = manifest.repos.filter((r) => r.jira_projects.includes(project ?? ''));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Persists the run branch name once, from the branching pattern. */
  protected async ensureBranch(ctx: RunContext, manifest: TeamManifest): Promise<void> {
    if (ctx.run.branch) return;
    const branch = branchName(manifest.branching.pattern, ctx.ticket.externalKey, ctx.ticket.title);
    await this.deps.db.query(
      'UPDATE runs SET branch = $2, team_context_version = COALESCE(team_context_version, $3) WHERE id = $1',
      [ctx.run.id, branch, (await this.deps.teamContext.active())?.version ?? null],
    );
    ctx.run = { ...ctx.run, branch };
  }

  protected async transition(ctx: RunContext, to: Stage, reason: string): Promise<void> {
    const from = ctx.projection.stage;
    assertTransition(from, to);
    const { projection } = await appendEvents(this.deps.db, this.deps.bus, ctx.run.id, [
      { type: 'run.stage_changed', payload: { from, to, reason } },
    ]);
    if (projection) ctx.projection = projection;
  }

  protected async failRun(ctx: RunContext, reason: string, detail: string): Promise<void> {
    this.deps.log.error({ run_id: ctx.run.id, reason, detail }, 'run failed');
    await appendEvents(this.deps.db, this.deps.bus, ctx.run.id, [
      { type: 'run.failed', payload: { reason, detail } },
    ]);
    await this.transition(ctx, 'failed', reason);
  }

  /** Human cancellation (§4.2): kills the active Job and records the transition. */
  async cancel(runId: string, by: string, reason: string): Promise<RunProjection> {
    const ctx = await this.load(runId);
    if (!ctx) throw new Error('run not found');
    if (isTerminal(ctx.projection.stage)) return ctx.projection;
    for (const inv of ctx.invocations) {
      if (inv.status === 'pending' || inv.status === 'running') {
        await this.deps.spawner.kill(inv.id);
        await markInvocationStatus(this.deps.db, inv.id, 'cancelled');
      }
    }
    const { projection } = await appendEvents(this.deps.db, this.deps.bus, runId, [
      { type: 'run.cancelled', payload: { by, reason } },
      {
        type: 'run.stage_changed',
        payload: { from: ctx.projection.stage, to: 'cancelled', reason: reason || 'cancelled' },
      },
    ]);
    return projection ?? (await projectRunById(this.deps.db, runId));
  }
}
