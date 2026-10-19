import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { buildApp } from './http/app.js';
import { KubernetesHealth } from './kubernetes/health.js';
import { createLogger } from './logger.js';
import { EventBus } from './runs/bus.js';
import { KubernetesSecretStore, loadKubeConfig } from './secrets/kubernetes.js';
import { readHelmConfig, runDefaults } from './settings/helm.js';
import { InMemorySecretStore, type SecretStore } from './secrets/store.js';
import { Bootstrap } from './setup/bootstrap.js';

/** Process entrypoint: config → DB → migrations → HTTP. Fails loudly. */
const config = loadConfig(process.env);
const log = createLogger(config.logLevel, process.stdout.isTTY);
const version = await readVersion();

const pool = createPool(config.databaseUrl, (err) =>
  log.error({ err }, 'idle database client error'),
);
const applied = await migrate(pool);
if (applied.length) log.info({ applied }, 'migrations applied');

let secrets: SecretStore;
let kubernetes: KubernetesHealth | undefined;
if (config.secretStore === 'kubernetes') {
  const kc = loadKubeConfig();
  secrets = new KubernetesSecretStore(config.namespace, kc);
  kubernetes = new KubernetesHealth(kc);
} else {
  secrets = new InMemorySecretStore();
  log.warn('MATES_SECRET_STORE=memory: credentials are not persisted across restarts');
}

const bootstrap = new Bootstrap({ db: pool, secrets, release: config.release, log });
await bootstrap.ensureToken();
const helm = await readHelmConfig(config.configFile);
const bus = new EventBus();

const app = await buildApp({
  db: pool,
  log,
  bootstrap,
  bus,
  internalKey: config.internalKey,
  runDefaults: runDefaults(helm),
  kubernetes,
  secureCookies: config.publicUrl.startsWith('https://'),
  uiDir: config.uiDir ?? defaultUiDir(),
  version,
});

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
log.info({ port: config.port, version }, 'mates-api listening');

function defaultUiDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
}

async function readVersion(): Promise<string> {
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
  const json = JSON.parse(await readFile(pkg, 'utf8')) as { version: string };
  return json.version;
}
