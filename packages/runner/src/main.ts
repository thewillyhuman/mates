import { parseRunnerEnv } from './env.js';

/**
 * `mates-run` entrypoint. M0 ships the image and the environment contract;
 * the invocation lifecycle (§7.3) lands in M2.
 */
function main(): number {
  if (process.argv.includes('--version')) {
    console.log('mates-run 0.1.0');
    return 0;
  }
  const env = parseRunnerEnv(process.env);
  console.error(
    `mates-run: invocation ${env.invocationId} (${env.mate}, iteration ${env.iteration}): ` +
      'invocation lifecycle not implemented yet (milestone M2)',
  );
  return 2;
}

process.exit(main());
