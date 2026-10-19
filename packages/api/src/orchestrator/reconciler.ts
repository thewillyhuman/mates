import {
  assertTransition,
  branchName,
  intakeOutputSchema,
  isTerminal,
  verdictOutputSchema,
  type ClaudeResult,
  type Mate,
  type NewEvent,
  type RunProjection,
  type Stage,
  type TeamManifest,
} from '@mates/core';
import type { Pool } from '../db/pool.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../runs/bus.js';
import { appendEvents, projectRunById } from '../runs/events.js';
import { listInvocations, markInvocationStatus, type Invocation } from '../runs/invocations.js';
import { markNudgesConsumed } from '../runs/nudges.js';
import {
  findRun,
  findTicket,
  updateTicketRepo,
  type Run,
  type Ticket,
} from '../runs/repository.js';
import type { Settings } from '../settings/schema.js';
import type { SettingsService } from '../settings/service.js';
import type { TeamContextService } from '../team-context/service.js';
import type { MergeRequests, MrTarget } from './merge-requests.js';
import { INFRA_REASONS } from './monitor.js';
import type { InvocationSpawner } from './spawner.js';
import type { TrackerSync } from './tracker-sync.js';

/**
 * The reconcile loop (§5.1 item 2, §7.5). Every 5 s and on every event it
 * looks at each non-terminal run, derives the next action from the
 * projection alone, and performs it. Runs are claimed with a per-run
 * advisory lock (decision 0013), so overlapping passes never act twice.
 */
export interface ReconcilerDeps {
  db: Pool;
  bus: EventBus;
  log: Logger;
  settings: SettingsService;
  teamContext: TeamContextService;
  spawner: InvocationSpawner;
  mergeRequests: MergeRequests;
  trackerSync: TrackerSync;
  intervalMs?: number;
  now?: () => Date;
}

export interface RunContext {
  run: Run;
  ticket: Ticket;
  projection: RunProjection;
  invocations: Invocation[];
}

const CLARIFICATION_LIMIT = 3;

export class Orchestrator {
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly pending = new Set<string>();
  private busy = false;

  constructor(protected readonly deps: ReconcilerDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.reconcileAll(), this.deps.intervalMs ?? 5000);
    this.timer.unref();
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

  /** Reconciles one run under its advisory lock; returns false if another pass holds it. */
  async reconcileRun(runId: string): Promise<boolean> {
    const client = await this.deps.db.connect();
    try {
      const got = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
        [runId],
      );
      if (!got.rows[0]?.ok) return false;
      try {
        // Act until the run needs nothing more (an outcome may enable the next step at once).
        for (let step = 0; step < 4; step++) {
          const ctx = await this.load(runId);
          if (!ctx || isTerminal(ctx.projection.stage)) break;
          if (!(await this.decide(ctx))) break;
        }
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

  /** One decision; returns true when it acted (so the caller re-evaluates). */
  protected async decide(ctx: RunContext): Promise<boolean> {
    const p = ctx.projection;
    const failed = this.unhandledFailure(ctx);
    if (failed) {
      await this.handleFailure(ctx, failed);
      return true;
    }
    if (p.currentInvocation) return false;
    const finished = this.unprocessedResult(ctx);
    if (finished) {
      await this.processResult(ctx, finished);
      return true;
    }
    if (p.paused || p.stage === 'blocked') return false;
    return this.nextStep(ctx);
  }

  /**
   * The last invocation when the runner reported `invocation.finished`
   * (whatever Claude's exit code) and no outcome has been recorded yet.
   */
  protected unprocessedResult(ctx: RunContext): Invocation | undefined {
    const last = ctx.invocations.at(-1);
    if (!last || (last.status !== 'succeeded' && last.status !== 'failed')) return undefined;
    const view = ctx.projection.invocations.find((i) => i.id === last.id);
    if (!view || view.outcomeRecorded || view.finishedAt === null) return undefined;
    return view.failure === null ? last : undefined;
  }

  /** The last invocation when the runner or the monitor reported `invocation.failed` and nothing acted on it. */
  protected unhandledFailure(ctx: RunContext): Invocation | undefined {
    const last = ctx.invocations.at(-1);
    if (!last || (last.status !== 'failed' && last.status !== 'timed_out')) return undefined;
    const view = ctx.projection.invocations.find((i) => i.id === last.id);
    return view && view.status === 'failed' && view.failure !== null && !view.outcomeRecorded
      ? last
      : undefined;
  }

  protected async handleFailure(ctx: RunContext, inv: Invocation): Promise<void> {
    const view = ctx.projection.invocations.find((i) => i.id === inv.id)!;
    const reason = view.failure?.reason ?? 'unknown';
    const infra = INFRA_REASONS.has(reason) || inv.status === 'timed_out';
    if (reason === 'cancelled') return;
    if (infra && inv.attempt === 0) {
      this.deps.log.warn(
        { run_id: ctx.run.id, invocation_id: inv.id, reason },
        'infra failure; retrying once',
      );
      await this.spawn(ctx, inv.mate, inv.iteration, 1);
      return;
    }
    await this.failRun(
      ctx,
      infra ? `${reason} (after retry)` : reason,
      view.failure?.detail ?? '',
      inv.id,
    );
  }

  // ---------------------------------------------------------------- next step

  /** Derives and performs the next step from the projection (§7.5). */
  protected async nextStep(ctx: RunContext): Promise<boolean> {
    const p = ctx.projection;
    if (!p.intake) {
      if (p.clarificationRounds >= CLARIFICATION_LIMIT) {
        await this.failRun(
          ctx,
          'clarification_limit',
          `${CLARIFICATION_LIMIT} clarification rounds without an implementable ticket`,
        );
        return true;
      }
      await this.transition(
        ctx,
        'intake',
        p.clarificationRounds ? 'clarification_answered' : 'scheduled',
      );
      await this.spawn(ctx, 'intake', 0, 0);
      return true;
    }
    const it = p.iterations.at(-1);
    if (!it) return this.startImplementer(ctx, 1);
    if (it.pushed && !it.verdict) {
      // A push without changes and without a verdict is an iteration cut short
      // (budget stop); run the implementer again for the same iteration.
      if (!it.pushed.changed_in_iteration) return this.startImplementer(ctx, it.n);
      // Implementer done and its outcome recorded; the reviewer is next.
      if (!(await this.withinBudget(ctx))) return true;
      if (p.stage !== 'reviewing') await this.transition(ctx, 'reviewing', 'pushed');
      await this.spawn(ctx, 'reviewer', it.n, 0);
      return true;
    }
    if (it.verdict?.decision === 'approve') return false; // processResult already finished the run
    if (it.verdict?.decision === 'changes_requested') {
      if (it.n >= p.maxIterations + p.capResumes) {
        await this.blockAtCap(ctx);
        return true;
      }
      return this.startImplementer(ctx, it.n + 1);
    }
    // Iteration scheduled but nothing pushed and nothing running: the implementer failed and was handled, or crashed silently.
    return this.startImplementer(ctx, it.n);
  }

  protected async startImplementer(ctx: RunContext, iteration: number): Promise<boolean> {
    if (!(await this.withinBudget(ctx))) return true;
    if (ctx.projection.stage !== 'implementing')
      await this.transition(
        ctx,
        'implementing',
        iteration === 1 ? 'intake_passed' : 'changes_requested',
      );
    await this.spawn(ctx, 'implementer', iteration, 0);
    return true;
  }

  /** Rule 7 and §9.4: per-run budget blocks; the daily budget keeps the run queued. */
  protected async withinBudget(ctx: RunContext): Promise<boolean> {
    const p = ctx.projection;
    if (p.budgetUsd !== null && p.usage.costUsd >= p.budgetUsd) {
      await this.blockForBudget(ctx, p.budgetUsd, p.usage.costUsd);
      return false;
    }
    const settings = await this.deps.settings.get();
    const today = await this.spentToday(settings.limits.timezone);
    if (today >= settings.limits.per_day_usd) {
      this.deps.log.warn(
        { run_id: ctx.run.id, spent_today: today, limit: settings.limits.per_day_usd },
        'daily budget reached; run stays queued',
      );
      if (p.stage !== 'queued' && p.stage !== 'implementing' && p.stage !== 'reviewing')
        return false;
      return false;
    }
    return true;
  }

  async spentToday(timezone: string): Promise<number> {
    const r = await this.deps.db.query<{ usd: string }>(
      `SELECT COALESCE(sum((payload->>'cost_usd')::numeric), 0)::text AS usd FROM events
       WHERE type = 'usage.recorded' AND ts >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)`,
      [timezone],
    );
    return Number(r.rows[0]?.usd ?? 0);
  }

  // ---------------------------------------------------------------- results

  protected async processResult(ctx: RunContext, inv: Invocation): Promise<void> {
    const result = await this.resultOf(inv.id);
    await this.recordUsage(ctx, inv, result);
    const settings = await this.deps.settings.get();
    if (!result) {
      await this.failRun(
        ctx,
        'claude_exited',
        `claude exited with code ${inv.exitCode ?? '?'} without a result`,
        inv.id,
      );
      return;
    }
    if (result.is_error) {
      if (/budget/i.test(`${result.subtype ?? ''} ${result.result ?? ''}`)) {
        await this.blockForBudget(
          ctx,
          settings.mates[inv.mate].max_budget_usd,
          result.total_cost_usd ?? 0,
          inv.id,
        );
      } else {
        await this.failRun(
          ctx,
          'claude_error',
          `${result.subtype ?? 'error'}: ${(result.result ?? '').slice(0, 500)}`,
          inv.id,
        );
      }
      return;
    }
    switch (inv.mate) {
      case 'intake':
        return this.processIntake(ctx, inv, result, settings);
      case 'implementer':
        return this.processImplementer(ctx, inv, result, settings);
      case 'reviewer':
        return this.processReviewer(ctx, inv, result, settings);
    }
  }

  private async resultOf(invocationId: string): Promise<ClaudeResult | null> {
    const r = await this.deps.db.query<{ result_json: ClaudeResult | null }>(
      'SELECT result_json FROM invocations WHERE id = $1',
      [invocationId],
    );
    return r.rows[0]?.result_json ?? null;
  }

  /** §9.1: the final result is the source of usage; M5 adds the computed cost. */
  protected async recordUsage(
    ctx: RunContext,
    inv: Invocation,
    result: ClaudeResult | null,
  ): Promise<void> {
    if (!result?.usage && result?.total_cost_usd === undefined) return;
    const u = result.usage ?? {};
    await appendEvents(this.deps.db, this.deps.bus, ctx.run.id, [
      {
        type: 'usage.recorded',
        payload: {
          model: inv.model,
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          cache_read_tokens: u.cache_read_input_tokens ?? 0,
          cache_write_tokens: u.cache_creation_input_tokens ?? 0,
          cost_usd: result.total_cost_usd ?? null,
        },
        invocation_id: inv.id,
      },
    ]);
    ctx.projection = await projectRunById(this.deps.db, ctx.run.id);
  }

  protected async processIntake(
    ctx: RunContext,
    inv: Invocation,
    result: ClaudeResult | null,
    settings: Settings,
  ): Promise<void> {
    const parsed = intakeOutputSchema.safeParse(result?.structured_output);
    if (!parsed.success) {
      await this.failRun(
        ctx,
        'intake_invalid_output',
        `intake returned no valid structured output: ${parsed.error.message.slice(0, 300)}`,
        inv.id,
      );
      return;
    }
    const out = parsed.data;
    const manifest = (await this.deps.teamContext.active())?.manifest;
    if (out.decision === 'implementable') {
      const repo = manifest?.repos.find((r) => r.id === out.repo_id);
      if (!repo) {
        await this.failRun(
          ctx,
          'intake_unknown_repo',
          `intake chose repository "${out.repo_id ?? ''}" which is not in mates.yaml`,
          inv.id,
        );
        return;
      }
      await updateTicketRepo(this.deps.db, ctx.ticket.id, repo.id);
      await this.append(ctx, [
        {
          type: 'intake.passed',
          payload: {
            repo: repo.id,
            base_branch: out.base_branch ?? repo.default_branch,
            plan: out.plan,
            scope_notes: out.reasoning_summary,
          },
          invocation_id: inv.id,
        },
      ]);
      return;
    }
    if (out.decision === 'needs_clarification') {
      const questions = out.questions.length ? out.questions : [out.reasoning_summary];
      const text = `This ticket needs clarification before I can implement it:\n\n${questions.map((q) => `- ${q}`).join('\n')}\n\nReply in a comment and I will pick it up again.`;
      const { events, commentId } = await this.deps.trackerSync.comment(
        ctx.ticket.externalKey,
        ctx.run.id,
        text,
        'clarification',
        settings,
      );
      await this.append(ctx, [
        {
          type: 'intake.needs_clarification',
          payload: { questions, tracker_comment_id: commentId },
          invocation_id: inv.id,
        },
        ...events,
      ]);
      await this.transition(ctx, 'blocked', 'needs_clarification');
      return;
    }
    const { events } = await this.deps.trackerSync.comment(
      ctx.ticket.externalKey,
      ctx.run.id,
      `I cannot take this ticket: ${out.reasoning_summary}`,
      'status',
      settings,
    );
    await this.append(ctx, events);
    await this.failRun(ctx, 'out_of_scope', out.reasoning_summary, inv.id);
  }

  protected async processImplementer(
    ctx: RunContext,
    inv: Invocation,
    _result: ClaudeResult | null,
    settings: Settings,
  ): Promise<void> {
    const p = ctx.projection;
    const it = p.iterations.find((i) => i.n === inv.iteration);
    if (!it?.pushed) {
      await this.failRun(
        ctx,
        'no_push_report',
        'implementer finished without reporting a push',
        inv.id,
      );
      return;
    }
    if (!it.pushed.changed_in_iteration) {
      // Rule 5: one synthetic verdict, then failure.
      if (p.emptyIterations >= 2) {
        await this.failRun(
          ctx,
          'empty_diff',
          'two implementer iterations produced no changes',
          inv.id,
        );
        return;
      }
      await this.append(ctx, [
        {
          type: 'review.verdict',
          payload: {
            decision: 'changes_requested',
            blocking: [
              {
                id: 'B0',
                title: 'No changes produced',
                detail:
                  'The implementer finished without changing any file. Implement the ticket or explain in the final message why nothing is needed.',
                file: null,
                line: null,
              },
            ],
            non_blocking: [],
            summary: 'No changes were produced in this iteration.',
          },
          invocation_id: inv.id,
        },
      ]);
      return;
    }
    await this.syncMergeRequest(ctx, inv.id, settings);
  }

  /** Opens the draft MR on the first push, refreshes the description afterwards (§8.3). */
  protected async syncMergeRequest(
    ctx: RunContext,
    invocationId: string,
    settings: Settings,
    draft?: boolean,
  ): Promise<void> {
    const p = ctx.projection;
    const target = await this.mrTarget(ctx, settings);
    if (!target) {
      // No SCM configured: record the outcome so the loop continues without an MR.
      await this.append(ctx, [
        {
          type: 'mr.updated',
          payload: { description_updated: false },
          invocation_id: invocationId,
        },
      ]);
      return;
    }
    const baseBranch = p.intake?.base_branch ?? target.repo.defaultBranch;
    try {
      if (!p.mr) {
        const mr = await this.deps.mergeRequests.open(target, {
          run: { id: ctx.run.id, branch: ctx.run.branch! },
          ticket: ctx.ticket,
          projection: p,
          baseBranch,
          settings,
        });
        await this.append(ctx, [
          {
            type: 'mr.opened',
            payload: { mr_id: mr.id, url: mr.url, draft: mr.state === 'draft' },
            invocation_id: invocationId,
          },
        ]);
      } else {
        const updateInput = {
          run: { id: ctx.run.id },
          ticket: ctx.ticket,
          projection: p,
          settings,
          ...(draft !== undefined ? { draft } : {}),
        };
        await this.deps.mergeRequests.update(target, p.mr.id, updateInput);
        await this.append(ctx, [
          {
            type: 'mr.updated',
            payload: { description_updated: true },
            invocation_id: invocationId,
          },
        ]);
      }
    } catch (err) {
      await this.failRun(ctx, 'mr_failed', (err as Error).message, invocationId);
    }
  }

  private async mrTarget(ctx: RunContext, settings: Settings): Promise<MrTarget | undefined> {
    const repoId = ctx.projection.intake?.repo;
    const manifest = (await this.deps.teamContext.active())?.manifest;
    if (!repoId || !manifest) return undefined;
    return this.deps.mergeRequests.target(manifest, settings, repoId);
  }

  protected async processReviewer(
    ctx: RunContext,
    inv: Invocation,
    result: ClaudeResult | null,
    settings: Settings,
  ): Promise<void> {
    const parsed = verdictOutputSchema.safeParse(result?.structured_output);
    if (!parsed.success) {
      await this.failRun(
        ctx,
        'review_invalid_output',
        `reviewer returned no valid verdict: ${parsed.error.message.slice(0, 300)}`,
        inv.id,
      );
      return;
    }
    const v = parsed.data;
    const decision =
      v.decision === 'approve' && v.blocking.length > 0 ? 'changes_requested' : v.decision;
    await this.append(ctx, [
      {
        type: 'review.verdict',
        payload: {
          decision,
          blocking: v.blocking,
          non_blocking: v.non_blocking,
          summary: v.summary,
        },
        invocation_id: inv.id,
      },
    ]);
    await this.deps.db.query(
      `INSERT INTO verdicts (invocation_id, run_id, iteration, decision, blocking, non_blocking, summary, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        inv.id,
        ctx.run.id,
        inv.iteration,
        decision,
        JSON.stringify(v.blocking),
        JSON.stringify(v.non_blocking),
        v.summary,
        JSON.stringify(v),
      ],
    );
    ctx.projection = await projectRunById(this.deps.db, ctx.run.id);
    if (decision === 'approve') await this.finishApproved(ctx, inv.id, settings);
  }

  /** Rule 2: description, mark ready, Jira, `mr_ready` → `done`. */
  protected async finishApproved(
    ctx: RunContext,
    invocationId: string,
    settings: Settings,
  ): Promise<void> {
    const target = await this.mrTarget(ctx, settings);
    const p = ctx.projection;
    if (target && p.mr) {
      try {
        const mr = await this.deps.mergeRequests.update(target, p.mr.id, {
          run: { id: ctx.run.id },
          ticket: ctx.ticket,
          projection: p,
          settings,
          draft: false,
        });
        await this.append(ctx, [
          {
            type: 'mr.updated',
            payload: { description_updated: true },
            invocation_id: invocationId,
          },
          { type: 'mr.marked_ready', payload: { mr_id: mr.id } },
        ]);
      } catch (err) {
        await this.failRun(ctx, 'mr_failed', (err as Error).message, invocationId);
        return;
      }
    }
    await this.transition(ctx, 'mr_ready', 'approved');
    const link = ctx.projection.mr ? ` Merge request: ${ctx.projection.mr.url}.` : '';
    const { events } = await this.deps.trackerSync.comment(
      ctx.ticket.externalKey,
      ctx.run.id,
      `The change is ready for human review.${link}${this.deps.trackerSync.costLine(ctx.projection, settings)}`,
      'status',
      settings,
    );
    await this.append(ctx, events);
    await this.transition(ctx, 'done', 'mr_ready');
  }

  /** Rule 4: cap reached — draft stays, unresolved points in the description, Jira comment. */
  protected async blockAtCap(ctx: RunContext): Promise<void> {
    const settings = await this.deps.settings.get();
    await this.transition(ctx, 'blocked', 'iteration_cap');
    const target = await this.mrTarget(ctx, settings);
    if (target && ctx.projection.mr) {
      await this.deps.mergeRequests
        .update(target, ctx.projection.mr.id, {
          run: { id: ctx.run.id },
          ticket: ctx.ticket,
          projection: ctx.projection,
          settings,
        })
        .then(() =>
          this.append(ctx, [{ type: 'mr.updated', payload: { description_updated: true } }]),
        )
        .catch((err: Error) =>
          this.deps.log.warn({ err, run_id: ctx.run.id }, 'could not update MR at cap'),
        );
    }
    const open = ctx.projection.lastVerdict?.blocking.length ?? 0;
    const link = ctx.projection.mr
      ? ` The draft merge request ${ctx.projection.mr.url} stays open.`
      : '';
    const { events } = await this.deps.trackerSync.comment(
      ctx.ticket.externalKey,
      ctx.run.id,
      `Iteration cap reached (${ctx.projection.iteration}/${ctx.projection.maxIterations}) with ${open} unresolved review point${open === 1 ? '' : 's'}.${link} Nudge or retry from Mates to continue.${this.deps.trackerSync.costLine(ctx.projection, settings)}`,
      'status',
      settings,
    );
    await this.append(ctx, events);
  }

  protected async blockForBudget(
    ctx: RunContext,
    limit: number,
    used: number,
    invocationId?: string,
  ): Promise<void> {
    const settings = await this.deps.settings.get();
    await this.append(ctx, [
      {
        type: 'run.budget_exceeded',
        payload: { kind: 'usd', limit, used },
        ...(invocationId ? { invocation_id: invocationId } : {}),
      },
    ]);
    await this.transition(ctx, 'blocked', 'budget_exceeded');
    const { events } = await this.deps.trackerSync.comment(
      ctx.ticket.externalKey,
      ctx.run.id,
      `Budget exceeded ($${used.toFixed(2)} of $${limit.toFixed(2)}). Raise the budget and retry from Mates to continue.`,
      'status',
      settings,
    );
    await this.append(ctx, events);
  }

  // ---------------------------------------------------------------- spawning

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
      const inv = await this.deps.spawner.spawn({
        runId: ctx.run.id,
        mate,
        iteration,
        attempt,
        settings,
        manifest,
        repoId,
        scmProviderId: repo?.scm ?? null,
      });
      if (mate === 'implementer' && attempt === 0) {
        const pending = ctx.projection.pendingNudges;
        if (pending.length) {
          await markNudgesConsumed(
            this.deps.db,
            pending.map((n) => n.id),
            inv.id,
          );
          await this.append(
            ctx,
            pending.map((n): NewEvent => ({
              type: 'nudge.consumed',
              payload: { nudge_id: n.id, invocation_id: inv.id },
            })),
          );
        }
      }
    } catch (err) {
      this.deps.log.error({ err, run_id: ctx.run.id, mate }, 'spawn failed');
      const invs = await listInvocations(this.deps.db, ctx.run.id);
      const last = invs.at(-1);
      if (last && last.status === 'pending' && last.mate === mate && last.attempt === attempt) {
        await markInvocationStatus(this.deps.db, last.id, 'failed');
        await this.append(ctx, [
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

  protected candidateRepo(
    ctx: RunContext,
    manifest: TeamManifest,
  ): TeamManifest['repos'][number] | undefined {
    const project = ctx.ticket.projectKey ?? ctx.ticket.externalKey.split('-')[0];
    const matches = manifest.repos.filter((r) => r.jira_projects.includes(project ?? ''));
    return matches.length === 1 ? matches[0] : undefined;
  }

  protected async ensureBranch(ctx: RunContext, manifest: TeamManifest): Promise<void> {
    if (ctx.run.branch) return;
    const branch = branchName(manifest.branching.pattern, ctx.ticket.externalKey, ctx.ticket.title);
    await this.deps.db.query(
      'UPDATE runs SET branch = $2, team_context_version = COALESCE(team_context_version, $3) WHERE id = $1',
      [ctx.run.id, branch, (await this.deps.teamContext.active())?.version ?? null],
    );
    ctx.run = { ...ctx.run, branch };
  }

  // ---------------------------------------------------------------- primitives

  protected async append(ctx: RunContext, events: NewEvent[]): Promise<void> {
    if (events.length === 0) return;
    const { projection } = await appendEvents(this.deps.db, this.deps.bus, ctx.run.id, events);
    ctx.projection = projection ?? (await projectRunById(this.deps.db, ctx.run.id));
  }

  protected async transition(ctx: RunContext, to: Stage, reason: string): Promise<void> {
    const from = ctx.projection.stage;
    assertTransition(from, to);
    await this.append(ctx, [{ type: 'run.stage_changed', payload: { from, to, reason } }]);
    const settings = await this.deps.settings.get();
    await this.append(
      ctx,
      await this.deps.trackerSync.onStage(
        ctx.ticket.externalKey,
        to,
        settings,
        ctx.projection.trackerStatus,
      ),
    );
  }

  protected async failRun(
    ctx: RunContext,
    reason: string,
    detail: string,
    invocationId?: string,
  ): Promise<void> {
    this.deps.log.error({ run_id: ctx.run.id, reason, detail }, 'run failed');
    await this.append(ctx, [
      {
        type: 'run.failed',
        payload: { reason, detail },
        ...(invocationId ? { invocation_id: invocationId } : {}),
      },
    ]);
    await this.transition(ctx, 'failed', reason);
    const settings = await this.deps.settings.get();
    const { events } = await this.deps.trackerSync.comment(
      ctx.ticket.externalKey,
      ctx.run.id,
      `The run failed: ${reason}. ${detail}`.trim(),
      'status',
      settings,
    );
    await this.append(ctx, events);
  }

  // ---------------------------------------------------------------- human actions

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
    await this.append(ctx, [{ type: 'run.cancelled', payload: { by, reason } }]);
    await this.transition(ctx, 'cancelled', reason || 'cancelled');
    return ctx.projection;
  }

  async pause(runId: string, by: string): Promise<RunProjection> {
    const ctx = await this.load(runId);
    if (!ctx) throw new Error('run not found');
    if (!ctx.projection.paused && !isTerminal(ctx.projection.stage))
      await this.append(ctx, [{ type: 'run.paused', payload: { by } }]);
    return ctx.projection;
  }

  async resume(runId: string, by: string): Promise<RunProjection> {
    const ctx = await this.load(runId);
    if (!ctx) throw new Error('run not found');
    if (ctx.projection.paused) await this.append(ctx, [{ type: 'run.resumed', payload: { by } }]);
    return ctx.projection;
  }

  /** `blocked → queued` (decision 0015), optionally with a raised budget. */
  async retry(runId: string, by: string, budgetUsd?: number): Promise<RunProjection> {
    const ctx = await this.load(runId);
    if (!ctx) throw new Error('run not found');
    if (ctx.projection.stage !== 'blocked') return ctx.projection;
    const events: NewEvent[] = [];
    if (budgetUsd !== undefined) {
      await this.deps.db.query('UPDATE runs SET budget_usd = $2 WHERE id = $1', [runId, budgetUsd]);
      events.push({ type: 'run.budget_changed', payload: { budget_usd: budgetUsd, by } });
    }
    await this.append(ctx, events);
    await this.transition(ctx, 'queued', 'retry');
    return ctx.projection;
  }
}
