import type { Pool } from './db/pool.js';
import type { Logger } from './logger.js';
import { deleteBlobsOlderThan } from './runs/blobs.js';
import type { SettingsService } from './settings/service.js';

/**
 * Retention (§7.3 step 7, §11 `retention`): transcripts are dropped after
 * `transcripts_days`; runs that finished more than `events_days` ago are
 * deleted with everything they own (events, blobs, usage, verdicts,
 * nudges, invocations). Runs once a day and at start-up.
 */
export interface RetentionDeps {
  db: Pool;
  settings: SettingsService;
  log: Logger;
  intervalMs?: number;
}

export class Retention {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: RetentionDeps) {}

  start(): void {
    void this.run();
    this.timer = setInterval(() => void this.run(), this.deps.intervalMs ?? 24 * 3600 * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<{ transcripts: number; runs: number }> {
    const s = await this.deps.settings.get();
    try {
      const transcripts = await deleteBlobsOlderThan(
        this.deps.db,
        'transcript',
        s.retention.transcripts_days,
      );
      const r = await this.deps.db.query(
        `DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < now() - ($1 || ' days')::interval`,
        [String(s.retention.events_days)],
      );
      const runs = r.rowCount ?? 0;
      if (transcripts || runs) this.deps.log.info({ transcripts, runs }, 'retention applied');
      return { transcripts, runs };
    } catch (err) {
      this.deps.log.error({ err }, 'retention failed');
      return { transcripts: 0, runs: 0 };
    }
  }
}
