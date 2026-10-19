import type { Tracker, TriggerRule } from './tracker/tracker.js';
import { JiraTracker } from './tracker/jira.js';
import type { Scm } from './scm/scm.js';
import { GitLabScm } from './scm/gitlab.js';
import { GitHubScm } from './scm/github.js';
import { GitHubAppAuth } from './scm/github-app.js';
import { GiteaScm } from './scm/gitea.js';
import type { CredentialStore } from './settings/credentials.js';
import type { ScmProvider, Settings } from './settings/schema.js';
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

  /** One token cache per App provider, keyed by what would invalidate it. */
  private readonly apps = new Map<string, { key: string; auth: GitHubAppAuth }>();

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
    if (!provider) return undefined;
    const fetchOpt = this.fetchFn ? { fetch: this.fetchFn } : {};
    if (provider.type === 'github' && provider.auth === 'app') {
      const app = await this.githubApp(provider);
      return app
        ? new GitHubScm({
            baseUrl: provider.base_url,
            token: () => app.installationToken(),
            ...fetchOpt,
          })
        : undefined;
    }
    const token = await this.credentials.read(`scm_${providerId}_token`);
    if (!token) return undefined;
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

  /**
   * The git token a runner pod should use for an App-authenticated provider,
   * minted here and handed over through the per-invocation Secret. Undefined
   * for PAT providers, whose token the pod reads from the credentials Secret.
   */
  async runnerGitToken(providerId: string): Promise<string | undefined> {
    const s = await this.settings.get();
    const provider = s.scm.providers.find((p) => p.id === providerId);
    if (!provider || provider.type !== 'github' || provider.auth !== 'app') return undefined;
    const app = await this.githubApp(provider);
    return app?.installationToken();
  }

  private async githubApp(provider: ScmProvider): Promise<GitHubAppAuth | undefined> {
    const pem = await this.credentials.read(`scm_${provider.id}_app_private_key`);
    if (!pem || !provider.app_id || !provider.installation_id) return undefined;
    const key = `${provider.base_url}|${provider.app_id}|${provider.installation_id}|${pem.length}`;
    const hit = this.apps.get(provider.id);
    if (hit && hit.key === key) return hit.auth;
    const auth = new GitHubAppAuth({
      baseUrl: provider.base_url,
      appId: provider.app_id,
      installationId: provider.installation_id,
      privateKeyPem: pem,
      ...(this.fetchFn ? { fetch: this.fetchFn } : {}),
    });
    this.apps.set(provider.id, { key, auth });
    return auth;
  }
}
