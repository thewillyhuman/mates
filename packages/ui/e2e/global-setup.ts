import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Starts Postgres and mates-api (fake jobs, fake Claude, memory secrets) on
 * port 18180 and writes the setup token and connection details to
 * e2e/.state.json for the tests and the teardown.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const STATE_FILE = path.join(here, '.state.json');
export const INTERNAL_KEY = 'playwright-internal-key-0123456789abcdef';
const PORT = 18180;

export default async function globalSetup(): Promise<void> {
  let databaseUrl = process.env.MATES_TEST_DATABASE_URL;
  let containerId: string | undefined;
  if (!databaseUrl) {
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    databaseUrl = container.getConnectionUri();
    containerId = container.getId();
  }
  const apiDir = path.resolve(here, '../../api');
  const child: ChildProcess = spawn('node', ['dist/main.js'], {
    cwd: apiDir,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      MATES_INTERNAL_KEY: INTERNAL_KEY,
      MATES_SECRET_STORE: 'memory',
      MATES_JOBS: 'fake',
      MATES_FAKE_CLAUDE: '1',
      MATES_PUBLIC_URL: `http://127.0.0.1:${PORT}`,
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const token = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = /"setup_token":"([^"]+)"/.exec(buf);
      if (m) resolve(m[1]!);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (c: Buffer) => process.stderr.write(c));
    child.on('exit', (code) =>
      reject(new Error(`mates-api exited with ${code}\n${buf.slice(-2000)}`)),
    );
    setTimeout(
      () => reject(new Error(`no setup token in the api log:\n${buf.slice(-2000)}`)),
      60_000,
    );
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/readyz`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await mkdir(here, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ pid: child.pid, containerId, token, port: PORT }));
  child.unref();
}
