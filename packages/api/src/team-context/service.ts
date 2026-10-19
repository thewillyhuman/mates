import { validateTeamManifest, type TeamManifest } from '@mates/core';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import type { Pool, Queryable } from '../db/pool.js';

/**
 * Team-context packages (§6.2 step 4, §6.3). A version is a tar.gz with
 * `mates.yaml` at its root; it becomes active only when validation passes,
 * otherwise the previous version stays active and the errors are stored.
 */
export interface TeamContextVersion {
  id: string;
  version: number;
  source: 'git' | 'upload';
  ref: string | null;
  manifest: TeamManifest | null;
  errors: string[];
  fetchedAt: Date;
  active: boolean;
  createdBy: string | null;
  sizeBytes: number;
}

interface Row {
  id: string;
  version: number;
  source: 'git' | 'upload';
  ref: string | null;
  manifest: TeamManifest | null;
  errors: string[];
  fetched_at: Date;
  active: boolean;
  created_by: string | null;
  size_bytes: number;
}

const columns =
  'id, version, source, ref, manifest, errors, fetched_at, active, created_by, length(package) AS size_bytes';

function toVersion(r: Row): TeamContextVersion {
  return {
    id: r.id,
    version: r.version,
    source: r.source,
    ref: r.ref,
    manifest: r.manifest,
    errors: r.errors,
    fetchedAt: r.fetched_at,
    active: r.active,
    createdBy: r.created_by,
    sizeBytes: Number(r.size_bytes),
  };
}

export class TeamContextError extends Error {}

/** Max package size accepted (tar.gz). */
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;

export class TeamContextService {
  constructor(
    private readonly db: Pool,
    private readonly providerIds: () => Promise<string[]>,
  ) {}

  /** Lists the files of a tar.gz package (normalised, no leading `./`). */
  static async listFiles(pkg: Buffer): Promise<string[]> {
    const dir = await mkdtemp(path.join(tmpdir(), 'mates-tc-'));
    try {
      const file = path.join(dir, 'pkg.tgz');
      await writeFile(file, pkg);
      const files: string[] = [];
      await tar.t({
        file,
        onReadEntry: (entry) => {
          if (entry.type === 'File') files.push(normalise(entry.path));
        },
      });
      return files;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Extracts the package into `dest` (used by the context bundle builder). */
  static async extract(pkg: Buffer, dest: string): Promise<void> {
    const file = path.join(dest, '.pkg.tgz');
    await writeFile(file, pkg);
    await tar.x({ file, cwd: dest, strip: 0 });
    await rm(file, { force: true });
  }

  /**
   * Repacks a provider archive (which wraps everything in `<repo>-<sha>/`)
   * so `mates.yaml` sits at the root like an uploaded package.
   */
  static async stripTopLevel(archive: Buffer): Promise<Buffer> {
    const dir = await mkdtemp(path.join(tmpdir(), 'mates-tc-'));
    try {
      const file = path.join(dir, 'in.tgz');
      await writeFile(file, archive);
      const out = path.join(dir, 'out');
      await mkdir(out, { recursive: true });
      await tar.x({ file, cwd: out, strip: 1 });
      const entries = (await readdir(out)).filter((n) => !n.startsWith('.pkg'));
      const packed = path.join(dir, 'out.tgz');
      await tar.c({ gzip: true, cwd: out, file: packed, portable: true }, entries);
      return await readFile(packed);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The active version's provider commit, so the poll can skip unchanged refs. */
  async activeRef(): Promise<string | null> {
    const r = await this.db.query<{ ref: string | null }>(
      'SELECT ref FROM team_context WHERE active',
    );
    return r.rows[0]?.ref ?? null;
  }

  /** Validates and stores a package; activates it when valid. */
  async upload(
    pkg: Buffer,
    by: string,
    source: 'upload' | 'git' = 'upload',
    ref: string | null = null,
  ): Promise<TeamContextVersion> {
    if (pkg.length === 0) throw new TeamContextError('package is empty');
    if (pkg.length > MAX_PACKAGE_BYTES)
      throw new TeamContextError(`package exceeds ${MAX_PACKAGE_BYTES} bytes`);
    let files: string[];
    let yamlText: string | undefined;
    try {
      files = await TeamContextService.listFiles(pkg);
      yamlText = await this.readFileFromPackage(pkg, 'mates.yaml');
    } catch (err) {
      throw new TeamContextError(`package is not a readable tar.gz: ${(err as Error).message}`);
    }
    const result =
      yamlText === undefined
        ? {
            ok: false as const,
            manifest: null,
            errors: ['mates.yaml is missing from the package root'],
          }
        : validateTeamManifest(yamlText, {
            providers: await this.providerIds(),
            fileExists: (p) => files.includes(normalise(p)),
          });

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // Serialise version allocation; the lock is released at COMMIT/ROLLBACK.
      await client.query('SELECT pg_advisory_xact_lock($1)', [0x7463]);
      const next = await client.query<{ v: number }>(
        'SELECT COALESCE(max(version), 0) + 1 AS v FROM team_context',
      );
      if (result.ok) await client.query('UPDATE team_context SET active = false WHERE active');
      const r = await client.query<Row>(
        `INSERT INTO team_context (version, source, ref, manifest, errors, package, active, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${columns}`,
        [
          next.rows[0]!.v,
          source,
          ref,
          result.manifest ? JSON.stringify(result.manifest) : null,
          JSON.stringify(result.errors),
          pkg,
          result.ok,
          by,
        ],
      );
      await client.query('COMMIT');
      return toVersion(r.rows[0]!);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async active(db: Queryable = this.db): Promise<TeamContextVersion | undefined> {
    const r = await db.query<Row>(`SELECT ${columns} FROM team_context WHERE active`);
    return r.rows[0] ? toVersion(r.rows[0]) : undefined;
  }

  async list(): Promise<TeamContextVersion[]> {
    const r = await this.db.query<Row>(`SELECT ${columns} FROM team_context ORDER BY version DESC`);
    return r.rows.map(toVersion);
  }

  async get(id: string): Promise<TeamContextVersion | undefined> {
    const r = await this.db.query<Row>(`SELECT ${columns} FROM team_context WHERE id = $1`, [id]);
    return r.rows[0] ? toVersion(r.rows[0]) : undefined;
  }

  async packageOf(id: string): Promise<Buffer | undefined> {
    const r = await this.db.query<{ package: Buffer }>(
      'SELECT package FROM team_context WHERE id = $1',
      [id],
    );
    return r.rows[0]?.package;
  }

  private async readFileFromPackage(pkg: Buffer, name: string): Promise<string | undefined> {
    const dir = await mkdtemp(path.join(tmpdir(), 'mates-tc-'));
    try {
      await TeamContextService.extract(pkg, dir);
      return await readFile(path.join(dir, name), 'utf8').catch(() => undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function normalise(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}
