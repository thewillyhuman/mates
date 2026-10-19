import { useEffect, useRef, useState } from 'react';

/**
 * Server-sent events with reconnect and a cursor (§13.7). The browser's
 * EventSource reconnects on network errors but gives up on HTTP errors;
 * this hook recreates it with exponential backoff and the last event id so
 * nothing is missed after a restart.
 */
export interface SseMessage {
  event: string;
  id: string | null;
  data: unknown;
}

export type SseStatus = 'connecting' | 'open' | 'reconnecting';

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30_000;

export function useSse(
  url: string | null,
  onMessage: (m: SseMessage) => void,
  events: readonly string[],
  initialAfter?: number | string | null,
): SseStatus {
  const [status, setStatus] = useState<SseStatus>('connecting');
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const lastId = useRef<string | null>(
    initialAfter === undefined || initialAfter === null ? null : String(initialAfter),
  );

  useEffect(() => {
    if (!url) return;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = MIN_BACKOFF;
    let closed = false;

    const connect = () => {
      const sep = url.includes('?') ? '&' : '?';
      const full = lastId.current ? `${url}${sep}after=${encodeURIComponent(lastId.current)}` : url;
      source = new EventSource(full, { withCredentials: true });
      setStatus('connecting');
      source.onopen = () => {
        backoff = MIN_BACKOFF;
        setStatus('open');
      };
      for (const name of events) {
        source.addEventListener(name, (e: MessageEvent<string>) => {
          if (e.lastEventId) lastId.current = e.lastEventId;
          let data: unknown = e.data;
          try {
            data = JSON.parse(e.data);
          } catch {
            // keep the raw string
          }
          handler.current({ event: name, id: e.lastEventId || null, data });
        });
      }
      source.onerror = () => {
        source?.close();
        if (closed) return;
        setStatus('reconnecting');
        timer = setTimeout(connect, backoff);
        backoff = Math.min(MAX_BACKOFF, backoff * 2);
      };
    };
    connect();
    return () => {
      closed = true;
      source?.close();
      if (timer) clearTimeout(timer);
    };
    // `events` is a stable list per call site; `url` is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return status;
}
