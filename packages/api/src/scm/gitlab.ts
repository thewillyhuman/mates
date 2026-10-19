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
 * GitLab adapter (§8.4): gitlab.com or self-hosted, PAT / project token
 * with `api` + `write_repository`. Drafts use the `Draft:` title prefix,
 * reviewers are resolved by username.
 */
export interface GitLabOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

interface GlProject {
  id: number;
  path_with_namespace: string;
  http_url_to_repo: string;
  default_branch: string;
  web_url: string;
}

interface GlMr {
  iid: number;
  web_url: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  draft?: boolean;
  work_in_progress?: boolean;
  title: string;
  source_branch: string;
  target_branch: string;
}

const DRAFT_PREFIX = 'Draft: ';

export function stripDraft(title: string): string {
  return title.replace(/^(draft:|\[draft\]|\(draft\)|wip:)\s*/i, '');
}

function toMr(m: GlMr): MergeRequest {
  const draft = m.draft ?? m.work_in_progress ?? /^draft:/i.test(m.title);
  const state: MergeRequest['state'] =
    m.state === 'merged' ? 'merged' : m.state === 'closed' ? 'closed' : draft ? 'draft' : 'ready';
  return {
    id: String(m.iid),
    ref: `!${m.iid}`,
    url: m.web_url,
    state,
    title: stripDraft(m.title),
    sourceBranch: m.source_branch,
    targetBranch: m.target_branch,
  };
}

export class GitLabScm implements Scm {
  readonly type = 'gitlab' as const;
  private readonly http: HttpClient;

  constructor(private readonly opts: GitLabOptions) {
    this.http = new HttpClient({
      baseUrl: `${opts.baseUrl.replace(/\/+$/, '')}/api/v4`,
      headers: { 'private-token': opts.token },
      fetch: opts.fetch,
    });
  }

  async resolveRepo(project: string): Promise<RepoInfo> {
    try {
      const p = await this.http.json<GlProject>(
        'GET',
        `/projects/${encodeURIComponent(project.replace(/^\/+|\/+$/g, ''))}`,
      );
      return {
        id: String(p.id),
        project: p.path_with_namespace,
        cloneUrl: p.http_url_to_repo,
        defaultBranch: p.default_branch,
        webUrl: p.web_url,
      };
    } catch (err) {
      throw wrap(err, `resolve ${project}`);
    }
  }

  cloneCredential(): { username: string; token: string } {
    return { username: 'oauth2', token: this.opts.token };
  }

  async openMergeRequest(repo: RepoInfo, input: OpenMergeRequestInput): Promise<MergeRequest> {
    const reviewerIds = await this.userIds(input.reviewers);
    const body: Record<string, unknown> = {
      source_branch: input.source,
      target_branch: input.target,
      title: input.draft ? `${DRAFT_PREFIX}${input.title}` : input.title,
      description: input.description,
      remove_source_branch: false,
    };
    if (input.labels.length) body.labels = input.labels.join(',');
    if (reviewerIds.length) body.reviewer_ids = reviewerIds;
    try {
      return toMr(await this.http.json<GlMr>('POST', `/projects/${repo.id}/merge_requests`, body));
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        // Already open for this branch: reuse it (idempotent orchestration, §3.2).
        const open = await this.http.json<GlMr[]>(
          'GET',
          `/projects/${repo.id}/merge_requests?state=opened&source_branch=${encodeURIComponent(input.source)}`,
        );
        if (open[0]) return toMr(open[0]);
      }
      throw wrap(err, 'open merge request');
    }
  }

  async updateMergeRequest(
    repo: RepoInfo,
    mrId: string,
    patch: UpdateMergeRequestInput,
  ): Promise<MergeRequest> {
    const body: Record<string, unknown> = {};
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.title !== undefined || patch.draft !== undefined) {
      const current = patch.title ?? (await this.getMergeRequest(repo, mrId)).title;
      body.title = patch.draft ? `${DRAFT_PREFIX}${stripDraft(current)}` : stripDraft(current);
    }
    try {
      return toMr(
        await this.http.json<GlMr>('PUT', `/projects/${repo.id}/merge_requests/${mrId}`, body),
      );
    } catch (err) {
      throw wrap(err, `update !${mrId}`);
    }
  }

  async getMergeRequest(repo: RepoInfo, mrId: string): Promise<MergeRequest> {
    try {
      return toMr(await this.http.json<GlMr>('GET', `/projects/${repo.id}/merge_requests/${mrId}`));
    } catch (err) {
      throw wrap(err, `get !${mrId}`);
    }
  }

  async commentOnMergeRequest(repo: RepoInfo, mrId: string, markdown: string): Promise<void> {
    try {
      await this.http.json('POST', `/projects/${repo.id}/merge_requests/${mrId}/notes`, {
        body: markdown,
      });
    } catch (err) {
      throw wrap(err, `comment on !${mrId}`);
    }
  }

  async test(): Promise<ScmTestResult> {
    try {
      const projects = await this.http.json<GlProject[]>(
        'GET',
        '/projects?membership=true&simple=true&per_page=50&order_by=last_activity_at',
      );
      return {
        ok: true,
        message: `authenticated; ${projects.length} accessible project(s)`,
        repos: projects.map((p) => p.path_with_namespace),
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message, repos: [] };
    }
  }

  private async userIds(usernames: string[]): Promise<number[]> {
    const ids: number[] = [];
    for (const u of usernames) {
      const users = await this.http
        .json<{ id: number }[]>('GET', `/users?username=${encodeURIComponent(u)}`)
        .catch(() => []);
      if (users[0]) ids.push(users[0].id);
    }
    return ids;
  }
}

function wrap(err: unknown, what: string): ScmError {
  if (err instanceof HttpError) return new ScmError(`gitlab ${what}: ${err.message}`, err.status);
  return new ScmError(`gitlab ${what}: ${(err as Error).message}`);
}
