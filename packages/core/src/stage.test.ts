import { describe, expect, it } from 'vitest';
import {
  STAGES,
  assertTransition,
  canTransition,
  isTerminal,
  InvalidTransitionError,
  type Stage,
} from './stage.js';

/** Every arrow in the §4.2 diagram, and nothing else. */
const legal: Array<[Stage, Stage]> = [
  ['queued', 'intake'],
  ['queued', 'implementing'],
  ['queued', 'reviewing'],
  ['queued', 'blocked'],
  ['intake', 'implementing'],
  ['intake', 'blocked'],
  ['implementing', 'reviewing'],
  ['implementing', 'blocked'],
  ['reviewing', 'implementing'],
  ['reviewing', 'mr_ready'],
  ['reviewing', 'blocked'],
  ['mr_ready', 'done'],
  ['blocked', 'queued'],
  ...(['queued', 'intake', 'implementing', 'reviewing', 'mr_ready', 'blocked'] as Stage[]).flatMap(
    (s): Array<[Stage, Stage]> => [
      [s, 'cancelled'],
      [s, 'failed'],
    ],
  ),
];

describe('run state machine', () => {
  it.each(legal)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('rejects every transition not in the diagram', () => {
    const allowed = new Set(legal.map(([f, t]) => `${f}>${t}`));
    for (const from of STAGES) {
      for (const to of STAGES) {
        if (allowed.has(`${from}>${to}`)) continue;
        expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
        expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
      }
    }
  });

  it('treats done, cancelled and failed as terminal and nothing else', () => {
    expect(STAGES.filter(isTerminal)).toEqual(['cancelled', 'failed', 'done']);
  });

  it('never leaves a terminal stage', () => {
    for (const from of STAGES.filter(isTerminal)) {
      for (const to of STAGES) expect(canTransition(from, to)).toBe(false);
    }
  });
});
