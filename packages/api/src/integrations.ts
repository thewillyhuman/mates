import type { Tracker, TriggerRule } from './tracker/tracker.js';
import { JiraTracker } from './tracker/jira.js';
import type { Scm } from './scm/scm.js';
import { GitLabScm } from './scm/gitlab.js';
import { GitHubScm } from './scm/github.js';
import { GiteaScm } from './scm/gitea.js';
import type { CredentialStore } from './settings/credentials.js';
import type { Settings } from './settings/schema.js';
import type { SettingsService } from './settings/service.js';

/**
 * Builds adapters from the current settings and credentials (§8). Returns
 * `undefined` while an integration is not configured; tests inject fakes.
 */
export interface IntegrationOverrides {
  tracker?: Tracker | undefined;
  scm?: Record<string, Scm>;
}

export class Integrations {
  constructor(
    private readonly settings: SettingsService,
    private readonly credentials: CredentialStore,
    private readonly publicUrl: string,
    private readonly overrides: IntegrationOverrides = {},
    private readonly fetchFn?: typeof fetch,
  ) {}

  triggerRule(settings: Settings): TriggerRule {
    return { kind: settings.jira.trigger.kind, value: settings.jira.trigger.value };
  }

  /** The Jira adapter, or undefined until base URL and token are set. */
  async tracker(): Promise<Tracker | undefined> {
    if (this.overrides.tracker) return this.overrides.tracker;
    const s = await this.settings.get();
    const token = await this.credentials.read('jira_token');
    if (!s.jira.base_url || !token) return undefined;
    const opts = {
      baseUrl: s.jira.base_url,
      auth: s.jira.auth,
      email: s.jira.email,
      token,
      webhookSecret: (await this.credentials.read('jira_webhook_secret')) ?? '',
      webhookSecretIn: s.jira.webhook_secret_in,
      commentPrefix: s.jira.comment_prefix,
      runUrl: (id: string) => `${this.publicUrl}/runs/${id}`,
    };
    return new JiraTracker(this.fetchFn ? { ...opts, fetch: this.fetchFn } : opts);
  }

  /** The SCM adapter for a provider id from Settings → Source control. */
  async scm(providerId: string): Promise<Scm | undefined> {
    if (this.overrides.scm?.[providerId]) return this.overrides.scm[providerId];
    const s = await this.settings.get();
    const provider = s.scm.providers.find((p) => p.id === providerId);
    const token = await this.credentials.read(`scm_${providerId}_token`);
    if (!provider || !token) return undefined;
    const fetchOpt = this.fetchFn ? { fetch: this.fetchFn } : {};
    switch (provider.type) {
      case 'gitlab':
        return new GitLabScm({ baseUrl: provider.base_url, token, ...fetchOpt });
      case 'github':
        return new GitHubScm({ baseUrl: provider.base_url, token, ...fetchOpt });
      case 'gitea':
        return new GiteaScm({
          baseUrl: provider.base_url,
          token,
          username: provider.username,
          ...fetchOpt,
        });
    }
  }
}
