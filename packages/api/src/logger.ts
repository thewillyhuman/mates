import { pino, type Logger } from 'pino';

/**
 * Structured JSON logger (§14). Every log line that concerns a run carries
 * `run_id`, `invocation_id` and `ticket_key` through child loggers; callers
 * use `log.child({ run_id })` rather than interpolating ids into messages.
 */
export type { Logger };

export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    base: { service: 'mates-api' },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty' } } : {}),
  });
}
