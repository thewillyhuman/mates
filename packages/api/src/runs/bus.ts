import { EventEmitter } from 'node:events';
import type { RunEvent } from '@mates/core';

/**
 * In-process fan-out of committed events (decision 0007). Publishers call
 * `publish` after the transaction commits; SSE handlers subscribe per run
 * or to everything.
 */
export type EventListener = (events: RunEvent[]) => void;

export class EventBus {
  private readonly emitter = new EventEmitter({ captureRejections: false });

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(runId: string, events: RunEvent[]): void {
    if (events.length === 0) return;
    this.emitter.emit(`run:${runId}`, events);
    this.emitter.emit('*', events);
  }

  /** Subscribes to one run (`runId`) or to all runs (`'*'`). Returns the unsubscribe function. */
  subscribe(runId: string, listener: EventListener): () => void {
    const channel = runId === '*' ? '*' : `run:${runId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}
