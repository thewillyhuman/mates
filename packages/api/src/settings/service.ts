import type { Pool, Queryable } from '../db/pool.js';
import type { HelmConfig } from './helm.js';
import {
  SETTINGS_SECTIONS,
  settingsSchema,
  type Settings,
  type SettingsSection,
} from './schema.js';

/**
 * Settings with the §5.2 precedence: defaults ← database (UI) ← Helm.
 * Helm-managed paths cannot be changed from the UI; `update` reports them
 * as ignored so the UI can show the "managed by Helm" badge.
 */
type Json = Record<string, unknown>;

export class SettingsValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid settings: ${issues.join('; ')}`);
  }
}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursive merge; arrays and scalars in `b` replace those in `a`. */
export function deepMerge(a: unknown, b: unknown): unknown {
  if (!isObject(a) || !isObject(b)) return b === undefined ? a : b;
  const out: Json = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
  return out;
}

function setPath(target: Json, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = target;
  for (const p of parts.slice(0, -1)) {
    if (!isObject(cur[p])) cur[p] = {};
    cur = cur[p] as Json;
  }
  cur[parts.at(-1)!] = value;
}

function hasPath(obj: unknown, path: string): boolean {
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (!isObject(cur) || !(p in cur)) return false;
    cur = cur[p];
  }
  return true;
}

/** Dotted settings paths and values the chart's values.yaml pins (§5.2). */
export function helmOverrides(helm: HelmConfig): Map<string, unknown> {
  const m = new Map<string, unknown>();
  const c = helm.config ?? {};
  const put = (path: string, v: unknown) => {
    if (v !== undefined) m.set(path, v);
  };
  put('limits.max_iterations', c.maxIterations);
  put('limits.per_run_usd', c.budgets?.perRunUsd);
  put('limits.per_day_usd', c.budgets?.perDayUsd);
  put('limits.timezone', c.timezone);
  put('mates.intake.model', c.models?.intake);
  put('mates.implementer.model', c.models?.implementer);
  put('mates.reviewer.model', c.models?.reviewer);
  put('jira.poll_interval_seconds', c.jira?.pollIntervalSeconds);
  put('retention.transcripts_days', c.retention?.transcriptsDays);
  put('retention.events_days', c.retention?.eventsDays);
  const r = helm.runner ?? {};
  put('runner.image', r.image);
  put('runner.resources', r.resources);
  put('runner.timeout_seconds', r.timeoutSeconds);
  put('runner.workspace_size_gi', r.workspaceSizeGi);
  return m;
}

export class SettingsService {
  private cache: Settings | undefined;
  private readonly overrides: Map<string, unknown>;

  constructor(
    private readonly db: Pool,
    helm: HelmConfig = {},
  ) {
    this.overrides = helmOverrides(helm);
  }

  /** Dotted paths the UI must show as managed by Helm. */
  managedPaths(): string[] {
    return [...this.overrides.keys()];
  }

  async get(): Promise<Settings> {
    if (this.cache) return this.cache;
    const stored = await this.readStored(this.db);
    this.cache = this.compose(stored);
    return this.cache;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  /**
   * Applies a partial update (any subset of sections, any depth). Returns
   * the effective settings and the Helm-managed paths that were ignored.
   */
  async update(patch: unknown, by: string): Promise<{ settings: Settings; ignored: string[] }> {
    if (!isObject(patch)) throw new SettingsValidationError(['body must be an object']);
    const unknown = Object.keys(patch).filter(
      (k) => !SETTINGS_SECTIONS.includes(k as SettingsSection),
    );
    if (unknown.length)
      throw new SettingsValidationError(unknown.map((k) => `unknown section "${k}"`));
    const ignored = [...this.overrides.keys()].filter((p) => hasPath(patch, p));

    const stored = await this.readStored(this.db);
    const next: Json = { ...stored };
    for (const [section, value] of Object.entries(patch)) {
      next[section] = deepMerge(stored[section] ?? {}, value);
    }
    const composed = this.compose(next); // throws on invalid
    for (const section of Object.keys(patch)) {
      await this.db.query(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [section, JSON.stringify(next[section]), by],
      );
    }
    this.cache = composed;
    return { settings: composed, ignored };
  }

  private async readStored(db: Queryable): Promise<Json> {
    const r = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
    const out: Json = {};
    for (const row of r.rows) {
      if (SETTINGS_SECTIONS.includes(row.key as SettingsSection)) out[row.key] = row.value;
    }
    return out;
  }

  private compose(stored: Json): Settings {
    const merged = { ...stored };
    for (const [path, value] of this.overrides) setPath(merged, path, value);
    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new SettingsValidationError(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }
    return parsed.data;
  }
}
