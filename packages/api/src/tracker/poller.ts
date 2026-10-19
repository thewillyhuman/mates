import type { Pool } from '../db/pool.js';
import type { Integrations } from '../integrations.js';
import type { Logger } from '../logger.js';
import {
  findActiveRunForTicket,
  findTicketByKey,
  listTicketsWithRunsBlockedOn,
} from '../runs/repository.js';
import type { RunStarter } from '../runs/starter.js';
import type { SettingsService } from '../settings/service.js';

/**
 * Polling fallback (§8.1): every `jira.poll_interval_seconds` lists the
 * tickets matching the trigger rule and starts runs for those without an
 * active one; for runs blocked on a clarification it looks for new
 * comments from humans (§8.2).
 */
export interface PollerDeps {
  db: Pool;
  settings: SettingsService;
  integrations: Integrations;
  starter: RunStarter;
  log: Logger;
  onError?: () => void;
}

export class TrackerPoller {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly deps: PollerDeps) {}

  start(): void {
    const schedule = async () => {
      const s = await this.deps.settings.get().catch(() => undefined);
      const ms = (s?.jira.poll_interval_seconds ?? 60) * 1000;
      this.timer = setTimeout(() => void this.tick().finally(schedule), ms);
      this.timer.unref();
    };
    void schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async tick(): Promise<{ created: number; requeued: number }> {
    if (this.running) return { created: 0, requeued: 0 };
    this.running = true;
    let created = 0;
    let requeued = 0;
    try {
      const tracker = await this.deps.integrations.tracker();
      if (!tracker) return { created, requeued };
      const settings = await this.deps.settings.get();
      const rule = this.deps.integrations.triggerRule(settings);
      if (rule.value.trim()) {
        const refs = await tracker.listTriggered(rule);
        for (const ref of refs) {
          const ticket = await findTicketByKey(this.deps.db, ref.key);
          if (ticket && (await findActiveRunForTicket(this.deps.db, ticket.id))) continue;
          const r = await this.deps.starter.start(ref.key, 'poll', 'jira-poll');
          if (r.created) created += 1;
        }
      }
      for (const t of await listTicketsWithRunsBlockedOn(this.deps.db, 'needs_clarification')) {
        const fresh = await tracker.getTicket(t.externalKey).catch(() => undefined);
        if (!fresh) continue;
        const known = new Set(t.details.comments.map((c: { id: string }) => c.id));
        const prefix = settings.jira.comment_prefix;
        const newHuman = fresh.details.comments.find(
          (c) => !known.has(c.id) && !c.body.startsWith(prefix),
        );
        if (
          newHuman &&
          (await this.deps.starter.handleComment(t.externalKey, {
            authorIsSelf: false,
            body: newHuman.body,
          })) === 'requeued'
        ) {
          requeued += 1;
        }
      }
    } catch (err) {
      this.deps.onError?.();
      this.deps.log.error({ err }, 'tracker poll failed');
    } finally {
      this.running = false;
    }
    return { created, requeued };
  }
}
