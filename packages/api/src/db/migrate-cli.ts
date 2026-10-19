import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

/**
 * `mates-api migrate`: applies pending migrations and exits. Used by the
 * chart's pre-install/pre-upgrade Job (§11) and by `pnpm migrate` locally.
 */
const config = loadConfig(process.env);
const log = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl);
try {
  const applied = await migrate(pool);
  log.info({ applied }, applied.length ? 'migrations applied' : 'schema up to date');
} finally {
  await pool.end();
}
