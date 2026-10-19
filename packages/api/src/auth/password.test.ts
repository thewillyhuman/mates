import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies the password it hashed and rejects another', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('rejects passwords shorter than the minimum', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least/);
  });
});
