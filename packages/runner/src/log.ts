import { redact } from '@mates/core';

/** Minimal structured logger to stderr; every line is redacted (§10.3). */
export interface Log {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLog(secrets: readonly string[], base: Record<string, unknown>): Log {
  const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ level, time: new Date().toISOString(), ...base, ...fields, msg });
    process.stderr.write(redact(line, { secrets }) + '\n');
  };
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}
