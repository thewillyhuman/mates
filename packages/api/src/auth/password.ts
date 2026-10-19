import { hash, verify } from '@node-rs/argon2';

/** Argon2id password hashing (§10.4). Parameters follow the OWASP minimum. */
export const MIN_PASSWORD_LENGTH = 10;

// Algorithm.Argon2id; the enum is ambient-const and not importable under verbatimModuleSyntax.
const ARGON2ID = 2;
const options = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return hash(password, options);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
