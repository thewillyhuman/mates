import type { Integrations } from '../integrations.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../settings/service.js';
import { TeamContextService, type TeamContextVersion } from './service.js';

/**
 * Keeps a git-sourced team context fresh (§6.2 step 4, decision 0017):
 * `refresh()` downloads the configured repository at its ref through the
 * provider's archive API and stores it as a new version when the commit
 * changed; `start()` polls every five minutes.
 */
export interface TeamContextFetcherDeps {
  settings: SettingsService;
  integrations: Integrations;
  teamContext: TeamContextService;
  log: Logger;
  intervalMs?: number;
}

export type RefreshResult =
  | { status: 'unchanged'; sha: string }
  | { status: 'updated'; version: TeamContextVersion }
  | { status: 'skipped'; reason: string };

export class TeamContextFetcher {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: TeamContextFetcherDeps) {}

  start(): void {
    this.timer = setInterval(
      () =>
        void this.refresh().catch((err: Error) =>
          this.deps.log.warn({ err }, 'team context poll failed'),
        ),
      this.deps.intervalMs ?? 5 * 60_000,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(by = 'poll'): Promise<RefreshResult> {
    const s = (await this.deps.settings.get()).team_context;
    if (s.source !== 'git') return { status: 'skipped', reason: 'team context source is upload' };
    if (!s.git_provider || !s.git_project)
      return { status: 'skipped', reason: 'provider and project are not set' };
    const scm = await this.deps.integrations.scm(s.git_provider);
    if (!scm) return { status: 'skipped', reason: `provider "${s.git_provider}" has no token` };
    const { archive, sha } = await scm.downloadArchive(s.git_project, s.git_ref);
    const ref = `${s.git_project}@${s.git_ref} (${sha.slice(0, 12)})`;
    if ((await this.deps.teamContext.activeRef()) === ref) return { status: 'unchanged', sha };
    const pkg = await TeamContextService.stripTopLevel(archive);
    const version = await this.deps.teamContext.upload(pkg, by, 'git', ref);
    this.deps.log.info(
      { version: version.version, ref, active: version.active, errors: version.errors.length },
      'team context fetched',
    );
    return { status: 'updated', version };
  }
}
