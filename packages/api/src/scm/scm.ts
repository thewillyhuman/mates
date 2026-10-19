/**
 * The source-control port (§8). GitLab, GitHub and Gitea implement it; the
 * orchestrator never sees provider-specific types.
 */
export type ScmType = 'gitlab' | 'github' | 'gitea';

export interface RepoInfo {
  /** Provider-side identifier (numeric id or owner/name), used in later calls. */
  id: string;
  project: string;
  cloneUrl: string;
  defaultBranch: string;
  webUrl: string;
}

export type MergeRequestState = 'draft' | 'ready' | 'merged' | 'closed';

export interface MergeRequest {
  /** Provider id used for API calls (GitLab iid, GitHub/Gitea number). */
  id: string;
  /** Human reference: `!1429` on GitLab, `#1429` on GitHub/Gitea. */
  ref: string;
  url: string;
  state: MergeRequestState;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  /** Set when the provider rejected a draft and the MR was opened ready with a label instead (§8.3). */
  draftFallback?: boolean;
}

export interface OpenMergeRequestInput {
  source: string;
  target: string;
  title: string;
  description: string;
  draft: boolean;
  labels: string[];
  reviewers: string[];
}

export interface UpdateMergeRequestInput {
  title?: string;
  description?: string;
  draft?: boolean;
}

export interface ScmTestResult {
  ok: boolean;
  message: string;
  repos: string[];
}

export interface Scm {
  readonly type: ScmType;
  resolveRepo(project: string): Promise<RepoInfo>;
  /** What the runner gets (§8): username + token for the credential helper. */
  cloneCredential(): { username: string; token: string };
  openMergeRequest(repo: RepoInfo, input: OpenMergeRequestInput): Promise<MergeRequest>;
  updateMergeRequest(
    repo: RepoInfo,
    mrId: string,
    patch: UpdateMergeRequestInput,
  ): Promise<MergeRequest>;
  getMergeRequest(repo: RepoInfo, mrId: string): Promise<MergeRequest>;
  commentOnMergeRequest(repo: RepoInfo, mrId: string, markdown: string): Promise<void>;
  /** Lists accessible repositories (§6.2 step 3 "Test"). */
  test(): Promise<ScmTestResult>;
}

export class ScmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
