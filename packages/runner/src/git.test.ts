import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Git, PushRefusedError } from './git.js';
import { seedOrigin } from './test-helpers.js';

const PATCHES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/claude',
);

describe('Git', () => {
  let origin: string;
  let git: Git;
  let cwd: string;

  beforeAll(async () => {
    origin = await seedOrigin();
    cwd = path.join(await mkdtemp(path.join(tmpdir(), 'mates-ws-')), 'repo');
    git = new Git({
      cwd,
      username: 'x-access-token',
      token: 'secret-token',
      authorName: 'Mates',
      authorEmail: 'mates@example.com',
    });
  });

  it('clones the base branch and creates the run branch', async () => {
    await git.clone(origin, 'main');
    expect(await git.checkoutRunBranch('mates/API-198-retry-policy', 'main')).toBe('new');
    expect((await git.run(['branch', '--show-current'])).trim()).toBe('mates/API-198-retry-policy');
  });

  it('commits with the author and reports diff stats', async () => {
    await git.applyPatch(path.join(PATCHES, 'impl_iter1_green.patch'));
    const before = await git.headSha();
    const sha = await git.commitAll('API-198: Cap retry attempts\n\nJira: API-198\n');
    expect(sha).not.toBeNull();
    expect(sha).not.toBe(before);
    expect((await git.run(['log', '-1', '--format=%an <%ae>%n%s'])).trim()).toBe(
      'Mates <mates@example.com>\nAPI-198: Cap retry attempts',
    );
    await git.fetchBase('main');
    expect(await git.diffStat('origin/main')).toEqual({
      files_changed: 2,
      additions: 9,
      deletions: 2,
    });
    expect(await git.commitAll('nothing')).toBeNull();
  });

  it('refuses to push to the default branch or outside the pattern', async () => {
    await expect(git.push('main', 'mates/{ticket}-{slug}', 'main')).rejects.toBeInstanceOf(
      PushRefusedError,
    );
    await expect(git.push('feature/x', 'mates/{ticket}-{slug}', 'main')).rejects.toBeInstanceOf(
      PushRefusedError,
    );
  });

  it('pushes the run branch and a second clone sees it as existing', async () => {
    await git.push('mates/API-198-retry-policy', 'mates/{ticket}-{slug}', 'main');
    const other = new Git({
      cwd: path.join(await mkdtemp(path.join(tmpdir(), 'mates-ws2-')), 'repo'),
      username: 'u',
      token: undefined,
      authorName: 'M',
      authorEmail: 'm@m',
    });
    await other.clone(origin, 'main');
    expect(await other.checkoutRunBranch('mates/API-198-retry-policy', 'main')).toBe('existing');
    expect((await other.run(['log', '-1', '--format=%s'])).trim()).toBe(
      'API-198: Cap retry attempts',
    );
  });

  it('never puts the token in the remote url', async () => {
    const remotes = await git.run(['remote', '-v']);
    expect(remotes).not.toContain('secret-token');
  });

  it('turns a git failure into a readable error', async () => {
    await expect(git.run(['checkout', 'no-such-branch'])).rejects.toThrow(/git checkout failed/);
  });
});
