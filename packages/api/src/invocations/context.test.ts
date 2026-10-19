import { invocationContextSchema, type TeamManifest } from '@mates/core';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { describe, expect, it } from 'vitest';
import { emptyTicketDetails } from '../tracker/types.js';
import { packageOf } from '../team-context/service.test.js';
import {
  buildContextFiles,
  cloneTarget,
  packContextBundle,
  toolsFor,
  type ContextInput,
} from './context.js';
import { validateTemplate } from './prompts.js';

const manifest: TeamManifest = {
  version: 1,
  team: {
    name: 'Payments',
    conventions: ['docs/conventions.md'],
    extra_docs: [{ path: 'docs/testing.md', about: 'tests' }],
  },
  repos: [
    {
      id: 'webhook-service',
      scm: 'gitlab',
      project: 'platform/webhook-service',
      default_branch: 'main',
      about: 'Webhooks',
      jira_projects: ['API'],
      paths_hint: [],
      setup: 'pnpm install',
      test: 'pnpm test',
      lint: '',
      env: {},
      allowed_commands: ['pnpm exec tsc'],
    },
  ],
  branching: { pattern: 'mates/{ticket}-{slug}', commit_trailer: 'Jira: {ticket}' },
  review: { rubric: 'docs/rubric.md' },
};

function input(overrides: Partial<ContextInput> = {}): ContextInput {
  return {
    invocation: { id: 'inv-1', runId: 'run-1', mate: 'implementer', iteration: 2 },
    run: { branch: 'mates/API-198-retry-policy', baseBranch: 'main', maxIterations: 4 },
    ticket: {
      key: 'API-198',
      title: 'Retry policy for webhook delivery',
      url: 'https://jira/browse/API-198',
      details: {
        ...emptyTicketDetails(),
        description: 'Cap retries at 5 within 10 minutes.',
        acceptance_criteria: 'AC1',
      },
    },
    team: { manifest },
    repo: manifest.repos[0]!,
    provider: {
      id: 'gitlab',
      type: 'gitlab',
      base_url: 'https://gitlab.example.com/',
      username: '',
      draft_mrs: true,
      labels: [],
      reviewers: [],
    },
    mateSettings: {
      model: 'claude-opus-5-5',
      effort: null,
      max_budget_usd: 10,
      max_turns: 100,
      timeout_seconds: 2700,
    },
    plan: ['Add ceiling', 'Add tests'],
    verdicts: [
      {
        iteration: 1,
        invocationId: 'inv-r1',
        decision: 'changes_requested',
        blocking: [
          {
            id: 'B1',
            title: 'Backoff is unbounded',
            detail: 'no ceiling',
            file: 'src/retry.ts',
            line: 41,
          },
        ],
        nonBlocking: [{ id: 'N1', title: 'Docstring', detail: '', file: null, line: null }],
        summary: 'no',
        ts: '2026-10-19T14:29:00.000Z',
      },
    ],
    addressed: null,
    nudges: [
      {
        id: 'n1',
        by: 'Ana Keller',
        text: 'Use the existing BackoffSchedule helper.',
        ts: '2026-10-19T14:40:00.000Z',
        consumedBy: null,
      },
    ],
    reviewer: null,
    fake: null,
    promptOverrides: {},
    gitAuthor: { name: 'Mates', email: 'mates@example.com' },
    setupTimeoutSeconds: 600,
    testTimeoutSeconds: 1200,
    ...overrides,
  };
}

describe('cloneTarget', () => {
  it('derives clone urls and credential usernames per provider type', () => {
    const base = {
      id: 'p',
      base_url: 'https://host/',
      username: '',
      draft_mrs: true,
      labels: [],
      reviewers: [],
    };
    expect(cloneTarget({ ...base, type: 'gitlab' }, 'a/b')).toEqual({
      cloneUrl: 'https://host/a/b.git',
      username: 'oauth2',
    });
    expect(cloneTarget({ ...base, type: 'github' }, 'a/b')).toEqual({
      cloneUrl: 'https://host/a/b.git',
      username: 'x-access-token',
    });
    expect(cloneTarget({ ...base, type: 'gitea', username: 'bot' }, '/a/b')).toEqual({
      cloneUrl: 'https://host/a/b.git',
      username: 'bot',
    });
  });
});

describe('toolsFor', () => {
  it('gives each mate the §7.3 permissions', () => {
    const impl = toolsFor('implementer', manifest.repos[0]!);
    expect(impl.allowed).toEqual(
      expect.arrayContaining([
        'Edit',
        'Bash(git *)',
        'Bash(pnpm test *)',
        'Bash(pnpm install *)',
        'Bash(pnpm exec tsc *)',
      ]),
    );
    expect(impl.disallowed).toContain('Bash(git push *)');
    expect(impl.mode).toBe('acceptEdits');
    const rev = toolsFor('reviewer', manifest.repos[0]!);
    expect(rev.allowed).not.toContain('Edit');
    expect(rev.allowed).toContain('Bash(pnpm test *)');
    expect(rev.disallowed).toContain('Edit');
    expect(toolsFor('intake', null).allowed).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Bash(git log *)',
      'Bash(git ls-files *)',
    ]);
  });
});

describe('buildContextFiles', () => {
  it('renders the implementer brief of Appendix B with verdict, plan and nudge', async () => {
    const files = await buildContextFiles(input());
    const brief = files.get('brief.md')!;
    expect(brief).toContain(
      '# Task — API-198: Retry policy for webhook delivery (iteration 2 of 4)',
    );
    expect(brief).toContain('branch `mates/API-198-retry-policy`, base `main`');
    expect(brief).toContain('Read `/context/team/docs/conventions.md` before anything else.');
    expect(brief).toContain('1. Add ceiling');
    expect(brief).toContain('## Reviewer verdict on iteration 1 — changes requested');
    expect(brief).toContain('- B1 **Backoff is unbounded** no ceiling (src/retry.ts:41)');
    expect(brief).toContain('Non-blocking (optional):');
    expect(brief).toContain(
      '"Use the existing BackoffSchedule helper." — Ana Keller, 2026-10-19 14:40',
    );
    expect(brief).toContain('Run `pnpm test` before you finish');
    expect(brief).toContain('{"addressed"');
    expect(brief).not.toContain('&quot;');

    const system = files.get('system.md')!;
    expect(system).toContain('**implementer** mate');
    expect(system).toContain('"Payments"');
    expect(system).toContain('- `/context/team/docs/conventions.md`');
    expect(system).toContain('- `/context/team/docs/testing.md` — tests');

    const inv = invocationContextSchema.parse(JSON.parse(files.get('invocation.json')!));
    expect(inv.repo).toMatchObject({
      clone_url: 'https://gitlab.example.com/platform/webhook-service.git',
      branch: 'mates/API-198-retry-policy',
      test: 'pnpm test',
    });
    expect(inv.git.username).toBe('oauth2');
    expect(inv.claude).toMatchObject({
      permission_mode: 'acceptEdits',
      json_schema_file: null,
      max_budget_usd: 10,
    });
    expect(inv.commit).toEqual({
      trailer: 'Jira: {ticket}',
      default_summary: 'Retry policy for webhook delivery',
    });
    expect(files.has('verdict.schema.json')).toBe(false);
    expect(JSON.parse(files.get('nudges.json')!)).toHaveLength(1);
  });

  it('renders the reviewer bundle with diff, tests log, schema and prior verdicts', async () => {
    const files = await buildContextFiles(
      input({
        invocation: { id: 'inv-2', runId: 'run-1', mate: 'reviewer', iteration: 2 },
        addressed: { blocking_ids: ['B1'], skipped: [{ id: 'N1', reason: 'later' }] },
        reviewer: { diff: 'diff --git a/x b/x', testsLog: 'Ran 5 tests\n\nOK' },
      }),
    );
    const brief = files.get('brief.md')!;
    expect(brief).toContain('# Review — API-198');
    expect(brief).toContain('`/context/team/docs/rubric.md`');
    expect(brief).toContain('addressing: B1; skipped: N1 (later)');
    expect(files.get('diff.patch')).toBe('diff --git a/x b/x');
    expect(files.get('tests.log')).toContain('OK');
    expect(JSON.parse(files.get('verdict.schema.json')!)).toHaveProperty('properties.decision');
    const inv = invocationContextSchema.parse(JSON.parse(files.get('invocation.json')!));
    expect(inv.claude.json_schema_file).toBe('verdict.schema.json');
    expect(inv.claude.disallowed_tools).toContain('Edit');
    expect(files.get('system.md')).toContain('You are reviewing');
  });

  it('renders the intake brief with the repo list and no checkout when ambiguous', async () => {
    const files = await buildContextFiles(
      input({
        invocation: { id: 'inv-0', runId: 'run-1', mate: 'intake', iteration: 0 },
        repo: null,
        provider: null,
        verdicts: [],
        nudges: [],
      }),
    );
    const brief = files.get('brief.md')!;
    expect(brief).toContain('# Intake — API-198');
    expect(brief).toContain(
      '- `webhook-service` (platform/webhook-service, default branch `main`): Webhooks — Jira projects: API',
    );
    expect(brief).not.toContain('A checkout of');
    const inv = invocationContextSchema.parse(JSON.parse(files.get('invocation.json')!));
    expect(inv.repo).toBeNull();
    expect(inv.claude.json_schema_file).toBe('intake.schema.json');
    expect(files.has('intake.schema.json')).toBe(true);
  });

  it('applies prompt overrides and carries the fake scenario', async () => {
    const files = await buildContextFiles(
      input({
        promptOverrides: { implementer: 'custom {{ticket.key}} {{branch}} {{iteration}}' },
        fake: { scenario: 'impl_iter2_addressed', patch: 'impl_iter2_addressed.patch' },
      }),
    );
    expect(files.get('brief.md')).toBe('custom API-198 mates/API-198-retry-policy 2');
    expect(invocationContextSchema.parse(JSON.parse(files.get('invocation.json')!)).fake).toEqual({
      scenario: 'impl_iter2_addressed',
      patch: 'impl_iter2_addressed.patch',
    });
  });
});

describe('validateTemplate', () => {
  it('reports syntax errors and missing placeholders', () => {
    expect(validateTemplate('implementer', '{{#unclosed}}')).toEqual([
      expect.stringContaining('template syntax'),
    ]);
    expect(validateTemplate('implementer', 'hello')).toEqual([
      'missing placeholder {{ticket.key}}',
      'missing placeholder {{branch}}',
      'missing placeholder {{iteration}}',
    ]);
    expect(
      validateTemplate('system', '{{team_name}} {{mate}} {{#conventions}}{{.}}{{/conventions}}'),
    ).toEqual([]);
  });
});

describe('packContextBundle', () => {
  it('produces a tar.gz with the files and the team package under team/', async () => {
    const files = await buildContextFiles(input());
    const pkg = await packageOf({ 'mates.yaml': 'version: 1', 'docs/conventions.md': '# conv' });
    const bundle = await packContextBundle(files, pkg);
    const dir = await mkdtemp(path.join(tmpdir(), 'mates-unpack-'));
    const file = path.join(dir, 'b.tgz');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, bundle);
    await tar.x({ file, cwd: dir });
    expect(await readFile(path.join(dir, 'brief.md'), 'utf8')).toContain('API-198');
    expect(await readFile(path.join(dir, 'team/docs/conventions.md'), 'utf8')).toBe('# conv');
    expect(await readFile(path.join(dir, 'team/mates.yaml'), 'utf8')).toBe('version: 1');
    // No `.` member: extraction must not touch the target directory itself.
    const entries: string[] = [];
    await tar.t({ file, onReadEntry: (e) => void entries.push(e.path) });
    expect(entries).not.toContain('./');
    expect(entries).not.toContain('.');
  });
});
