import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { buildApp } from './http/app.js';
import { KubernetesHealth } from './kubernetes/health.js';
import { FakeJobsClient, KubernetesJobsClient, type JobsClient } from './kubernetes/jobs.js';
import { createLogger } from './logger.js';
import { JobMonitor } from './orchestrator/monitor.js';
import { Orchestrator } from './orchestrator/reconciler.js';
import { InvocationSpawner } from './orchestrator/spawner.js';
import { EventBus } from './runs/bus.js';
import { KubernetesSecretStore, loadKubeConfig } from './secrets/kubernetes.js';
import { InMemorySecretStore, type SecretStore } from './secrets/store.js';
import { CredentialStore } from './settings/credentials.js';
import { readHelmConfig, runDefaults } from './settings/helm.js';
import { SettingsService } from './settings/service.js';
import { Bootstrap } from './setup/bootstrap.js';
import { TeamContextService } from './team-context/service.js';

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
let jobs: JobsClient;
const kc =
  config.secretStore === 'kubernetes' || config.jobs === 'kubernetes'
    ? loadKubeConfig()
    : undefined;
if (config.secretStore === 'kubernetes') {
  secrets = new KubernetesSecretStore(config.namespace, kc!);
  kubernetes = new KubernetesHealth(kc!);
} else {
  secrets = new InMemorySecretStore();
  log.warn('MATES_SECRET_STORE=memory: credentials are not persisted across restarts');
}
if (config.jobs === 'kubernetes') {
  jobs = new KubernetesJobsClient(kc!, config.namespace);
} else {
  jobs = new FakeJobsClient();
  log.warn('MATES_JOBS=fake: invocations are recorded but no runner pods are created');
}
if (config.fakeClaude)
  log.warn('MATES_FAKE_CLAUDE=1: runner pods replay fixtures instead of calling Claude');

const bootstrap = new Bootstrap({ db: pool, secrets, release: config.release, log });
await bootstrap.ensureToken();
const helm = await readHelmConfig(config.configFile);
const bus = new EventBus();
const settings = new SettingsService(pool, helm);
const credentials = new CredentialStore(
  secrets,
  pool,
  config.release,
  helm.credentialsReadOnly ?? false,
);
const teamContext = new TeamContextService(pool, async () =>
  (await settings.get()).scm.providers.map((p) => p.id),
);
const spawner = new InvocationSpawner({
  db: pool,
  bus,
  jobs,
  log,
  internalKey: config.internalKey,
  release: config.release,
  namespace: config.namespace,
  apiInternalUrl: config.internalUrl,
  fakeClaude: config.fakeClaude,
  helm,
  defaultRunnerImage: config.runnerImage,
});
const orchestrator = new Orchestrator({ db: pool, bus, log, settings, teamContext, spawner });
const monitor = new JobMonitor({ db: pool, bus, jobs, log });

const app = await buildApp({
  db: pool,
  log,
  bootstrap,
  bus,
  internalKey: config.internalKey,
  runDefaults: runDefaults(helm),
  settings,
  credentials,
  teamContext,
  orchestrator,
  fakeClaude: config.fakeClaude,
  kubernetes,
  secureCookies: config.publicUrl.startsWith('https://'),
  uiDir: config.uiDir ?? defaultUiDir(),
  version,
});

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  orchestrator.stop();
  monitor.stop();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
orchestrator.start();
monitor.start();
log.info({ port: config.port, version }, 'mates-api listening');

function defaultUiDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
}

async function readVersion(): Promise<string> {
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
  const json = JSON.parse(await readFile(pkg, 'utf8')) as { version: string };
  return json.version;
}
