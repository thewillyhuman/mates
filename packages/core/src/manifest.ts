import { z } from 'zod';
import { load as loadYaml } from 'js-yaml';

/**
 * The team-context manifest `mates.yaml` (§6.3): schema plus the validation
 * rules that decide whether a version can become active.
 */
const extraDocSchema = z.object({ path: z.string().min(1), about: z.string().min(1) });

export const repoSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  scm: z.string().min(1),
  project: z.string().min(1),
  default_branch: z.string().min(1).default('main'),
  about: z.string().default(''),
  jira_projects: z.array(z.string().min(1)).default([]),
  paths_hint: z.array(z.string()).default([]),
  setup: z.string().default(''),
  test: z.string().default(''),
  lint: z.string().default(''),
  runner_image: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  allowed_commands: z.array(z.string()).default([]),
});
export type RepoConfig = z.infer<typeof repoSchema>;

export const teamManifestSchema = z.object({
  version: z.literal(1),
  team: z.object({
    name: z.string().min(1),
    conventions: z
      .union([z.string().min(1), z.array(z.string().min(1))])
      .transform((v) => (typeof v === 'string' ? [v] : v)),
    extra_docs: z.array(extraDocSchema).default([]),
  }),
  repos: z.array(repoSchema).min(1),
  branching: z
    .object({
      pattern: z.string().min(1).default('mates/{ticket}-{slug}'),
      commit_trailer: z.string().default('Jira: {ticket}'),
    })
    .default({ pattern: 'mates/{ticket}-{slug}', commit_trailer: 'Jira: {ticket}' }),
  review: z
    .object({
      rubric: z.string().optional(),
      max_iterations: z.number().int().min(1).max(10).optional(),
    })
    .default({}),
});
export type TeamManifest = z.infer<typeof teamManifestSchema>;

export interface ManifestContext {
  /** Provider ids configured in Settings → Source control. */
  readonly providers: readonly string[];
  /** Whether a path inside the package exists. */
  readonly fileExists: (path: string) => boolean;
}

export type ManifestResult =
  | { ok: true; manifest: TeamManifest; errors: [] }
  | { ok: false; manifest: TeamManifest | null; errors: string[] };

/** Parses YAML, applies the schema and the §6.3 rules. Never throws. */
export function validateTeamManifest(yamlText: string, ctx: ManifestContext): ManifestResult {
  let raw: unknown;
  try {
    raw = loadYaml(yamlText);
  } catch (err) {
    return {
      ok: false,
      manifest: null,
      errors: [`mates.yaml is not valid YAML: ${(err as Error).message}`],
    };
  }
  const parsed = teamManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      manifest: null,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'mates.yaml'}: ${i.message}`),
    };
  }
  const m = parsed.data;
  const errors: string[] = [];

  const ids = new Set<string>();
  for (const r of m.repos) {
    if (ids.has(r.id)) errors.push(`repos: duplicate id "${r.id}"`);
    ids.add(r.id);
    if (!ctx.providers.includes(r.scm)) {
      errors.push(`repos.${r.id}.scm: no source-control provider "${r.scm}" is configured`);
    }
  }
  const paths = [
    ...m.team.conventions.map((p) => ['team.conventions', p] as const),
    ...m.team.extra_docs.map((d) => [`team.extra_docs(${d.path})`, d.path] as const),
    ...(m.review.rubric ? [['review.rubric', m.review.rubric] as const] : []),
  ];
  for (const [where, p] of paths) {
    if (!ctx.fileExists(p)) errors.push(`${where}: file "${p}" does not exist in the package`);
  }
  if (!m.branching.pattern.includes('{ticket}')) {
    errors.push('branching.pattern: must contain {ticket}');
  }
  return errors.length ? { ok: false, manifest: m, errors } : { ok: true, manifest: m, errors: [] };
}
