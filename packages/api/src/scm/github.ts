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
 * GitHub adapter (§8.5): github.com or GitHub Enterprise Server, personal
 * access token (the App flow is M7). Drafts use the API flag with the §8.3
 * fallback (ready + `mates:draft` label) when the repository refuses them;
 * "mark ready" goes through the GraphQL mutation, the only API for it.
 */
export interface GitHubOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export const DRAFT_FALLBACK_LABEL = 'mates:draft';

interface GhRepo {
  full_name: string;
  clone_url: string;
  default_branch: string;
  html_url: string;
}

interface GhPull {
  number: number;
  node_id: string;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged?: boolean;
  merged_at?: string | null;
  title: string;
  head: { ref: string };
  base: { ref: string };
  labels?: { name: string }[];
}

function toMr(p: GhPull): MergeRequest {
  const merged = p.merged === true || Boolean(p.merged_at);
  const fallback = (p.labels ?? []).some((l) => l.name === DRAFT_FALLBACK_LABEL);
  const state: MergeRequest['state'] = merged
    ? 'merged'
    : p.state === 'closed'
      ? 'closed'
      : p.draft || fallback
        ? 'draft'
        : 'ready';
  return {
    id: String(p.number),
    ref: `#${p.number}`,
    url: p.html_url,
    state,
    title: p.title,
    sourceBranch: p.head.ref,
    targetBranch: p.base.ref,
    ...(fallback ? { draftFallback: true } : {}),
  };
}

export class GitHubScm implements Scm {
  readonly type = 'github' as const;
  private readonly http: HttpClient;
  private readonly graphqlUrl: string;

  constructor(private readonly opts: GitHubOptions) {
    const base = opts.baseUrl.replace(/\/+$/, '');
    const isDotCom = /github\.com$/.test(base) || base === '';
    const apiBase = isDotCom ? 'https://api.github.com' : `${base}/api/v3`;
    this.graphqlUrl = isDotCom ? 'https://api.github.com/graphql' : `${base}/api/graphql`;
    this.http = new HttpClient({
      baseUrl: apiBase,
      headers: {
        authorization: `Bearer ${opts.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'mates',
      },
      fetch: opts.fetch,
    });
  }

  async resolveRepo(project: string): Promise<RepoInfo> {
    const path = project.replace(/^\/+|\/+$/g, '');
    try {
      const r = await this.http.json<GhRepo>('GET', `/repos/${path}`);
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
    return { username: 'x-access-token', token: this.opts.token };
  }

  async openMergeRequest(repo: RepoInfo, input: OpenMergeRequestInput): Promise<MergeRequest> {
    const body = {
      head: input.source,
      base: input.target,
      title: input.title,
      body: input.description,
      draft: input.draft,
    };
    let pull: GhPull;
    let fallback = false;
    try {
      pull = await this.http.json<GhPull>('POST', `/repos/${repo.id}/pulls`, body);
    } catch (err) {
      if (
        err instanceof HttpError &&
        err.status === 422 &&
        input.draft &&
        /draft/i.test(err.body)
      ) {
        // §8.3: the repository does not allow draft PRs; open it ready and label it.
        try {
          pull = await this.http.json<GhPull>('POST', `/repos/${repo.id}/pulls`, {
            ...body,
            draft: false,
          });
          fallback = true;
        } catch (err2) {
          throw wrap(err2, 'open pull request');
        }
      } else if (
        err instanceof HttpError &&
        err.status === 422 &&
        /already exists/i.test(err.body)
      ) {
        const open = await this.http.json<GhPull[]>(
          'GET',
          `/repos/${repo.id}/pulls?state=open&head=${encodeURIComponent(`${repo.id.split('/')[0]}:${input.source}`)}`,
        );
        if (open[0]) return toMr(open[0]);
        throw wrap(err, 'open pull request');
      } else {
        throw wrap(err, 'open pull request');
      }
    }
    const labels = [...input.labels, ...(fallback ? [DRAFT_FALLBACK_LABEL] : [])];
    if (labels.length) {
      await this.http
        .json('POST', `/repos/${repo.id}/issues/${pull.number}/labels`, { labels })
        .catch(() => undefined);
    }
    if (input.reviewers.length) {
      await this.http
        .json('POST', `/repos/${repo.id}/pulls/${pull.number}/requested_reviewers`, {
          reviewers: input.reviewers,
        })
        .catch(() => undefined);
    }
    const mr = toMr({ ...pull, labels: labels.map((name) => ({ name })) });
    return fallback ? { ...mr, state: 'draft', draftFallback: true } : mr;
  }

  async updateMergeRequest(
    repo: RepoInfo,
    mrId: string,
    patch: UpdateMergeRequestInput,
  ): Promise<MergeRequest> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.description !== undefined) body.body = patch.description;
    try {
      let pull = Object.keys(body).length
        ? await this.http.json<GhPull>('PATCH', `/repos/${repo.id}/pulls/${mrId}`, body)
        : await this.http.json<GhPull>('GET', `/repos/${repo.id}/pulls/${mrId}`);
      if (
        patch.draft === false &&
        (pull.draft || (pull.labels ?? []).some((l) => l.name === DRAFT_FALLBACK_LABEL))
      ) {
        if (pull.draft) await this.markReady(pull.node_id);
        await this.http
          .request(
            'DELETE',
            `/repos/${repo.id}/issues/${mrId}/labels/${encodeURIComponent(DRAFT_FALLBACK_LABEL)}`,
          )
          .catch(() => undefined);
        pull = await this.http.json<GhPull>('GET', `/repos/${repo.id}/pulls/${mrId}`);
      } else if (patch.draft === true && !pull.draft) {
        await this.http
          .json('POST', `/repos/${repo.id}/issues/${mrId}/labels`, {
            labels: [DRAFT_FALLBACK_LABEL],
          })
          .catch(() => undefined);
        pull = { ...pull, labels: [...(pull.labels ?? []), { name: DRAFT_FALLBACK_LABEL }] };
      }
      return toMr(pull);
    } catch (err) {
      throw wrap(err, `update #${mrId}`);
    }
  }

  private async markReady(nodeId: string): Promise<void> {
    const res = await this.http.json<{ errors?: { message: string }[] }>('POST', this.graphqlUrl, {
      query:
        'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      variables: { id: nodeId },
    });
    if (res.errors?.length)
      throw new ScmError(`github mark ready: ${res.errors.map((e) => e.message).join('; ')}`);
  }

  async getMergeRequest(repo: RepoInfo, mrId: string): Promise<MergeRequest> {
    try {
      return toMr(await this.http.json<GhPull>('GET', `/repos/${repo.id}/pulls/${mrId}`));
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
      const commit = await this.http.json<{ sha: string }>(
        'GET',
        `/repos/${path}/commits/${encodeURIComponent(ref)}`,
      );
      const res = await this.http.request(
        'GET',
        `/repos/${path}/tarball/${encodeURIComponent(commit.sha)}`,
      );
      return { archive: Buffer.from(await res.arrayBuffer()), sha: commit.sha };
    } catch (err) {
      throw wrap(err, `archive of ${project}@${ref}`);
    }
  }

  async test(): Promise<ScmTestResult> {
    try {
      const repos = await this.http.json<GhRepo[]>('GET', '/user/repos?per_page=50&sort=pushed');
      return {
        ok: true,
        message: `authenticated; ${repos.length} accessible repository(ies)`,
        repos: repos.map((r) => r.full_name),
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message, repos: [] };
    }
  }
}

function wrap(err: unknown, what: string): ScmError {
  if (err instanceof HttpError) return new ScmError(`github ${what}: ${err.message}`, err.status);
  return new ScmError(`github ${what}: ${(err as Error).message}`);
}
