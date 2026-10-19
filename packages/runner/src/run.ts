import {
  CONTEXT_FILES,
  commitMessage,
  event,
  invocationContextSchema,
  parseTestOutput,
  redact,
  type ClaudeResult,
  type InvocationContext,
  type NewEvent,
} from '@mates/core';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { RunnerApi } from './api.js';
import { runClaude } from './claude.js';
import type { RunnerEnv } from './env.js';
import { Git, PushRefusedError } from './git.js';
import type { Log } from './log.js';
import {
  addUsage,
  condense,
  extractAddressedBlock,
  type StreamLine,
  type TokenUsage,
} from './stream.js';

const execFileAsync = promisify(execFile);

/** Thrown to end the invocation with `invocation.failed { reason }`. */
export class InvocationError extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(detail);
  }
}

const HEARTBEAT_MS = 30_000;
const RECENT_TEST_RUN_MS = 5 * 60 * 1000;
const TEXT_LIMIT = 2000;
const RESULT_TEXT_LIMIT = 8000;

export interface RunDeps {
  env: RunnerEnv;
  log: Log;
  api?: RunnerApi;
  signal: AbortSignal;
  /** Where the final test command is run; defaults to `sh -c`. */
  now?: () => number;
}

/**
 * The invocation lifecycle of §7.3. Returns the process exit code. Every
 * failure path emits `invocation.failed` and resolves to 1 (143 when
 * cancelled) instead of throwing.
 */
export async function runInvocation(deps: RunDeps): Promise<number> {
  const { env, log } = deps;
  const api =
    deps.api ??
    new RunnerApi({
      apiUrl: env.apiUrl,
      token: env.token,
      invocationId: env.invocationId,
      secrets: env.secrets,
      log,
    });
  const now = deps.now ?? Date.now;
  const started = now();
  const emit = (e: NewEvent) => api.emit(e);

  let liveUsage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
  let lastUsageEmit = 0;
  const heartbeat = setInterval(
    () => emit({ type: 'invocation.heartbeat', payload: { usage: liveUsage } }),
    HEARTBEAT_MS,
  );

  try {
    emit({ type: 'invocation.started', payload: { pod_name: process.env.HOSTNAME ?? '' } });
    await api.flush();

    // 1. Context bundle.
    await rm(env.contextDir, { recursive: true, force: true }).catch(() => undefined);
    await api.downloadContext(env.contextDir).catch((err: Error) => {
      throw new InvocationError('context_download_failed', err.message);
    });
    const ctx = await loadContext(env.contextDir);
    if (ctx.invocation_id !== env.invocationId) {
      throw new InvocationError('context_mismatch', 'invocation.json is for another invocation');
    }
    const repoDir = path.join(env.workspace, 'repo');
    const git = new Git({
      cwd: repoDir,
      username: ctx.git.username,
      token: env.gitToken,
      authorName: ctx.git.author_name,
      authorEmail: ctx.git.author_email,
    });
    const repo = ctx.repo;
    if (!repo && ctx.mate !== 'intake') {
      throw new InvocationError('context_invalid', `${ctx.mate} requires a repository`);
    }

    // 2. Clone and check out the right branch (intake may run without a repo).
    await rm(repoDir, { recursive: true, force: true });
    await mkdir(repoDir, { recursive: true });
    if (repo) {
      await rm(repoDir, { recursive: true, force: true });
      await git.clone(repo.clone_url, repo.base_branch).catch((err: Error) => {
        throw new InvocationError('clone_failed', err.message);
      });
      const needsRunBranch = ctx.mate === 'reviewer' || ctx.mate === 'implementer';
      if (needsRunBranch) {
        // A fresh run (implementer, iteration 1) takes over a stale branch left by an earlier run of the ticket.
        const fresh = ctx.mate === 'implementer' && ctx.iteration === 1;
        await git.checkoutRunBranch(repo.branch, repo.base_branch, fresh).catch((err: Error) => {
          throw new InvocationError('checkout_failed', err.message);
        });
      }
      log.info('workspace ready', {
        repo: repo.id,
        branch: needsRunBranch ? repo.branch : repo.base_branch,
      });

      // 3. Setup.
      if (repo.setup.trim()) {
        await runShell(
          repo.setup,
          repoDir,
          repo.env,
          ctx.setup_timeout_seconds * 1000,
          deps.signal,
        ).catch((err: Error) => {
          throw new InvocationError('setup_failed', err.message);
        });
      }
    }
    const headBefore = repo ? await git.headSha() : '';

    // 4–5. Claude Code, streamed and condensed.
    const texts: string[] = [];
    let result: ClaudeResult | null = null;
    let lastTestRun: { at: number; toolUseId: string } | null = null;
    const toolResults = new Map<string, string>();
    const pendingTestIds = new Set<string>();
    const onLine = (line: StreamLine) => {
      for (const c of condense(line)) {
        switch (c.kind) {
          case 'tool_use': {
            emit({
              type: 'invocation.tool_use',
              payload: { tool: c.tool, summary: c.summary.slice(0, 500) },
            });
            const command = typeof c.input.command === 'string' ? c.input.command : '';
            if (c.tool === 'Bash' && repo?.test && command.includes(repo.test)) {
              lastTestRun = { at: now(), toolUseId: c.id };
              pendingTestIds.add(c.id);
            }
            break;
          }
          case 'tool_result':
            if (pendingTestIds.has(c.toolUseId)) toolResults.set(c.toolUseId, c.content);
            break;
          case 'text':
            texts.push(c.text);
            emit({ type: 'invocation.text', payload: { text: c.text.slice(0, TEXT_LIMIT) } });
            break;
          case 'api_retry':
            emit({ type: 'invocation.heartbeat', payload: { note: c.note, usage: liveUsage } });
            break;
          case 'usage':
            liveUsage = addUsage(liveUsage, c.usage);
            if (now() - lastUsageEmit > 5000) {
              lastUsageEmit = now();
              emit({ type: 'invocation.heartbeat', payload: { usage: liveUsage } });
            }
            break;
          case 'result':
            result = c.result;
            break;
        }
      }
    };
    const transcriptPath = path.join(env.workspace, 'transcript.jsonl');
    const claude = await runClaude({
      ctx,
      contextDir: env.contextDir,
      workspace: repoDir,
      transcriptPath,
      log,
      onLine,
      signal: deps.signal,
      fake: env.fakeClaude
        ? {
            fixturesDir: env.fixturesDir,
            applyPatch: (f) => applyFakePatch(git, repoDir, f, ctx, log),
          }
        : undefined,
      env: env.anthropicApiKey ? { ANTHROPIC_API_KEY: env.anthropicApiKey } : {},
    });
    if (deps.signal.aborted) throw new InvocationError('cancelled', 'invocation cancelled');
    if (claude.timedOut)
      throw new InvocationError('timeout', `claude exceeded ${ctx.claude.timeout_seconds}s`);
    if (claude.exitCode === 127)
      throw new InvocationError('claude_not_found', 'claude binary could not be started');

    // 6. Implementer: commit, push, measure, test.
    if (ctx.mate === 'implementer' && repo) {
      await finishImplementation({
        ctx,
        repo,
        git,
        headBefore,
        texts,
        api,
        emit,
        log,
        repoDir,
        now,
        lastTestRun,
        toolResults,
        signal: deps.signal,
      });
    }

    // 7. Transcript blob.
    const transcriptRef = await uploadTranscript(api, transcriptPath, env.secrets).catch(
      (err: Error) => {
        log.warn('transcript upload failed', { error: err.message });
        return null;
      },
    );

    // 8. Done.
    const redacted = result
      ? (JSON.parse(
          redact(JSON.stringify(trimResult(result)), { secrets: env.secrets }),
        ) as ClaudeResult)
      : null;
    emit({
      type: 'invocation.finished',
      payload: {
        exit_code: claude.exitCode,
        duration_ms: now() - started,
        session_id: redacted?.session_id ?? null,
        result: redacted,
        transcript_ref: transcriptRef,
      },
    });
    await api.flush();
    return 0;
  } catch (err) {
    // Whatever step was interrupted, an aborted invocation is reported as cancelled.
    const reason = deps.signal.aborted
      ? 'cancelled'
      : err instanceof InvocationError
        ? err.reason
        : 'runner_error';
    const detail = err instanceof Error ? err.message : String(err);
    log.error('invocation failed', { reason, detail });
    emit({ type: 'invocation.failed', payload: { reason, detail: detail.slice(0, 2000) } });
    await api
      .flush()
      .catch((e: Error) => log.error('could not report failure', { error: e.message }));
    return reason === 'cancelled' ? 143 : 1;
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Fake mode: apply the scenario's patch; when it no longer applies (the
 * same scenario replayed on a later iteration) make a small visible change
 * instead so the loop still sees a non-empty diff.
 */
async function applyFakePatch(
  git: Git,
  repoDir: string,
  file: string,
  ctx: InvocationContext,
  log: Log,
): Promise<void> {
  try {
    await git.run(['apply', '--check', '--whitespace=nowarn', file]);
    await git.applyPatch(file);
  } catch (err) {
    log.warn('fake patch does not apply; appending a marker change instead', {
      patch: path.basename(file),
      error: (err as Error).message.slice(0, 200),
    });
    await appendFile(
      path.join(repoDir, 'README.md'),
      `\nMates fake iteration ${ctx.iteration}: ${path.basename(file)}\n`,
    );
  }
}

async function loadContext(dir: string): Promise<InvocationContext> {
  const raw = await readFile(path.join(dir, CONTEXT_FILES.invocation), 'utf8').catch(() => {
    throw new InvocationError('context_invalid', `${CONTEXT_FILES.invocation} missing from bundle`);
  });
  const parsed = invocationContextSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new InvocationError('context_invalid', parsed.error.message);
  return parsed.data;
}

interface FinishDeps {
  ctx: InvocationContext;
  repo: NonNullable<InvocationContext['repo']>;
  git: Git;
  headBefore: string;
  texts: string[];
  api: RunnerApi;
  emit: (e: NewEvent) => void;
  log: Log;
  repoDir: string;
  now: () => number;
  lastTestRun: { at: number; toolUseId: string } | null;
  toolResults: Map<string, string>;
  signal: AbortSignal;
}

async function finishImplementation(d: FinishDeps): Promise<void> {
  const { ctx, git, repo } = d;
  const addressed =
    extractAddressedBlock(d.texts.at(-1) ?? '') ?? extractAddressedBlock(d.texts.join('\n'));
  const summary = addressed?.summary?.trim() || ctx.commit.default_summary;
  const message = commitMessage(ctx.ticket.key, summary, ctx.commit.trailer);
  const commit = await git.commitAll(message);
  const head = commit ?? (await git.headSha());
  const changedInIteration = head !== d.headBefore;

  await git.fetchBase(repo.base_branch).catch(() => undefined);
  const base = `origin/${repo.base_branch}`;
  const stat = await git.diffStat(base);
  if (changedInIteration || stat.files_changed > 0) {
    try {
      await git.push(repo.branch, ctx.branching.pattern, repo.default_branch);
    } catch (err) {
      if (err instanceof PushRefusedError) throw new InvocationError('push_refused', err.message);
      throw new InvocationError('push_failed', (err as Error).message);
    }
  }
  const diffText = await git.diff(base);
  const diffRef = diffText.trim()
    ? await d.api.uploadBlob('diff', diffText, 'text/x-diff').catch((err: Error) => {
        d.log.warn('diff upload failed', { error: err.message });
        return null;
      })
    : null;
  d.emit({
    type: 'implementation.pushed',
    payload: { commit: head, ...stat, changed_in_iteration: changedInIteration, diff_ref: diffRef },
  });
  if (addressed) {
    d.emit(
      event('implementation.addressed', {
        blocking_ids: addressed.addressed,
        skipped: addressed.skipped,
        summary: addressed.summary,
      }),
    );
  }

  if (!repo.test.trim()) return;
  let output: string;
  let durationMs: number | null = null;
  const recent = d.lastTestRun && d.now() - d.lastTestRun.at < RECENT_TEST_RUN_MS;
  const recorded = d.lastTestRun ? d.toolResults.get(d.lastTestRun.toolUseId) : undefined;
  if (recent && recorded !== undefined) {
    output = recorded;
  } else {
    const t0 = d.now();
    output = await runShell(
      repo.test,
      d.repoDir,
      repo.env,
      ctx.test_timeout_seconds * 1000,
      d.signal,
      true,
    ).catch((err: Error) => err.message);
    durationMs = d.now() - t0;
  }
  const logRef = await d.api.uploadBlob('tests_log', output, 'text/plain').catch(() => null);
  const parsed = parseTestOutput(output);
  d.emit({
    type: 'implementation.tests',
    payload: {
      passed: parsed?.passed ?? null,
      failed: parsed?.failed ?? null,
      skipped: parsed?.skipped ?? null,
      runner: parsed?.runner ?? null,
      duration_ms: durationMs,
      log_ref: logRef,
    },
  });
}

/** Runs `sh -c <command>` with a timeout; resolves to combined output, rejects on non-zero exit. */
export async function runShell(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
  captureOnFailure = false,
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
      cwd,
      env: { ...process.env, ...env, CI: 'true' },
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      signal,
    });
    return `${stdout}${stderr}`;
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      message: string;
    };
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    if (captureOnFailure) throw new Error(out || e.message);
    const why = e.killed ? `timed out after ${timeoutMs / 1000}s` : `exit ${String(e.code ?? '?')}`;
    throw new Error(`"${command}" ${why}: ${out.slice(-2000)}`);
  }
}

async function uploadTranscript(
  api: RunnerApi,
  file: string,
  secrets: readonly string[],
): Promise<string | null> {
  const text = await readFile(file, 'utf8').catch(() => '');
  if (!text) return null;
  return api.uploadBlob('transcript', gzipSync(redact(text, { secrets })), 'application/gzip');
}

/** Keeps the result payload small: long result text is truncated. */
function trimResult(r: ClaudeResult): ClaudeResult {
  const out = { ...r };
  if (typeof out.result === 'string' && out.result.length > RESULT_TEXT_LIMIT) {
    out.result = out.result.slice(0, RESULT_TEXT_LIMIT) + '…';
  }
  return out;
}
