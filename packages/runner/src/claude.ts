import type { InvocationContext } from '@mates/core';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { Log } from './log.js';
import { parseStreamLine, type StreamLine } from './stream.js';

/**
 * Runs Claude Code non-interactively (§7.3 step 4) or, in fake mode,
 * replays a recorded fixture (§15.1). Either way every stream-json line
 * goes to `onLine` and to the transcript file.
 */
export interface ClaudeRunOptions {
  ctx: InvocationContext;
  contextDir: string;
  workspace: string;
  transcriptPath: string;
  log: Log;
  onLine: (line: StreamLine) => void;
  signal: AbortSignal;
  fake?: { fixturesDir: string; applyPatch: (file: string) => Promise<void> } | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeRunResult {
  exitCode: number;
  timedOut: boolean;
}

/** Command line per §7.3; exported for tests. */
export async function buildClaudeArgs(
  ctx: InvocationContext,
  contextDir: string,
): Promise<string[]> {
  const brief = await readFile(path.join(contextDir, 'brief.md'), 'utf8');
  const args = [
    '--bare',
    '-p',
    brief,
    '--model',
    ctx.claude.model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt-file',
    path.join(contextDir, 'system.md'),
    '--allowedTools',
    ctx.claude.allowed_tools.join(','),
    '--permission-mode',
    ctx.claude.permission_mode,
    '--permission-prompts',
    'none',
    '--max-budget-usd',
    String(ctx.claude.max_budget_usd),
    '--max-turns',
    String(ctx.claude.max_turns),
  ];
  if (ctx.claude.disallowed_tools.length > 0) {
    args.push('--disallowedTools', ctx.claude.disallowed_tools.join(','));
  }
  if (ctx.claude.json_schema_file) {
    args.push(
      '--json-schema',
      await readFile(path.join(contextDir, ctx.claude.json_schema_file), 'utf8'),
    );
  }
  if (ctx.claude.effort) args.push('--effort', ctx.claude.effort);
  return args;
}

export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  if (opts.fake) return runFake(opts, opts.fake);
  const args = await buildClaudeArgs(opts.ctx, opts.contextDir);
  const transcript = createWriteStream(opts.transcriptPath);
  const child = spawn('claude', args, {
    cwd: opts.workspace,
    env: { ...process.env, ...opts.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    opts.log.warn('claude timed out; sending SIGINT', {
      timeout_seconds: opts.ctx.claude.timeout_seconds,
    });
    child.kill('SIGINT');
    setTimeout(() => child.kill('SIGKILL'), 20_000).unref();
  }, opts.ctx.claude.timeout_seconds * 1000);
  const onAbort = () => {
    // §7.3 step 9: SIGINT ends the turn cleanly; SIGTERM would not.
    child.kill('SIGINT');
    setTimeout(() => child.kill('SIGKILL'), 20_000).unref();
  };
  opts.signal.addEventListener('abort', onAbort, { once: true });

  child.stderr.on('data', (chunk: Buffer) => {
    opts.log.info('claude stderr', { text: chunk.toString().slice(0, 500) });
  });
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    transcript.write(line + '\n');
    const parsed = parseStreamLine(line);
    if (parsed) opts.onLine(parsed);
    else if (line.trim()) opts.log.info('non-json claude output', { text: line.slice(0, 200) });
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      opts.log.error('failed to start claude', { error: err.message });
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
  clearTimeout(timeout);
  opts.signal.removeEventListener('abort', onAbort);
  await new Promise<void>((r) => transcript.end(r));
  return { exitCode, timedOut };
}

/** Replays `fixtures/<scenario>.jsonl`, applying the scenario's patch before the result line. */
async function runFake(
  opts: ClaudeRunOptions,
  fake: { fixturesDir: string; applyPatch: (file: string) => Promise<void> },
): Promise<ClaudeRunResult> {
  const scenario = opts.ctx.fake?.scenario;
  if (!scenario) throw new Error('fake mode requires ctx.fake.scenario');
  const text = await readFile(path.join(fake.fixturesDir, `${scenario}.jsonl`), 'utf8');
  const transcript = createWriteStream(opts.transcriptPath);
  let exitCode = 0;
  for (const line of text.split('\n')) {
    if (opts.signal.aborted) {
      exitCode = 130;
      break;
    }
    const parsed = parseStreamLine(line);
    if (!parsed) continue;
    if (parsed.type === 'result') {
      const patch = opts.ctx.fake?.patch;
      if (patch) await fake.applyPatch(path.join(fake.fixturesDir, patch));
      if (parsed.is_error === true) exitCode = 1;
    }
    transcript.write(line + '\n');
    opts.onLine(parsed);
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise<void>((r) => transcript.end(r));
  return { exitCode, timedOut: false };
}
