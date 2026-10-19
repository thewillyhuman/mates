import type {
  MergeRequest,
  OpenMergeRequestInput,
  RepoInfo,
  Scm,
  ScmTestResult,
  ScmType,
  UpdateMergeRequestInput,
} from './scm.js';

/** In-memory SCM for orchestrator tests and local development. */
export class FakeScm implements Scm {
  readonly mrs = new Map<
    string,
    MergeRequest & { description: string; labels: string[]; reviewers: string[] }
  >();
  readonly comments: { mrId: string; markdown: string }[] = [];
  private seq = 1400;

  constructor(
    readonly type: ScmType = 'gitlab',
    private readonly baseUrl = 'https://gitlab.example.com',
  ) {}

  async resolveRepo(project: string): Promise<RepoInfo> {
    return {
      id: project,
      project,
      cloneUrl: `${this.baseUrl}/${project}.git`,
      defaultBranch: 'main',
      webUrl: `${this.baseUrl}/${project}`,
    };
  }

  async cloneCredential(): Promise<{ username: string; token: string }> {
    return { username: 'oauth2', token: 'fake-token' };
  }

  async openMergeRequest(repo: RepoInfo, input: OpenMergeRequestInput): Promise<MergeRequest> {
    const id = String(++this.seq);
    const mr = {
      id,
      ref: this.type === 'gitlab' ? `!${id}` : `#${id}`,
      url: `${repo.webUrl}/-/merge_requests/${id}`,
      state: input.draft ? ('draft' as const) : ('ready' as const),
      title: input.title,
      sourceBranch: input.source,
      targetBranch: input.target,
      description: input.description,
      labels: input.labels,
      reviewers: input.reviewers,
    };
    this.mrs.set(id, mr);
    return mr;
  }

  async updateMergeRequest(
    _repo: RepoInfo,
    mrId: string,
    patch: UpdateMergeRequestInput,
  ): Promise<MergeRequest> {
    const mr = this.mrs.get(mrId);
    if (!mr) throw new Error(`mr ${mrId} not found`);
    if (patch.title !== undefined) mr.title = patch.title;
    if (patch.description !== undefined) mr.description = patch.description;
    if (patch.draft !== undefined && mr.state !== 'merged' && mr.state !== 'closed')
      mr.state = patch.draft ? 'draft' : 'ready';
    return mr;
  }

  async getMergeRequest(_repo: RepoInfo, mrId: string): Promise<MergeRequest> {
    const mr = this.mrs.get(mrId);
    if (!mr) throw new Error(`mr ${mrId} not found`);
    return mr;
  }

  async commentOnMergeRequest(_repo: RepoInfo, mrId: string, markdown: string): Promise<void> {
    this.comments.push({ mrId, markdown });
  }

  async test(): Promise<ScmTestResult> {
    return { ok: true, message: 'fake scm', repos: ['example/repo'] };
  }

  /** Test hook: archive returned by downloadArchive. */
  archive: { archive: Buffer; sha: string } | null = null;
  async downloadArchive(project: string, ref: string): Promise<{ archive: Buffer; sha: string }> {
    if (!this.archive) throw new Error(`no archive for ${project}@${ref}`);
    return this.archive;
  }
}
