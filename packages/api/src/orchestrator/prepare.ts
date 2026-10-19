import type { Mate } from '@mates/core';
import type { Pool } from '../db/pool.js';
import { buildContextFiles, packContextBundle, type ContextInput } from '../invocations/context.js';
import { latestBlob } from '../runs/blobs.js';
import { projectRunById } from '../runs/events.js';
import { findInvocation, type Invocation } from '../runs/invocations.js';
import { findRun, findTicket } from '../runs/repository.js';
import type { SettingsService } from '../settings/service.js';
import type { TeamContextService } from '../team-context/service.js';
import { ticketDetailsSchema } from '../tracker/types.js';

/** Assembles the context bundle for an invocation from the database and settings. */
export interface PrepareDeps {
  db: Pool;
  settings: SettingsService;
  teamContext: TeamContextService;
  fakeClaude: boolean;
}

export class ContextUnavailableError extends Error {}

export async function prepareContextBundle(
  deps: PrepareDeps,
  invocationId: string,
): Promise<Buffer> {
  const invocation = await findInvocation(deps.db, invocationId);
  if (!invocation) throw new ContextUnavailableError('invocation not found');
  const run = await findRun(deps.db, invocation.runId);
  if (!run) throw new ContextUnavailableError('run not found');
  const ticket = (await findTicket(deps.db, run.ticketId))!;
  const projection = await projectRunById(deps.db, run.id);
  const settings = await deps.settings.get();
  const active = await deps.teamContext.active();
  if (!active?.manifest) throw new ContextUnavailableError('no active team context');
  const manifest = active.manifest;
  const teamPackage = (await deps.teamContext.packageOf(active.id)) ?? null;

  const repoId =
    invocation.mate === 'intake'
      ? candidateRepoId(manifest, ticket.projectKey ?? ticket.externalKey.split('-')[0] ?? '')
      : (projection.intake?.repo ?? null);
  const repo = repoId ? (manifest.repos.find((r) => r.id === repoId) ?? null) : null;
  const provider = repo ? (settings.scm.providers.find((p) => p.id === repo.scm) ?? null) : null;
  const baseBranch = projection.intake?.base_branch ?? repo?.default_branch ?? 'main';

  const details = ticketDetailsSchema.parse(
    (
      await deps.db.query<{ details: unknown }>('SELECT details FROM tickets WHERE id = $1', [
        ticket.id,
      ])
    ).rows[0]?.details ?? {},
  );

  let reviewer: ContextInput['reviewer'] = null;
  if (invocation.mate === 'reviewer') {
    const implementer = projection.iterations.find(
      (i) => i.n === invocation.iteration,
    )?.implementerId;
    const diff = implementer ? await latestBlob(deps.db, implementer, 'diff') : undefined;
    const tests = implementer ? await latestBlob(deps.db, implementer, 'tests_log') : undefined;
    reviewer = {
      diff: diff?.data.toString('utf8') ?? '',
      testsLog: tests?.data.toString('utf8') ?? '',
    };
  }
  const lastIteration =
    projection.iterations.find((i) => i.n === invocation.iteration - 1) ??
    projection.iterations.at(-1);
  const addressed =
    invocation.mate === 'reviewer'
      ? (projection.iterations.find((i) => i.n === invocation.iteration)?.addressed ?? null)
      : null;

  const input: ContextInput = {
    invocation: {
      id: invocation.id,
      runId: run.id,
      mate: invocation.mate,
      iteration: invocation.iteration,
    },
    run: { branch: run.branch ?? '', baseBranch, maxIterations: run.maxIterations },
    ticket: { key: ticket.externalKey, title: ticket.title, url: ticket.url, details },
    team: { manifest },
    repo,
    provider,
    mateSettings: settings.mates[invocation.mate],
    plan: projection.intake?.plan ?? [],
    verdicts: projection.verdicts,
    addressed: addressed
      ? { blocking_ids: addressed.blocking_ids, skipped: addressed.skipped }
      : null,
    nudges: invocation.mate === 'implementer' ? projection.pendingNudges : [],
    reviewer,
    fake: deps.fakeClaude ? fakeScenario(settings.fake_claude.scenarios, invocation) : null,
    promptOverrides: settings.prompts,
    gitAuthor: { name: 'Mates', email: 'mates@localhost' },
    setupTimeoutSeconds: 600,
    testTimeoutSeconds: 1200,
  };
  void lastIteration;
  return packContextBundle(await buildContextFiles(input), teamPackage);
}

export function candidateRepoId(
  manifest: { repos: { id: string; jira_projects: string[] }[] },
  project: string,
): string | null {
  const matches = manifest.repos.filter((r) => r.jira_projects.includes(project));
  return matches.length === 1 ? matches[0]!.id : null;
}

/** Picks the fixture for this mate and iteration; the list is indexed by iteration, last entry repeats. */
export function fakeScenario(
  scenarios: Record<Mate, string[]>,
  invocation: Pick<Invocation, 'mate' | 'iteration'>,
): { scenario: string; patch: string | null } {
  const list = scenarios[invocation.mate];
  const idx = Math.max(0, Math.min(invocation.iteration - 1, list.length - 1));
  const scenario = list[idx] ?? list[0] ?? `${invocation.mate}_default`;
  const patch =
    invocation.mate === 'implementer' && !/empty|budget/.test(scenario)
      ? `${scenario}.patch`
      : null;
  return { scenario, patch };
}
