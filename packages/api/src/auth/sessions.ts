import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { findUserById, type User } from './users.js';

/**
 * Browser sessions (§10.4). The cookie carries a random token; only its
 * SHA-256 lives in the database. Each session owns a CSRF token that
 * mutating requests must echo in the `x-csrf-token` header.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface NewSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

export interface Session {
  readonly user: User;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(db: Queryable, userId: string): Promise<NewSession> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    'INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4)',
    [userId, hashToken(token), csrfToken, expiresAt],
  );
  return { token, csrfToken, expiresAt };
}

export async function findSession(db: Queryable, token: string): Promise<Session | undefined> {
  const r = await db.query<{ user_id: string; csrf_token: string; expires_at: Date }>(
    'SELECT user_id, csrf_token, expires_at FROM sessions WHERE token_hash = $1 AND expires_at > now()',
    [hashToken(token)],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  const user = await findUserById(db, row.user_id);
  if (!user) return undefined;
  return { user, csrfToken: row.csrf_token, expiresAt: row.expires_at };
}

export async function deleteSession(db: Queryable, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function deleteExpiredSessions(db: Queryable): Promise<number> {
  const r = await db.query('DELETE FROM sessions WHERE expires_at <= now()');
  return r.rowCount ?? 0;
}
