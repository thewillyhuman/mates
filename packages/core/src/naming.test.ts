import { describe, expect, it } from 'vitest';
import { branchMatchesPattern, branchName, commitMessage, slugify } from './naming.js';

describe('naming', () => {
  it('slugifies titles to kebab-case, max 40 chars, on a word boundary', () => {
    expect(slugify('Retry policy for webhook delivery')).toBe('retry-policy-for-webhook-delivery');
    expect(slugify('  Añadir VAT — breakdown!! ')).toBe('anadir-vat-breakdown');
    const long = slugify('Paginate the orders response for very large customer accounts please');
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toBe('paginate-the-orders-response-for-very');
  });

  it('renders the branch pattern', () => {
    expect(
      branchName('mates/{ticket}-{slug}', 'API-198', 'Retry policy for webhook delivery'),
    ).toBe('mates/API-198-retry-policy-for-webhook-delivery');
    expect(() => branchName('mates/{ticket}', 'nope', 'x')).toThrow(/invalid ticket key/);
  });

  it('recognises branches produced by the pattern and nothing else', () => {
    const p = 'mates/{ticket}-{slug}';
    expect(branchMatchesPattern('mates/API-198-retry-policy', p)).toBe(true);
    expect(branchMatchesPattern('mates/API-198-', p)).toBe(true);
    expect(branchMatchesPattern('main', p)).toBe(false);
    expect(branchMatchesPattern('mates/api-198-x', p)).toBe(false);
    expect(branchMatchesPattern('feature/API-198-x', p)).toBe(false);
    expect(branchMatchesPattern('mates/API-198-x/../main', p)).toBe(false);
  });

  it('builds the commit message with the trailer', () => {
    expect(commitMessage('API-198', 'Cap retry attempts\nmore text', 'Jira: {ticket}')).toBe(
      'API-198: Cap retry attempts\n\nJira: API-198\n',
    );
    expect(commitMessage('API-1', 'x', '')).toBe('API-1: x\n');
  });
});
