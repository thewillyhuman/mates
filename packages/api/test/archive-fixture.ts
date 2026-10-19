import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';

/** A provider-style archive: everything under `<repo>-<sha>/`, like GitLab/GitHub/Gitea produce. */
export async function providerArchive(
  files: Record<string, string>,
  top = 'team-context-abc123',
): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mates-arch-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, top, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  const out = path.join(dir, 'a.tgz');
  await tar.c({ gzip: true, cwd: dir, file: out }, [top]);
  return readFile(out);
}
