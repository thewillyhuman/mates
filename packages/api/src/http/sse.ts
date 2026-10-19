import type { RunEvent } from '@mates/core';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Server-sent events over a hijacked Fastify reply. Writes `id`, `event`
 * and `data` lines; pings every 15 s so proxies keep the connection; stops
 * when the client goes away.
 */
export interface SseStream {
  send(event: string, data: unknown, id?: number | string): void;
  comment(text: string): void;
  close(): void;
  readonly closed: boolean;
}

export function openSse(req: FastifyRequest, reply: FastifyReply, onClose: () => void): SseStream {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  let closed = false;
  const ping = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15_000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    onClose();
    res.end();
  };
  req.raw.on('close', close);
  return {
    send(event, data, id) {
      if (closed) return;
      const head = id === undefined ? '' : `id: ${id}\n`;
      res.write(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (!closed) res.write(`: ${text}\n\n`);
    },
    close,
    get closed() {
      return closed;
    },
  };
}

export function sendRunEvents(stream: SseStream, events: readonly RunEvent[]): void {
  for (const e of events) stream.send(e.type, e, e.id);
}
