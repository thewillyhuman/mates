import { describe, expect, it } from 'vitest';
import { fixtureFetch, loadFixture } from '../../test/http-fixtures.js';
import { GitLabScm, stripDraft } from './gitlab.js';
import { ScmError } from './scm.js';

function gitlab() {
  const f = fixtureFetch(loadFixture('gitlab', 'basic'));
  return {
    scm: new GitLabScm({
      baseUrl: 'https://gitlab.example.com/',
      token: 'glpat-token',
      fetch: f.fetch,
    }),
    calls: f.calls,
  };
}

describe('GitLabScm', () => {
  it('resolves a project by path with the private token', async () => {
    const { scm, calls } = gitlab();
    const repo = await scm.resolveRepo('platform/webhook-service');
    expect(repo).toEqual({
      id: '4711',
      project: 'platform/webhook-service',
      cloneUrl: 'https://gitlab.example.com/platform/webhook-service.git',
      defaultBranch: 'main',
      webUrl: 'https://gitlab.example.com/platform/webhook-service',
    });
    expect(calls[0]!.headers['private-token']).toBe('glpat-token');
    await expect(scm.resolveRepo('nope/missing')).rejects.toMatchObject({ status: 404 });
    await expect(scm.resolveRepo('nope/missing')).rejects.toBeInstanceOf(ScmError);
    expect(scm.cloneCredential()).toEqual({ username: 'oauth2', token: 'glpat-token' });
  });

  it('opens a draft MR with labels and resolved reviewers', async () => {
    const { scm, calls } = gitlab();
    const repo = await scm.resolveRepo('platform/webhook-service');
    const mr = await scm.openMergeRequest(repo, {
      source: 'mates/API-198-retry',
      target: 'main',
      title: 'API-198: Retry policy for webhook delivery',
      description: 'desc',
      draft: true,
      labels: ['mates', 'ai'],
      reviewers: ['ana', 'ghost'],
    });
    expect(mr).toMatchObject({
      id: '1429',
      ref: '!1429',
      state: 'draft',
      title: 'API-198: Retry policy for webhook delivery',
      sourceBranch: 'mates/API-198-retry',
    });
    const create = calls.find((c) => c.method === 'POST')!;
    expect(create.body).toEqual({
      source_branch: 'mates/API-198-retry',
      target_branch: 'main',
      title: 'Draft: API-198: Retry policy for webhook delivery',
      description: 'desc',
      remove_source_branch: false,
      labels: 'mates,ai',
      reviewer_ids: [12],
    });
  });

  it('reuses an already-open MR for the branch on 409', async () => {
    const { scm } = gitlab();
    const repo = await scm.resolveRepo('platform/webhook-service');
    const mr = await scm.openMergeRequest(repo, {
      source: 'mates/API-199-dup',
      target: 'main',
      title: 'API-199: dup',
      description: '',
      draft: true,
      labels: [],
      reviewers: [],
    });
    expect(mr.id).toBe('1430');
  });

  it('marks ready by stripping the prefix, updates descriptions, gets and comments', async () => {
    const { scm, calls } = gitlab();
    const repo = await scm.resolveRepo('platform/webhook-service');
    const ready = await scm.updateMergeRequest(repo, '1429', { draft: false });
    expect(ready.state).toBe('ready');
    expect(calls.at(-1)!.body).toEqual({ title: 'API-198: Retry policy for webhook delivery' });
    const updated = await scm.updateMergeRequest(repo, '1429', { description: 'new body' });
    expect(updated.state).toBe('draft');
    expect((await scm.getMergeRequest(repo, '1429')).ref).toBe('!1429');
    await scm.commentOnMergeRequest(repo, '1429', 'hello');
    expect(calls.at(-1)!.body).toEqual({ body: 'hello' });
  });

  it('lists accessible projects for the Test button', async () => {
    const { scm } = gitlab();
    expect(await scm.test()).toEqual({
      ok: true,
      message: 'authenticated; 2 accessible project(s)',
      repos: ['platform/webhook-service', 'platform/billing'],
    });
  });

  it('strips draft markers', () => {
    expect(stripDraft('Draft: x')).toBe('x');
    expect(stripDraft('[Draft] x')).toBe('x');
    expect(stripDraft('WIP: x')).toBe('x');
    expect(stripDraft('x')).toBe('x');
  });
});
