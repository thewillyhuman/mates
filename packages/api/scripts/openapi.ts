import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/http/app.js';
import { Integrations } from '../src/integrations.js';
import { FakeJobsClient } from '../src/kubernetes/jobs.js';
import { createLogger } from '../src/logger.js';
import { AnthropicTest } from '../src/orchestrator/anthropic-test.js';
import { MergeRequests } from '../src/orchestrator/merge-requests.js';
import { Orchestrator } from '../src/orchestrator/reconciler.js';
import { InvocationSpawner } from '../src/orchestrator/spawner.js';
import { TrackerSync } from '../src/orchestrator/tracker-sync.js';
import { createPool } from '../src/db/pool.js';
import { EventBus } from '../src/runs/bus.js';
import { RunStarter } from '../src/runs/starter.js';
import { InMemorySecretStore } from '../src/secrets/store.js';
import { CredentialStore } from '../src/settings/credentials.js';
import { SettingsService } from '../src/settings/service.js';
import { Bootstrap } from '../src/setup/bootstrap.js';
import { StatsService } from '../src/stats/service.js';
import { TeamContextFetcher } from '../src/team-context/fetcher.js';
import { TeamContextService } from '../src/team-context/service.js';

/**
 * Writes the OpenAPI 3.1 document (§12) to a file so the UI client can be
 * generated without a running server. The pool never connects: route
 * registration does not touch the database.
 *
 *   pnpm --filter mates-api openapi [out-file]
 */
const out =
  process.argv[2] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui/src/api/openapi.json');
const db = createPool('postgres://unused:unused@localhost:1/unused');
const log = createLogger('silent');
const bus = new EventBus();
const secrets = new InMemorySecretStore();
const settings = new SettingsService(db);
const credentials = new CredentialStore(secrets, db, 'mates', false);
const teamContext = new TeamContextService(db, async () => []);
const integrations = new Integrations(settings, credentials, 'http://localhost');
const spawner = new InvocationSpawner({
  db,
  bus,
  jobs: new FakeJobsClient(),
  log,
  internalKey: 'k'.repeat(32),
  release: 'mates',
  namespace: 'mates',
  apiInternalUrl: 'http://localhost',
  fakeClaude: true,
  helm: {},
  defaultRunnerImage: 'img',
});
const mergeRequests = new MergeRequests({
  integrations,
  log,
  publicUrl: 'http://localhost',
  version: 'dev',
});
const trackerSync = new TrackerSync({ integrations, log, publicUrl: 'http://localhost' });
const app = await buildApp({
  db,
  log,
  bootstrap: new Bootstrap({ db, secrets, release: 'mates', log }),
  bus,
  internalKey: 'k'.repeat(32),
  settings,
  integrations,
  starter: new RunStarter({ db, bus, settings, integrations, log }),
  credentials,
  teamContext,
  teamContextFetcher: new TeamContextFetcher({ settings, integrations, teamContext, log }),
  orchestrator: new Orchestrator({
    db,
    bus,
    log,
    settings,
    teamContext,
    spawner,
    mergeRequests,
    trackerSync,
  }),
  trackerSync,
  stats: new StatsService(db),
  anthropicTest: new AnthropicTest({
    jobs: new FakeJobsClient(),
    log,
    namespace: 'mates',
    release: 'mates',
    image: 'img',
    serviceAccount: 'sa',
    fakeClaude: true,
  }),
  fakeClaude: true,
  secureCookies: false,
  version: 'dev',
});
await app.ready();
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
await db.end();
console.log(`wrote ${out}`);
