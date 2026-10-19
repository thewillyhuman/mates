import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactValue } from './redact.js';

const cases: Array<[string, string, string]> = [
  ['github token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok', `token ${REDACTED} ok`],
  ['github fine-grained', 'github_pat_11ABCDEFG0123456789abcdefghijklmnop', REDACTED],
  ['gitlab token', 'glpat-AbCdEfGhIjKlMnOpQrStUv', REDACTED],
  [
    'anthropic key',
    'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    `ANTHROPIC_API_KEY=${REDACTED}`,
  ],
  ['aws key id', 'AKIAIOSFODNN7EXAMPLE', REDACTED],
  [
    'bearer header',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc',
    `Authorization: Bearer ${REDACTED}`,
  ],
  [
    'url credentials',
    'git clone https://oauth2:glpat-xxxxxxxxxxxxxxxxxxxx@gitlab.com/a/b.git',
    `git clone https://oauth2:${REDACTED}@gitlab.com/a/b.git`,
  ],
  [
    'pem block',
    'key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAKC\n-----END RSA PRIVATE KEY-----\nend',
    `key:\n${REDACTED}\nend`,
  ],
];

describe('redact', () => {
  it.each(cases)('masks %s', (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('masks configured secret values, longest first, and ignores short ones', () => {
    const out = redact('pw=supersecret123 and sub=secret123 and x=abc', {
      secrets: ['secret123', 'supersecret123', 'abc'],
    });
    expect(out).toBe(`pw=${REDACTED} and sub=${REDACTED} and x=abc`);
  });

  it('applies extra patterns', () => {
    expect(redact('card 4111-1111-1111-1111', { patterns: [/\d{4}(-\d{4}){3}/g] })).toBe(
      `card ${REDACTED}`,
    );
  });

  it('leaves ordinary text alone', () => {
    const text = 'Iteration 2 · run pnpm test · 145 passed';
    expect(redact(text)).toBe(text);
  });

  it('walks nested values without mutating the input', () => {
    const input = { a: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'], b: { c: 'fine', n: 1 } };
    const out = redactValue(input);
    expect(out).toEqual({ a: [REDACTED], b: { c: 'fine', n: 1 } });
    expect(input.a[0]).toContain('ghp_');
  });
});
