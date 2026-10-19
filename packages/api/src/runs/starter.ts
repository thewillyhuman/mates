import type { Pool } from '../db/pool.js';
import type { Integrations } from '../integrations.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../settings/service.js';
import type { Ticket as TrackerTicket } from '../tracker/tracker.js';
import { ticketDetailsSchema } from '../tracker/types.js';
import type { EventBus } from './bus.js';
import { appendEvents, projectRunById } from './events.js';
import {
  createRun,
  findTicketByKey,
  findActiveRunForTicket,
  updateTicketDetails,
  type CreateRunResult,
} from './repository.js';

/**
 * Starts runs from tracker triggers (§5.1 item 1) and handles the
 * clarification round-trip (§8.2): a non-Mates comment on a ticket whose
 * run is blocked on a question sends the run back to `queued`.
 */
export interface RunStarterDeps {
  db: Pool;
  bus: EventBus;
  settings: SettingsService;
  integrations: Integrations;
  log: Logger;
}

export class RunStarter {
  constructor(private readonly deps: RunStarterDeps) {}

  /** Fetches the ticket when a tracker is configured, then creates the run (idempotent per ticket). */
  async start(
    key: string,
    trigger: 'webhook' | 'poll' | 'manual',
    by: string,
  ): Promise<CreateRunResult> {
    const settings = await this.deps.settings.get();
    const tracker = await this.deps.integrations.tracker();
    const fetched = tracker ? await this.fetchTicket(tracker, key) : undefined;
    const result = await createRun(this.deps.db, this.deps.bus, {
      ticket: fetched
        ? {
            externalKey: fetched.key,
            externalId: fetched.id,
            title: fetched.title,
            url: fetched.url,
            projectKey: fetched.projectKey,
            details: fetched.details,
          }
        : { externalKey: key },
      trigger,
      by,
      maxIterations: settings.limits.max_iterations,
      budgetUsd: settings.limits.per_run_usd,
    });
    if (result.created)
      this.deps.log.info({ run_id: result.run.id, ticket_key: key, trigger }, 'run created');
    return result;
  }

  /**
   * A new comment from someone other than Mates on a ticket whose active
   * run waits for clarification: refresh the ticket and re-queue the run.
   */
  async handleComment(
    key: string,
    comment: { authorIsSelf: boolean; body: string },
  ): Promise<'requeued' | 'ignored'> {
    if (comment.authorIsSelf) return 'ignored';
    const ticket = await findTicketByKey(this.deps.db, key);
    if (!ticket) return 'ignored';
    const run = await findActiveRunForTicket(this.deps.db, ticket.id);
    if (!run) return 'ignored';
    const projection = await projectRunById(this.deps.db, run.id);
    if (projection.stage !== 'blocked' || projection.blockedReason !== 'needs_clarification')
      return 'ignored';
    const tracker = await this.deps.integrations.tracker();
    if (tracker) {
      const fresh = await this.fetchTicket(tracker, key);
      if (fresh) await updateTicketDetails(this.deps.db, ticket.id, fresh.details);
    }
    await appendEvents(this.deps.db, this.deps.bus, run.id, [
      {
        type: 'run.stage_changed',
        payload: { from: 'blocked', to: 'queued', reason: 'clarification_answered' },
      },
    ]);
    this.deps.log.info(
      { run_id: run.id, ticket_key: key },
      'clarification answered; run re-queued',
    );
    return 'requeued';
  }

  private async fetchTicket(
    tracker: NonNullable<Awaited<ReturnType<Integrations['tracker']>>>,
    key: string,
  ): Promise<TrackerTicket | undefined> {
    try {
      const t = await tracker.getTicket(key);
      return { ...t, details: ticketDetailsSchema.parse(t.details) };
    } catch (err) {
      this.deps.log.warn(
        { err, ticket_key: key },
        'could not fetch ticket from tracker; using placeholder',
      );
      return undefined;
    }
  }
}
