import { describe, expect, it } from 'vitest';
import { fixtureFetch, loadFixture } from '../../test/http-fixtures.js';
import { DRAFT_FALLBACK_LABEL, GitHubScm } from './github.js';

function github() {
  const f = fixtureFetch(loadFixture('github', 'basic'));
  return {
    scm: new GitHubScm({ baseUrl: 'https://github.com', token: 'ghp_token', fetch: f.fetch }),
    calls: f.calls,
  };
}

describe('GitHubScm', () => {
  it('resolves repositories against api.github.com with a bearer token', async () => {
    const { scm, calls } = github();
    const repo = await scm.resolveRepo('example-org/billing-service');
    expect(repo).toEqual({
      id: 'example-org/billing-service',
      project: 'example-org/billing-service',
      cloneUrl: 'https://github.com/example-org/billing-service.git',
      defaultBranch: 'main',
      webUrl: 'https://github.com/example-org/billing-service',
    });
    expect(calls[0]!.url).toBe('https://api.github.com/repos/example-org/billing-service');
    expect(calls[0]!.headers.authorization).toBe('Bearer ghp_token');
    expect(await scm.cloneCredential()).toEqual({ username: 'x-access-token', token: 'ghp_token' });
  });

  it('opens a draft PR, then labels and requests reviewers', async () => {
    const { scm, calls } = github();
    const repo = await scm.resolveRepo('example-org/billing-service');
    const mr = await scm.openMergeRequest(repo, {
      source: 'mates/BILL-301-vat',
      target: 'main',
      title: 'BILL-301: Add VAT breakdown',
      description: 'd',
      draft: true,
      labels: ['mates'],
      reviewers: ['ana'],
    });
    expect(mr).toMatchObject({
      id: '77',
      ref: '#77',
      state: 'draft',
      url: 'https://github.com/example-org/billing-service/pull/77',
    });
    expect(mr.draftFallback).toBeUndefined();
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.github.com', '')}`)).toEqual([
      'GET /repos/example-org/billing-service',
      'POST /repos/example-org/billing-service/pulls',
      'POST /repos/example-org/billing-service/issues/77/labels',
      'POST /repos/example-org/billing-service/pulls/77/requested_reviewers',
    ]);
    expect(calls[1]!.body).toEqual({
      head: 'mates/BILL-301-vat',
      base: 'main',
      title: 'BILL-301: Add VAT breakdown',
      body: 'd',
      draft: true,
    });
  });

  it('falls back to a ready PR with the mates:draft label when drafts are refused', async () => {
    const { scm, calls } = github();
    const repo = await scm.resolveRepo('example-org/billing-service');
    const mr = await scm.openMergeRequest(repo, {
      source: 'mates/BILL-302-nodraft',
      target: 'main',
      title: 'BILL-302: x',
      description: '',
      draft: true,
      labels: [],
      reviewers: [],
    });
    expect(mr).toMatchObject({ id: '78', state: 'draft', draftFallback: true });
    const labelCall = calls.find((c) => c.url.endsWith('/issues/78/labels'))!;
    expect(labelCall.body).toEqual({ labels: [DRAFT_FALLBACK_LABEL] });
  });

  it('marks ready through GraphQL and updates body/title through REST', async () => {
    const { scm, calls } = github();
    const repo = await scm.resolveRepo('example-org/billing-service');
    const mr = await scm.updateMergeRequest(repo, '77', { description: 'new', draft: false });
    expect(mr.state).toBe('ready');
    const gql = calls.find((c) => c.url.endsWith('/graphql'))!;
    expect(gql.body).toMatchObject({ variables: { id: 'PR_kwDO1' } });
    expect((gql.body as { query: string }).query).toContain('markPullRequestReadyForReview');
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ body: 'new' });
  });

  it('gets, comments and lists repositories', async () => {
    const { scm, calls } = github();
    const repo = await scm.resolveRepo('example-org/billing-service');
    expect((await scm.getMergeRequest(repo, '77')).ref).toBe('#77');
    await scm.commentOnMergeRequest(repo, '77', 'hi');
    expect(calls.at(-1)!.body).toEqual({ body: 'hi' });
    expect(await scm.test()).toEqual({
      ok: true,
      message: 'authenticated; 1 accessible repository(ies)',
      repos: ['example-org/billing-service'],
    });
  });

  it('targets /api/v3 on GitHub Enterprise Server', async () => {
    const f = fixtureFetch([
      {
        request: { method: 'GET', url: '/api/v3/repos/a/b' },
        response: {
          status: 200,
          body: {
            full_name: 'a/b',
            clone_url: 'https://ghe.example.com/a/b.git',
            default_branch: 'main',
            html_url: 'https://ghe.example.com/a/b',
          },
        },
      },
    ]);
    const scm = new GitHubScm({ baseUrl: 'https://ghe.example.com', token: 't', fetch: f.fetch });
    expect((await scm.resolveRepo('a/b')).id).toBe('a/b');
    expect(f.calls[0]!.url).toBe('https://ghe.example.com/api/v3/repos/a/b');
  });
});
