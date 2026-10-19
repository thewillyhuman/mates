import { describe, expect, it } from 'vitest';
import { fixtureFetch, loadFixture } from '../../test/http-fixtures.js';
import { GiteaScm } from './gitea.js';

describe('GiteaScm', () => {
  it('resolves, opens a WIP pull request with label ids, marks ready, comments and lists', async () => {
    const f = fixtureFetch(loadFixture('gitea', 'basic'));
    const scm = new GiteaScm({
      baseUrl: 'http://gitea:3000',
      token: 'tok',
      username: 'mates',
      fetch: f.fetch,
    });
    const repo = await scm.resolveRepo('mates/webhook-service');
    expect(repo.cloneUrl).toBe('http://gitea:3000/mates/webhook-service.git');
    expect(f.calls[0]!.headers.authorization).toBe('token tok');
    expect(scm.cloneCredential()).toEqual({ username: 'mates', token: 'tok' });

    const mr = await scm.openMergeRequest(repo, {
      source: 'mates/API-198-retry',
      target: 'main',
      title: 'API-198: Retry policy',
      description: 'd',
      draft: true,
      labels: ['mates', 'unknown'],
      reviewers: [],
    });
    expect(mr).toMatchObject({
      id: '3',
      ref: '#3',
      state: 'draft',
      title: 'API-198: Retry policy',
    });
    const create = f.calls.find((c) => c.method === 'POST')!;
    expect(create.body).toEqual({
      head: 'mates/API-198-retry',
      base: 'main',
      title: 'WIP: API-198: Retry policy',
      body: 'd',
      labels: [5],
    });

    const ready = await scm.updateMergeRequest(repo, '3', { draft: false });
    expect(ready.state).toBe('ready');
    expect(f.calls.at(-1)!.body).toEqual({ title: 'API-198: Retry policy' });
    await scm.commentOnMergeRequest(repo, '3', 'hi');
    expect(await scm.test()).toMatchObject({ ok: true, repos: ['mates/webhook-service'] });
  });
});
