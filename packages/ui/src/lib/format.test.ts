import { describe, expect, it } from 'vitest';
import { formatAgo, formatDuration, formatTokens, formatUsd, mrRef, shortModel } from './format.js';

describe('format helpers', () => {
  it('formats money, tokens and durations as the mockup shows', () => {
    expect(formatUsd(2.7263)).toBe('$2.73');
    expect(formatUsd(null)).toBe('—');
    expect(formatTokens(2_400_000)).toBe('2.4M');
    expect(formatTokens(318_000)).toBe('318k');
    expect(formatTokens(42)).toBe('42');
    expect(formatDuration(44 * 60_000)).toBe('44 min');
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(3_900_000)).toBe('1 h 5 min');
  });

  it('formats relative times', () => {
    const now = Date.UTC(2026, 9, 19, 15, 0, 0);
    expect(formatAgo(new Date(now - 38 * 60_000).toISOString(), now)).toBe('38 min ago');
    expect(formatAgo(new Date(now - 3_600_000).toISOString(), now)).toBe('1 h ago');
    expect(formatAgo(null)).toBe('—');
  });

  it('shortens model ids and picks the MR reference style', () => {
    expect(shortModel('claude-opus-5-5')).toBe('Opus');
    expect(shortModel('custom')).toBe('custom');
    expect(mrRef('1429', 'https://gitlab/x/-/merge_requests/1429')).toBe('!1429');
    expect(mrRef('77', 'https://github.com/o/r/pull/77')).toBe('#77');
  });
});
