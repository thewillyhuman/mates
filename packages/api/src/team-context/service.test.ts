import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDatabase, stopTestDatabase, type TestDatabase } from '../../test/db.js';
import { TeamContextError, TeamContextService } from './service.js';

afterAll(stopTestDatabase);

/** Builds a tar.gz package from a file map. */
export async function packageOf(files: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mates-pkg-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  const out = path.join(dir, '..', `${path.basename(dir)}.tgz`);
  await tar.c({ gzip: true, cwd: dir, file: out }, Object.keys(files));
  const { readFile } = await import('node:fs/promises');
  return readFile(out);
}

const manifest = `
version: 1
team:
  name: E2E team
  conventions: docs/conventions.md
repos:
  - id: webhook-service
    scm: gitea
    project: mates/webhook-service
    test: python3 -m unittest
`;

describe('TeamContextService', () => {
  let db: TestDatabase;
  let svc: TeamContextService;
  beforeAll(async () => {
    db = await freshDatabase();
    svc = new TeamContextService(db.pool, async () => ['gitea']);
  });

  it('activates a valid package and exposes its manifest', async () => {
    const v1 = await svc.upload(
      await packageOf({ 'mates.yaml': manifest, 'docs/conventions.md': '# c' }),
      'ana',
    );
    expect(v1).toMatchObject({ version: 1, active: true, errors: [], source: 'upload' });
    expect(v1.manifest?.repos[0]?.id).toBe('webhook-service');
    expect((await svc.active())?.id).toBe(v1.id);
    expect(await TeamContextService.listFiles((await svc.packageOf(v1.id))!)).toEqual([
      'mates.yaml',
      'docs/conventions.md',
    ]);
  });

  it('keeps the previous version active when the new one is invalid', async () => {
    const bad = await svc.upload(
      await packageOf({ 'mates.yaml': manifest.replace('scm: gitea', 'scm: nope') }),
      'ana',
    );
    expect(bad.active).toBe(false);
    expect(bad.version).toBe(2);
    expect(bad.errors.join('\n')).toMatch(/no source-control provider "nope"/);
    expect(bad.errors.join('\n')).toMatch(/conventions\.md" does not exist/);
    expect((await svc.active())?.version).toBe(1);
    expect((await svc.list()).map((v) => v.version)).toEqual([2, 1]);
  });

  it('rejects garbage and packages without a manifest', async () => {
    await expect(svc.upload(Buffer.from('not a tarball'), 'ana')).rejects.toBeInstanceOf(
      TeamContextError,
    );
    const noManifest = await svc.upload(await packageOf({ 'README.md': 'x' }), 'ana');
    expect(noManifest.active).toBe(false);
    expect(noManifest.errors).toEqual(['mates.yaml is missing from the package root']);
  });
});
