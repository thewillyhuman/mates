import { describe, expect, it } from 'vitest';
import { readCsrfToken } from './client.js';

describe('readCsrfToken', () => {
  it('finds the token among other cookies', () => {
    expect(readCsrfToken('a=1; mates_csrf=abc-123; b=2')).toBe('abc-123');
  });

  it('returns undefined when the cookie is absent', () => {
    expect(readCsrfToken('a=1; b=2')).toBeUndefined();
    expect(readCsrfToken('')).toBeUndefined();
  });

  it('does not match a cookie that merely contains the name', () => {
    expect(readCsrfToken('x_mates_csrf=nope')).toBeUndefined();
  });
});
