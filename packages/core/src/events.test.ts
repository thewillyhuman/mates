import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, EventValidationError, RUNNER_EVENT_TYPES, parseEvent } from './events.js';

describe('parseEvent', () => {
  it('accepts a valid runner event and applies defaults', () => {
    const e = parseEvent({ type: 'invocation.started', payload: {} });
    expect(e).toEqual({ type: 'invocation.started', payload: { pod_name: '' } });
  });

  it('keeps a client-provided timestamp', () => {
    const e = parseEvent({
      type: 'invocation.heartbeat',
      payload: {},
      ts: '2026-10-19T10:00:00.000Z',
    });
    expect(e.ts).toBe('2026-10-19T10:00:00.000Z');
  });

  it('rejects unknown types', () => {
    expect(() => parseEvent({ type: 'run.exploded', payload: {} })).toThrow(EventValidationError);
  });

  it('rejects a payload that does not match the schema, naming the field', () => {
    expect(() =>
      parseEvent({ type: 'implementation.pushed', payload: { commit: 'abc', files_changed: -1 } }),
    ).toThrow(/files_changed/);
  });

  it('rejects a malformed envelope', () => {
    expect(() => parseEvent('nope')).toThrow(EventValidationError);
  });

  it('covers every type of §4.3 and keeps runner types a strict subset', () => {
    for (const t of [
      'run.created',
      'run.stage_changed',
      'intake.needs_clarification',
      'invocation.scheduled',
      'implementation.pushed',
      'review.verdict',
      'mr.opened',
      'tracker.commented',
      'nudge.consumed',
      'usage.recorded',
    ]) {
      expect(EVENT_TYPES).toContain(t);
    }
    for (const t of RUNNER_EVENT_TYPES) expect(EVENT_TYPES).toContain(t);
    expect(RUNNER_EVENT_TYPES.has('run.stage_changed')).toBe(false);
  });
});
