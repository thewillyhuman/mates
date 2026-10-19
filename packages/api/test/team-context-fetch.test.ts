import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GiteaScm } from '../src/scm/gitea.js';
import { GitHubScm } from '../src/scm/github.js';
import { GitLabScm } from '../src/scm/gitlab.js';
import { TeamContextService } from '../src/team-context/service.js';
import { providerArchive } from './archive-fixture.js';
import { stopTestDatabase } from './db.js';
import { testApp, type TestApp } from './harness.js';
import { fixtureFetch } from './http-fixtures.js';

const manifest =
  'version: 1\nteam:\n  name: From git\n  conventions: docs/c.md\nrepos:\n  - id: a\n    scm: gitea\n    project: x/a\n';

describe('provider archives', () => {
  it('each adapter resolves the ref to a commit and downloads the tarball', async () => {
    const archive = await providerArchive({ 'mates.yaml': manifest });
    const b64 = archive.toString('base64');
    const gl = fixtureFetch([
      {
        request: { method: 'GET', url: '/api/v4/projects/t%2Fctx/repository/commits/main' },
        response: { status: 200, body: { id: 'deadbeef' } },
      },
      {
        request: {
          method: 'GET',
          url: '/api/v4/projects/t%2Fctx/repository/archive.tar.gz?sha=deadbeef',
        },
        response: { status: 200, bodyBase64: b64 },
      },
    ]);
    expect(
      await new GitLabScm({ baseUrl: 'https://gl', token: 't', fetch: gl.fetch }).downloadArchive(
        't/ctx',
        'main',
      ),
    ).toMatchObject({ sha: 'deadbeef' });
    const gh = fixtureFetch([
      {
        request: { method: 'GET', url: '/repos/t/ctx/commits/main' },
        response: { status: 200, body: { sha: 'cafe' } },
      },
      {
        request: { method: 'GET', url: '/repos/t/ctx/tarball/cafe' },
        response: { status: 200, bodyBase64: b64 },
      },
    ]);
    expect(
      (
        await new GitHubScm({
          baseUrl: 'https://github.com',
          token: 't',
          fetch: gh.fetch,
        }).downloadArchive('t/ctx', 'main')
      ).archive.length,
    ).toBe(archive.length);
    const gt = fixtureFetch([
      {
        request: { method: 'GET', url: '/api/v1/repos/t/ctx/git/commits/main' },
        response: { status: 404, body: {} },
      },
      {
        request: { method: 'GET', url: '/api/v1/repos/t/ctx/branches/main' },
        response: { status: 200, body: { commit: { id: 'f00d' } } },
      },
      {
        request: { method: 'GET', url: '/api/v1/repos/t/ctx/archive/f00d.tar.gz' },
        response: { status: 200, bodyBase64: b64 },
      },
    ]);
    expect(
      await new GiteaScm({
        baseUrl: 'http://gitea',
        token: 't',
        username: 'u',
        fetch: gt.fetch,
      }).downloadArchive('t/ctx', 'main'),
    ).toMatchObject({ sha: 'f00d' });
  });

  it('strips the top-level directory so mates.yaml is at the root', async () => {
    const stripped = await TeamContextService.stripTopLevel(
      await providerArchive({ 'mates.yaml': manifest, 'docs/c.md': '#' }),
    );
    expect((await TeamContextService.listFiles(stripped)).sort()).toEqual([
      'docs/c.md',
      'mates.yaml',
    ]);
  });
});

describe('team context refresh', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await testApp();
    await t.settings.update(
      {
        scm: { providers: [{ id: 'gitea', type: 'gitea', base_url: 'http://gitea' }] },
        team_context: {
          source: 'git',
          git_provider: 'gitea',
          git_project: 'team/context',
          git_ref: 'main',
        },
      },
      'admin@example.com',
    );
  });
  afterAll(async () => {
    await t.close();
    await stopTestDatabase();
  });

  it('fetches, activates, then reports unchanged until the commit moves', async () => {
    t.scm.archive = {
      archive: await providerArchive({ 'mates.yaml': manifest, 'docs/c.md': '#' }),
      sha: 'abc123def456',
    };
    const first = await t.app.inject({
      method: 'POST',
      url: '/api/settings/team-context/refresh',
      headers: t.as('admin'),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: 'updated',
      version: { version: 1, active: true, source: 'git', ref: 'team/context@main (abc123def456)' },
    });
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/settings/team-context/refresh',
      headers: t.as('admin'),
    });
    expect(again.json()).toEqual({ status: 'unchanged', sha: 'abc123def456' });
    t.scm.archive = {
      archive: await providerArchive({
        'mates.yaml': manifest.replace('From git', 'Updated'),
        'docs/c.md': '#',
      }),
      sha: 'ffff0000aaaa',
    };
    const updated = await t.app.inject({
      method: 'POST',
      url: '/api/settings/team-context/refresh',
      headers: t.as('admin'),
    });
    expect(updated.json()).toMatchObject({
      status: 'updated',
      version: { version: 2, active: true },
    });
    expect((await t.teamContext.active())?.manifest?.team.name).toBe('Updated');
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/settings/team-context/refresh',
          headers: t.as('operator'),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('is skipped when the source is upload', async () => {
    await t.settings.update({ team_context: { source: 'upload' } }, 'admin@example.com');
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/settings/team-context/refresh',
      headers: t.as('admin'),
    });
    expect(r.json()).toMatchObject({ status: 'skipped' });
  });
});
