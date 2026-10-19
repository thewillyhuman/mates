import type { RunEvent } from '@mates/core';
import type { Pool } from './db/pool.js';
import type { Logger } from './logger.js';
import type { EventBus } from './runs/bus.js';
import { findRun, findTicket } from './runs/repository.js';
import type { SettingsService } from './settings/service.js';

/**
 * Generic webhook notifications (§6.2 step 7): Slack-compatible JSON
 * (`text` plus a small `blocks` list) on the five events the spec names.
 * Delivery is best effort with a short retry; failures are logged, never
 * fatal.
 */
export interface NotifierDeps {
  db: Pool;
  bus: EventBus;
  settings: SettingsService;
  log: Logger;
  publicUrl: string;
  fetch?: typeof fetch;
}

const NOTIFY_TYPES = new Set([
  'intake.needs_clarification',
  'run.failed',
  'run.budget_exceeded',
  'mr.marked_ready',
  'run.stage_changed',
]);

export interface Notification {
  event: string;
  text: string;
  run_id: string;
  ticket: string;
  url: string;
}

export class Notifier {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: NotifierDeps) {
    this.fetchFn = deps.fetch ?? fetch;
  }

  subscribe(): () => void {
    return this.deps.bus.subscribe('*', (events) => void this.handle(events));
  }

  /** Builds the message for an event, or null when it is not one we announce. */
  async describe(e: RunEvent): Promise<Notification | null> {
    if (!NOTIFY_TYPES.has(e.type)) return null;
    if (e.type === 'run.stage_changed' && e.payload.to !== 'blocked') return null;
    const run = await findRun(this.deps.db, e.run_id);
    if (!run) return null;
    const ticket = await findTicket(this.deps.db, run.ticketId);
    const key = ticket?.externalKey ?? e.run_id;
    const url = `${this.deps.publicUrl}/runs/${e.run_id}`;
    let text: string;
    switch (e.type) {
      case 'intake.needs_clarification':
        text = `${key}: Mates needs clarification — ${e.payload.questions[0] ?? 'see the ticket'}`;
        break;
      case 'run.stage_changed':
        text = `${key}: run blocked (${e.payload.reason.replace(/_/g, ' ')})`;
        break;
      case 'mr.marked_ready':
        text = `${key}: merge request ${e.payload.mr_id} is ready for human review`;
        break;
      case 'run.failed':
        text = `${key}: run failed — ${e.payload.reason}`;
        break;
      case 'run.budget_exceeded':
        text = `${key}: budget exceeded ($${e.payload.used.toFixed(2)} of $${e.payload.limit.toFixed(2)})`;
        break;
      default:
        return null;
    }
    return { event: e.type, text, run_id: e.run_id, ticket: key, url };
  }

  private async handle(events: readonly RunEvent[]): Promise<void> {
    const url = (await this.deps.settings.get()).notifications.webhook_url;
    if (!url) return;
    for (const e of events) {
      const n = await this.describe(e).catch(() => null);
      if (n) await this.send(url, n);
    }
  }

  async send(url: string, n: Notification): Promise<boolean> {
    const body = JSON.stringify({
      text: `${n.text} — ${n.url}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${n.ticket}* ${n.text.slice(n.ticket.length + 2)}\n<${n.url}|Open in Mates>`,
          },
        },
      ],
      mates: { event: n.event, run_id: n.run_id, ticket: n.ticket, url: n.url },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return true;
        this.deps.log.warn({ status: res.status, event: n.event }, 'notification webhook rejected');
      } catch (err) {
        this.deps.log.warn({ err, event: n.event }, 'notification webhook failed');
      }
    }
    return false;
  }
}
