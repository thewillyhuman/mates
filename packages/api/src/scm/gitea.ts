import { HttpClient, HttpError } from '../http-client.js';
import {
  ScmError,
  type MergeRequest,
  type OpenMergeRequestInput,
  type RepoInfo,
  type Scm,
  type ScmTestResult,
  type UpdateMergeRequestInput,
} from './scm.js';

/**
 * Gitea adapter: the GitHub-shaped API under `/api/v1`, used by the
 * end-to-end tests and usable with any Gitea/Forgejo. Drafts are the
 * `WIP:` title prefix; labels are resolved to ids by name.
 */
export interface GiteaOptions {
  baseUrl: string;
  token: string;
  /** Credential username for clones (the token's owner). */
  username: string;
  fetch?: typeof fetch;
}

const WIP_PREFIX = 'WIP: ';

interface GtRepo {
  full_name: string;
  clone_url: string;
  default_branch: string;
  html_url: string;
}

interface GtPull {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged: boolean;
  title: string;
  head: { ref: string };
  base: { ref: string };
}

function stripWip(title: string): string {
  return title.replace(/^(wip:|\[wip\]|draft:)\s*/i, '');
}

function toMr(p: GtPull): MergeRequest {
  const draft = /^(wip:|\[wip\]|draft:)/i.test(p.title);
  const state: MergeRequest['state'] = p.merged
    ? 'merged'
    : p.state === 'closed'
      ? 'closed'
      : draft
        ? 'draft'
        : 'ready';
  return {
    id: String(p.number),
    ref: `#${p.number}`,
    url: p.html_url,
    state,
    title: stripWip(p.title),
    sourceBranch: p.head.ref,
    targetBranch: p.base.ref,
  };
}

export class GiteaScm implements Scm {
  readonly type = 'gitea' as const;
  private readonly http: HttpClient;

  constructor(private readonly opts: GiteaOptions) {
    this.http = new HttpClient({
      baseUrl: `${opts.baseUrl.replace(/\/+$/, '')}/api/v1`,
      headers: { authorization: `token ${opts.token}` },
      fetch: opts.fetch,
    });
  }

  async resolveRepo(project: string): Promise<RepoInfo> {
    const path = project.replace(/^\/+|\/+$/g, '');
    try {
      const r = await this.http.json<GtRepo>('GET', `/repos/${path}`);
      return {
        id: r.full_name,
        project: r.full_name,
        cloneUrl: r.clone_url,
        defaultBranch: r.default_branch,
        webUrl: r.html_url,
      };
    } catch (err) {
      throw wrap(err, `resolve ${project}`);
    }
  }

  cloneCredential(): { username: string; token: string } {
    return { username: this.opts.username || 'mates', token: this.opts.token };
  }

  async openMergeRequest(repo: RepoInfo, input: OpenMergeRequestInput): Promise<MergeRequest> {
    const body: Record<string, unknown> = {
      head: input.source,
      base: input.target,
      title: input.draft ? `${WIP_PREFIX}${input.title}` : input.title,
      body: input.description,
    };
    const labelIds = await this.labelIds(repo, input.labels);
    if (labelIds.length) body.labels = labelIds;
    let pull: GtPull;
    try {
      pull = await this.http.json<GtPull>('POST', `/repos/${repo.id}/pulls`, body);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        const open = await this.http.json<GtPull[]>('GET', `/repos/${repo.id}/pulls?state=open`);
        const existing = open.find((p) => p.head.ref === input.source);
        if (existing) return toMr(existing);
      }
      throw wrap(err, 'open pull request');
    }
    if (input.reviewers.length) {
      await this.http
        .json('POST', `/repos/${repo.id}/pulls/${pull.number}/requested_reviewers`, {
          reviewers: input.reviewers,
        })
        .catch(() => undefined);
    }
    return toMr(pull);
  }

  async updateMergeRequest(
    repo: RepoInfo,
    mrId: string,
    patch: UpdateMergeRequestInput,
  ): Promise<MergeRequest> {
    const body: Record<string, unknown> = {};
    if (patch.description !== undefined) body.body = patch.description;
    if (patch.title !== undefined || patch.draft !== undefined) {
      const current = patch.title ?? (await this.getMergeRequest(repo, mrId)).title;
      body.title = patch.draft ? `${WIP_PREFIX}${stripWip(current)}` : stripWip(current);
    }
    try {
      return toMr(await this.http.json<GtPull>('PATCH', `/repos/${repo.id}/pulls/${mrId}`, body));
    } catch (err) {
      throw wrap(err, `update #${mrId}`);
    }
  }

  async getMergeRequest(repo: RepoInfo, mrId: string): Promise<MergeRequest> {
    try {
      return toMr(await this.http.json<GtPull>('GET', `/repos/${repo.id}/pulls/${mrId}`));
    } catch (err) {
      throw wrap(err, `get #${mrId}`);
    }
  }

  async commentOnMergeRequest(repo: RepoInfo, mrId: string, markdown: string): Promise<void> {
    try {
      await this.http.json('POST', `/repos/${repo.id}/issues/${mrId}/comments`, { body: markdown });
    } catch (err) {
      throw wrap(err, `comment on #${mrId}`);
    }
  }

  async downloadArchive(project: string, ref: string): Promise<{ archive: Buffer; sha: string }> {
    const path = project.replace(/^\/+|\/+$/g, '');
    try {
      const commit = await this.http
        .json<{ sha: string }>('GET', `/repos/${path}/git/commits/${encodeURIComponent(ref)}`)
        .catch(async () => {
          const branch = await this.http.json<{ commit: { id: string } }>(
            'GET',
            `/repos/${path}/branches/${encodeURIComponent(ref)}`,
          );
          return { sha: branch.commit.id };
        });
      const res = await this.http.request(
        'GET',
        `/repos/${path}/archive/${encodeURIComponent(commit.sha)}.tar.gz`,
      );
      return { archive: Buffer.from(await res.arrayBuffer()), sha: commit.sha };
    } catch (err) {
      throw wrap(err, `archive of ${project}@${ref}`);
    }
  }

  async test(): Promise<ScmTestResult> {
    try {
      const repos = await this.http.json<GtRepo[]>('GET', '/user/repos?limit=50');
      return {
        ok: true,
        message: `authenticated; ${repos.length} accessible repository(ies)`,
        repos: repos.map((r) => r.full_name),
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message, repos: [] };
    }
  }

  private async labelIds(repo: RepoInfo, names: string[]): Promise<number[]> {
    if (names.length === 0) return [];
    const labels = await this.http
      .json<{ id: number; name: string }[]>('GET', `/repos/${repo.id}/labels?limit=100`)
      .catch(() => []);
    return names
      .map((n) => labels.find((l) => l.name === n)?.id)
      .filter((id): id is number => id !== undefined);
  }
}

function wrap(err: unknown, what: string): ScmError {
  if (err instanceof HttpError) return new ScmError(`gitea ${what}: ${err.message}`, err.status);
  return new ScmError(`gitea ${what}: ${(err as Error).message}`);
}
