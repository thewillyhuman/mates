import { describe, expect, it } from 'vitest';
import {
  addressedBlockSchema,
  intakeJsonSchema,
  verdictJsonSchema,
  verdictOutputSchema,
} from './schemas.js';

describe('mate output schemas', () => {
  it('exports JSON Schema documents with the required fields', () => {
    const v = verdictJsonSchema() as { required?: string[]; properties: Record<string, unknown> };
    expect(v.required).toEqual(
      expect.arrayContaining(['decision', 'blocking', 'non_blocking', 'summary']),
    );
    const i = intakeJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(i.properties)).toEqual(
      expect.arrayContaining([
        'decision',
        'repo_id',
        'base_branch',
        'plan',
        'questions',
        'reasoning_summary',
      ]),
    );
  });

  it('fills review item defaults', () => {
    const v = verdictOutputSchema.parse({
      decision: 'approve',
      blocking: [],
      non_blocking: [{ id: 'N1', title: 'nit' }],
      verified: { tests_run: true, acceptance_criteria: [] },
      summary: 'ok',
    });
    expect(v.non_blocking[0]).toEqual({
      id: 'N1',
      title: 'nit',
      detail: '',
      file: null,
      line: null,
    });
  });

  it('tolerates a partial addressed block', () => {
    expect(addressedBlockSchema.parse({ addressed: ['B1'] })).toEqual({
      addressed: ['B1'],
      skipped: [],
      summary: '',
    });
  });
});
