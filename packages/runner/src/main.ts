import { parseRunnerEnv } from './env.js';
import { createLog } from './log.js';
import { runInvocation } from './run.js';

/**
 * `mates-run` entrypoint (§7.3). Exit codes: 0 reported, 1 failed, 143
 * cancelled (SIGTERM → SIGINT to claude, §7.3 step 9).
 */
if (process.argv.includes('--version')) {
  console.log('mates-run 0.1.0');
  process.exit(0);
}

const env = parseRunnerEnv(process.env);
const log = createLog(env.secrets, {
  invocation_id: env.invocationId,
  run_id: env.runId,
  mate: env.mate,
});
const abort = new AbortController();
process.on('SIGTERM', () => {
  log.warn('SIGTERM received; stopping claude');
  abort.abort();
});
process.on('SIGINT', () => abort.abort());

const code = await runInvocation({ env, log, signal: abort.signal });
process.exit(code);
