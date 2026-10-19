import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  condense,
  extractAddressedBlock,
  parseStreamLine,
  summarizeToolUse,
  type Condensed,
} from './stream.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/claude',
);

async function condensedFixture(name: string): Promise<Condensed[]> {
  const text = await readFile(path.join(FIXTURES, `${name}.jsonl`), 'utf8');
  return text
    .split('\n')
    .map(parseStreamLine)
    .filter((l): l is NonNullable<typeof l> => l !== null)
    .flatMap(condense);
}

describe('parseStreamLine', () => {
  it('ignores blank and non-JSON lines and objects without a type', () => {
    expect(parseStreamLine('')).toBeNull();
    expect(parseStreamLine('not json')).toBeNull();
    expect(parseStreamLine('{"x":1}')).toBeNull();
    expect(parseStreamLine('{"type":"system","subtype":"init"}')).toEqual({
      type: 'system',
      subtype: 'init',
    });
  });
});

describe('summarizeToolUse', () => {
  it('renders one line per tool call as the UI shows it', () => {
    expect(summarizeToolUse('Read', { file_path: '/workspace/repo/src/x.ts' })).toBe(
      'read src/x.ts',
    );
    expect(
      summarizeToolUse('Edit', {
        file_path: 'src/y.ts',
        old_string: 'a\nb\nc',
        new_string: 'a\nb\nc\nd\ne',
      }),
    ).toBe('edit src/y.ts (+5 −3)');
    expect(summarizeToolUse('Write', { file_path: 'a.py', content: '1\n2' })).toBe(
      'write a.py (2 lines)',
    );
    expect(summarizeToolUse('Bash', { command: 'pnpm   test\n--filter x' })).toBe(
      'run pnpm test --filter x',
    );
    expect(summarizeToolUse('Grep', { pattern: 'RetryPolicy', path: '/workspace/repo/src' })).toBe(
      'grep RetryPolicy in src',
    );
    expect(summarizeToolUse('WebFetch', { url: 'https://x' })).toBe('webfetch https://x');
  });
});

describe('condense', () => {
  it('turns the implementer fixture into tail lines, usage and a result', async () => {
    const c = await condensedFixture('impl_iter1_green');
    const tools = c.filter((x) => x.kind === 'tool_use').map((x) => x.summary);
    expect(tools).toEqual([
      'read /context/team/docs/conventions.md',
      'read src/webhook/retry.py',
      'edit src/webhook/retry.py (+3 −2)',
      'edit tests/test_retry.py (+4 −1)',
      'run python3 -m unittest discover -s tests -v',
    ]);
    expect(c.filter((x) => x.kind === 'tool_result')).toHaveLength(5);
    expect(c.filter((x) => x.kind === 'usage')).toHaveLength(6);
    const result = c.find((x) => x.kind === 'result');
    expect(result?.kind === 'result' && result.result.total_cost_usd).toBe(1.8734);
    expect(result?.kind === 'result' && result.result.session_id).toMatch(/^[0-9a-f-]{36}$/);
    const texts = c.filter((x) => x.kind === 'text');
    expect(texts.at(-1)?.kind === 'text' && texts.at(-1)!.text).toContain('"addressed"');
  });

  it('exposes structured output on the reviewer fixture', async () => {
    const c = await condensedFixture('review_changes_requested_2_blocking');
    const result = c.find((x) => x.kind === 'result');
    expect(result?.kind === 'result' && result.result.structured_output).toMatchObject({
      decision: 'changes_requested',
      blocking: [{ id: 'B1' }, { id: 'B2' }],
    });
  });

  it('maps api_retry lines to notes and keeps the error result', async () => {
    const retry = await condensedFixture('api_retry_then_success');
    expect(
      retry.filter((x) => x.kind === 'api_retry').map((x) => x.kind === 'api_retry' && x.note),
    ).toEqual(['API retry 1: overloaded_error', 'API retry 2: overloaded_error']);
    const budget = await condensedFixture('impl_budget_exceeded');
    const result = budget.find((x) => x.kind === 'result');
    expect(result?.kind === 'result' && result.result).toMatchObject({
      is_error: true,
      subtype: 'error_max_budget_usd',
    });
  });

  it('ignores unknown message types', () => {
    expect(condense({ type: 'system', subtype: 'ui_invalidate' })).toEqual([]);
    expect(condense({ type: 'rate_limit_event' })).toEqual([]);
  });
});

describe('extractAddressedBlock', () => {
  it('reads the fenced block at the end of the final message', () => {
    const text =
      'Done.\n\n```json\n{"addressed": ["B1","B2"], "skipped": [{"id":"N3","reason":"out of scope"}], "summary": "Cap backoff"}\n```';
    expect(extractAddressedBlock(text)).toEqual({
      addressed: ['B1', 'B2'],
      skipped: [{ id: 'N3', reason: 'out of scope' }],
      summary: 'Cap backoff',
    });
  });

  it('accepts a bare object and returns null when absent', () => {
    expect(extractAddressedBlock('Finished. {"addressed": [], "summary": "x"}')).toEqual({
      addressed: [],
      skipped: [],
      summary: 'x',
    });
    expect(extractAddressedBlock('Finished. ```json\n{"other": 1}\n```')).toBeNull();
    expect(extractAddressedBlock('nothing here')).toBeNull();
  });
});
