import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SEED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test/e2e/seed-repo',
);

/** A bare "origin" seeded from test/e2e/seed-repo with a main branch. */
export async function seedOrigin(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mates-git-'));
  const work = path.join(root, 'work');
  await mkdir(work);
  await cp(SEED, work, { recursive: true });
  const g = (args: string[], cwd = work) =>
    exec('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  await g(['init', '-q', '-b', 'main']);
  await g(['add', '-A']);
  await g(['commit', '-q', '-m', 'seed']);
  const origin = path.join(root, 'origin.git');
  await g(['clone', '-q', '--bare', work, origin], root);
  return origin;
}
