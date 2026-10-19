import type { Pool } from '../db/pool.js';
import type { JobsClient, JobView, PodView } from '../kubernetes/jobs.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../runs/bus.js';
import { appendEvents } from '../runs/events.js';
import { findInvocation, listInvocations, markInvocationStatus } from '../runs/invocations.js';
import { tokenSecretName } from './spawner.js';

/**
 * Translates Job/pod state into `invocation.*` events (§5.1 item 3,
 * decision 0013): a periodic list instead of a watch, every `intervalMs`.
 *
 * - Job failed with DeadlineExceeded → `timed_out`
 * - pod evicted / image pull failure / container exit ≠ 0 without a runner
 *   report → `evicted` / `image_pull` / `pod_failed`
 * - Job succeeded but no `invocation.finished` after the grace period →
 *   `runner_exited_without_report`
 * - orphan token Secrets are deleted
 */
export interface MonitorDeps {
  db: Pool;
  bus: EventBus;
  jobs: JobsClient;
  log: Logger;
  intervalMs?: number;
  /** How long a finished Job may wait for the runner's own report. */
  graceMs?: number;
  now?: () => number;
}

export const INFRA_REASONS = new Set([
  'timed_out',
  'evicted',
  'image_pull',
  'pod_failed',
  'runner_exited_without_report',
  'setup_failed',
  'context_download_failed',
  'clone_failed',
  'checkout_failed',
  'spawn_failed',
  'job_missing',
]);

export class JobMonitor {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly seenFinishedAt = new Map<string, number>();

  constructor(private readonly deps: MonitorDeps) {}

  start(): void {
    const interval = this.deps.intervalMs ?? 10_000;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass; safe to call from tests. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = await this.deps.jobs.listJobs();
      for (const job of jobs)
        await this.checkJob(job).catch((err: Error) =>
          this.deps.log.error({ err, job: job.name }, 'job check failed'),
        );
      await this.reapSecrets(jobs).catch((err: Error) =>
        this.deps.log.warn({ err }, 'secret reaping failed'),
      );
    } catch (err) {
      this.deps.log.error({ err }, 'job monitor tick failed');
    } finally {
      this.running = false;
    }
  }

  private async checkJob(job: JobView): Promise<void> {
    if (!job.invocationId) return;
    const inv = await findInvocation(this.deps.db, job.invocationId);
    if (!inv || (inv.status !== 'pending' && inv.status !== 'running')) return;
    const now = this.deps.now?.() ?? Date.now();
    const grace = this.deps.graceMs ?? 60_000;

    if (job.failed > 0) {
      const pods = await this.deps.jobs.listPods(job.name);
      const { reason, detail } = classifyFailure(job, pods);
      await this.fail(inv.id, inv.runId, reason, detail);
      return;
    }
    if (job.succeeded > 0) {
      const first = this.seenFinishedAt.get(job.name) ?? now;
      this.seenFinishedAt.set(job.name, first);
      if (now - first >= grace) {
        await this.fail(
          inv.id,
          inv.runId,
          'runner_exited_without_report',
          'job succeeded but no invocation.finished arrived',
        );
        this.seenFinishedAt.delete(job.name);
      }
      return;
    }
    // Active: fail fast on an image that cannot be pulled.
    const pods = await this.deps.jobs.listPods(job.name);
    const pull = pods.find(
      (p) =>
        p.waitingReason === 'ImagePullBackOff' ||
        p.waitingReason === 'ErrImagePull' ||
        p.waitingReason === 'InvalidImageName',
    );
    if (pull) {
      await this.fail(inv.id, inv.runId, 'image_pull', `${pull.waitingReason} for ${pull.name}`);
      await this.deps.jobs.deleteJob(job.name);
    }
  }

  private async fail(
    invocationId: string,
    runId: string,
    reason: string,
    detail: string,
  ): Promise<void> {
    this.deps.log.warn(
      { invocation_id: invocationId, run_id: runId, reason, detail },
      'invocation failed (kubernetes)',
    );
    await markInvocationStatus(
      this.deps.db,
      invocationId,
      reason === 'timed_out' ? 'timed_out' : 'failed',
    );
    await appendEvents(this.deps.db, this.deps.bus, runId, [
      { type: 'invocation.failed', payload: { reason, detail }, invocation_id: invocationId },
    ]);
  }

  private async reapSecrets(jobs: JobView[]): Promise<void> {
    const alive = new Set(jobs.map((j) => j.invocationId).filter(Boolean));
    for (const name of await this.deps.jobs.listTokenSecrets()) {
      const owner = [...alive].find((id) => id && tokenSecretName(id) === name);
      if (owner) continue;
      // Only reap secrets whose invocation is no longer pending/running.
      const stillNeeded = await this.secretStillNeeded(name);
      if (!stillNeeded) await this.deps.jobs.deleteSecret(name);
    }
  }

  private async secretStillNeeded(secretName: string): Promise<boolean> {
    const r = await this.deps.db.query<{ id: string; run_id: string }>(
      `SELECT id, run_id FROM invocations WHERE status IN ('pending', 'running') AND created_at > now() - interval '1 day'`,
    );
    return r.rows.some((row) => tokenSecretName(row.id) === secretName);
  }

  /** Invocations with no Job at all (API crashed between row and Job) are failed after the grace period. */
  async failOrphans(): Promise<void> {
    const jobs = new Set((await this.deps.jobs.listJobs()).map((j) => j.name));
    const r = await this.deps.db.query<{ run_id: string }>(
      `SELECT DISTINCT run_id FROM invocations WHERE status IN ('pending', 'running') AND created_at < now() - interval '2 minutes'`,
    );
    for (const row of r.rows) {
      for (const inv of await listInvocations(this.deps.db, row.run_id)) {
        if ((inv.status === 'pending' || inv.status === 'running') && !jobs.has(inv.jobName)) {
          await this.fail(inv.id, inv.runId, 'job_missing', `no Job ${inv.jobName} exists`);
        }
      }
    }
  }
}

export function classifyFailure(job: JobView, pods: PodView[]): { reason: string; detail: string } {
  if (job.failureReason === 'DeadlineExceeded') {
    return { reason: 'timed_out', detail: job.failureMessage ?? 'activeDeadlineSeconds exceeded' };
  }
  const pod = pods[0];
  if (pod?.reason === 'Evicted' || pod?.terminatedReason === 'Evicted')
    return { reason: 'evicted', detail: `pod ${pod.name} evicted` };
  if (pod?.waitingReason && /ImagePull|InvalidImageName/.test(pod.waitingReason)) {
    return { reason: 'image_pull', detail: `${pod.waitingReason} for ${pod.name}` };
  }
  if (pod?.terminatedReason === 'OOMKilled')
    return { reason: 'pod_failed', detail: `pod ${pod.name} OOMKilled` };
  return {
    reason: 'pod_failed',
    detail:
      `${job.failureReason ?? 'Failed'}: ${job.failureMessage ?? ''}${pod?.exitCode !== null && pod?.exitCode !== undefined ? ` (exit ${pod.exitCode})` : ''}`.trim(),
  };
}
