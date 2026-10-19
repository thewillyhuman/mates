import { readFile, rm } from 'node:fs/promises';
import { STATE_FILE } from './global-setup.js';

export default async function globalTeardown(): Promise<void> {
  try {
    const state = JSON.parse(await readFile(STATE_FILE, 'utf8')) as {
      pid?: number;
      containerId?: string;
    };
    if (state.pid) {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    if (state.containerId) {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((r) =>
        execFile('docker', ['rm', '-f', state.containerId!], () => r()),
      );
    }
  } finally {
    await rm(STATE_FILE, { force: true });
  }
}
