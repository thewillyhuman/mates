import {
  CONTEXT_FILES,
  intakeJsonSchema,
  verdictJsonSchema,
  type InvocationContext,
  type Mate,
  type NudgeView,
  type RepoConfig,
  type TeamManifest,
  type VerdictView,
} from '@mates/core';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import type { ScmProvider } from '../settings/schema.js';
import { TeamContextService } from '../team-context/service.js';
import type { TicketDetails } from '../tracker/types.js';
import { renderPrompt } from './prompts.js';

/**
 * Builds the context bundle of §7.2 for one invocation: `invocation.json`,
 * the rendered brief and system prompt, ticket, prior verdicts, nudges,
 * output schemas, the reviewer's diff and test log, and the team package
 * under `team/`.
 */
export interface MateSettings {
  model: string;
  effort: 'low' | 'medium' | 'high' | null;
  max_budget_usd: number;
  max_turns: number;
  timeout_seconds: number;
}

export interface ContextInput {
  invocation: { id: string; runId: string; mate: Mate; iteration: number };
  run: { branch: string; baseBranch: string; maxIterations: number };
  ticket: { key: string; title: string; url: string | null; details: TicketDetails };
  team: { manifest: TeamManifest };
  repo: RepoConfig | null;
  provider: ScmProvider | null;
  mateSettings: MateSettings;
  plan: string[];
  verdicts: VerdictView[];
  /** The implementer's last `addressed` report, for the reviewer. */
  addressed: { blocking_ids: string[]; skipped: { id: string; reason: string }[] } | null;
  nudges: NudgeView[];
  reviewer: { diff: string; testsLog: string } | null;
  fake: { scenario: string; patch: string | null } | null;
  promptOverrides: Record<string, string>;
  gitAuthor: { name: string; email: string };
  setupTimeoutSeconds: number;
  testTimeoutSeconds: number;
}

/** Clone URL and credential username per provider type (decision 0010). */
export function cloneTarget(
  provider: ScmProvider,
  project: string,
): { cloneUrl: string; username: string } {
  const base = provider.base_url.replace(/\/+$/, '');
  const cloneUrl = `${base}/${project.replace(/^\/+/, '')}.git`;
  switch (provider.type) {
    case 'gitlab':
      return { cloneUrl, username: 'oauth2' };
    case 'github':
      return { cloneUrl, username: 'x-access-token' };
    case 'gitea':
      return { cloneUrl, username: provider.username || 'mates' };
  }
}

const bashRules = (commands: string[]): string[] =>
  commands.filter((c) => c.trim()).flatMap((c) => [`Bash(${c.trim()})`, `Bash(${c.trim()} *)`]);

/** Tool permissions per mate (§7.3). */
export function toolsFor(
  mate: Mate,
  repo: RepoConfig | null,
): { allowed: string[]; disallowed: string[]; mode: 'acceptEdits' | 'dontAsk' } {
  switch (mate) {
    case 'intake':
      return {
        allowed: ['Read', 'Glob', 'Grep', 'Bash(git log *)', 'Bash(git ls-files *)'],
        disallowed: [],
        mode: 'dontAsk',
      };
    case 'implementer':
      return {
        allowed: [
          'Read',
          'Edit',
          'Write',
          'Glob',
          'Grep',
          'Bash(git *)',
          ...bashRules([repo?.setup ?? '', repo?.test ?? '', repo?.lint ?? '']),
          'Bash(pnpm *)',
          'Bash(npm *)',
          'Bash(pip *)',
          'Bash(pytest *)',
          'Bash(make *)',
          ...bashRules(repo?.allowed_commands ?? []),
        ],
        disallowed: ['Bash(git push *)', 'Bash(git remote *)'],
        mode: 'acceptEdits',
      };
    case 'reviewer':
      return {
        allowed: [
          'Read',
          'Glob',
          'Grep',
          'Bash(git diff *)',
          'Bash(git log *)',
          ...bashRules([repo?.test ?? '']),
        ],
        disallowed: ['Edit', 'Write', 'Bash(git push *)'],
        mode: 'dontAsk',
      };
  }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** `invocation.json` for the runner. */
export function buildInvocationJson(input: ContextInput): InvocationContext {
  const { mate } = input.invocation;
  const tools = toolsFor(mate, input.repo);
  const target =
    input.repo && input.provider ? cloneTarget(input.provider, input.repo.project) : null;
  return {
    invocation_id: input.invocation.id,
    run_id: input.invocation.runId,
    mate,
    iteration: input.invocation.iteration,
    ticket: { key: input.ticket.key, title: input.ticket.title, url: input.ticket.url },
    repo:
      input.repo && target
        ? {
            id: input.repo.id,
            clone_url: target.cloneUrl,
            default_branch: input.repo.default_branch,
            base_branch: input.run.baseBranch,
            branch: input.run.branch,
            setup: input.repo.setup,
            test: input.repo.test,
            lint: input.repo.lint,
            env: input.repo.env,
            paths_hint: input.repo.paths_hint,
          }
        : null,
    git: {
      username: target?.username ?? 'mates',
      author_name: input.gitAuthor.name,
      author_email: input.gitAuthor.email,
    },
    claude: {
      model: input.mateSettings.model,
      allowed_tools: dedupe(tools.allowed),
      disallowed_tools: tools.disallowed,
      permission_mode: tools.mode,
      max_budget_usd: input.mateSettings.max_budget_usd,
      max_turns: input.mateSettings.max_turns,
      timeout_seconds: input.mateSettings.timeout_seconds,
      json_schema_file:
        mate === 'intake'
          ? CONTEXT_FILES.intakeSchema
          : mate === 'reviewer'
            ? CONTEXT_FILES.verdictSchema
            : null,
      effort: input.mateSettings.effort,
    },
    commit: {
      trailer: input.team.manifest.branching.commit_trailer,
      default_summary: input.ticket.title,
    },
    branching: { pattern: input.team.manifest.branching.pattern },
    setup_timeout_seconds: input.setupTimeoutSeconds,
    test_timeout_seconds: input.testTimeoutSeconds,
    fake: input.fake,
  };
}

/** Every text file of the bundle except the team package. */
export async function buildContextFiles(input: ContextInput): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const m = input.team.manifest;
  const { mate, iteration } = input.invocation;
  const t = input.ticket;
  const ticketView = {
    key: t.key,
    title: t.title,
    url: t.url,
    description: t.details.description || '(no description)',
    acceptance_criteria: t.details.acceptance_criteria || '(none stated)',
    comments: t.details.comments,
    links: t.details.links,
    labels: t.details.labels,
  };
  const lastVerdict = input.verdicts.at(-1) ?? null;
  const common = {
    ticket: ticketView,
    has_comments: t.details.comments.length > 0,
    has_links: t.details.links.length > 0,
    iteration,
    max_iterations: input.run.maxIterations,
    branch: input.run.branch,
    base_branch: input.run.baseBranch,
    repo: input.repo,
    conventions_first: m.team.conventions[0] ?? '',
  };

  files.set(
    CONTEXT_FILES.system,
    await renderPrompt(
      'system',
      {
        mate,
        team_name: m.team.name,
        conventions: m.team.conventions,
        has_extra_docs: m.team.extra_docs.length > 0,
        extra_docs: m.team.extra_docs,
        is_reviewer: mate === 'reviewer',
      },
      input.promptOverrides,
    ),
  );

  let brief: string;
  if (mate === 'intake') {
    brief = await renderPrompt(
      'intake',
      { ...common, repos: m.repos, repo_checkout: input.repo?.id ?? '' },
      input.promptOverrides,
    );
    files.set(CONTEXT_FILES.intakeSchema, JSON.stringify(intakeJsonSchema(), null, 2));
  } else if (mate === 'implementer') {
    const verdict =
      lastVerdict && lastVerdict.decision === 'changes_requested'
        ? {
            ...lastVerdict,
            has_non_blocking: lastVerdict.nonBlocking.length > 0,
            non_blocking: lastVerdict.nonBlocking,
          }
        : null;
    brief = await renderPrompt(
      'implementer',
      {
        ...common,
        has_plan: input.plan.length > 0,
        plan: input.plan,
        verdict,
        has_nudges: input.nudges.length > 0,
        nudges: input.nudges.map((n) => ({ ...n, ts: n.ts.slice(0, 16).replace('T', ' ') })),
      },
      input.promptOverrides,
    );
  } else {
    brief = await renderPrompt(
      'reviewer',
      {
        ...common,
        rubric: m.review.rubric ?? '',
        has_prior: input.verdicts.length > 0,
        addressed: input.addressed?.blocking_ids.join(', ') || 'nothing reported',
        skipped_text: input.addressed?.skipped.map((s) => `${s.id} (${s.reason})`).join(', ') ?? '',
      },
      input.promptOverrides,
    );
    files.set(CONTEXT_FILES.verdictSchema, JSON.stringify(verdictJsonSchema(), null, 2));
    files.set(CONTEXT_FILES.diff, input.reviewer?.diff ?? '');
    files.set(CONTEXT_FILES.testsLog, input.reviewer?.testsLog ?? '(no test output recorded)');
  }
  files.set(CONTEXT_FILES.brief, brief);
  files.set(
    CONTEXT_FILES.ticket,
    JSON.stringify({ key: t.key, title: t.title, url: t.url, ...t.details }, null, 2),
  );
  files.set(CONTEXT_FILES.priorVerdicts, JSON.stringify(input.verdicts, null, 2));
  files.set(CONTEXT_FILES.nudges, JSON.stringify(input.nudges, null, 2));
  files.set(CONTEXT_FILES.invocation, JSON.stringify(buildInvocationJson(input), null, 2));
  return files;
}

/** Packs the files plus the team package (extracted under `team/`) into a tar.gz. */
export async function packContextBundle(
  files: Map<string, string>,
  teamPackage: Buffer | null,
): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mates-bundle-'));
  try {
    for (const [name, content] of files) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), content);
    }
    const teamDir = path.join(dir, CONTEXT_FILES.teamDir);
    await mkdir(teamDir, { recursive: true });
    if (teamPackage) await TeamContextService.extract(teamPackage, teamDir);
    const out = path.join(dir, '..', `${path.basename(dir)}.tgz`);
    // Top-level entries, never `.`: extracting a `.` member would try to
    // chmod the runner's /context mount point, which it does not own.
    await tar.c({ gzip: true, cwd: dir, file: out, portable: true }, await readdir(dir));
    const buf = await readFile(out);
    await rm(out, { force: true });
    return buf;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
