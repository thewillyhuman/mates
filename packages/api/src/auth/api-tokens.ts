import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { findUserById, type User } from './users.js';

/** Personal API tokens for scripts (§10.4): `mates_<random>`, stored hashed. */
export const TOKEN_PREFIX = 'mates_';

export interface ApiToken {
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createApiToken(
  db: Queryable,
  userId: string,
  name: string,
): Promise<{ token: string; record: ApiToken }> {
  const token = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
  const r = await db.query<{ id: string; created_at: Date }>(
    'INSERT INTO api_tokens (user_id, name, hash) VALUES ($1, $2, $3) RETURNING id, created_at',
    [userId, name, hash(token)],
  );
  return {
    token,
    record: { id: r.rows[0]!.id, userId, name, createdAt: r.rows[0]!.created_at, lastUsedAt: null },
  };
}

export async function listApiTokens(
  db: Queryable,
  userId?: string,
): Promise<(ApiToken & { userEmail: string })[]> {
  const r = await db.query<{
    id: string;
    user_id: string;
    name: string;
    created_at: Date;
    last_used_at: Date | null;
    email: string;
  }>(
    `SELECT a.id, a.user_id, a.name, a.created_at, a.last_used_at, u.email FROM api_tokens a JOIN users u ON u.id = a.user_id
     ${userId ? 'WHERE a.user_id = $1' : ''} ORDER BY a.created_at DESC`,
    userId ? [userId] : [],
  );
  return r.rows.map((x) => ({
    id: x.id,
    userId: x.user_id,
    name: x.name,
    createdAt: x.created_at,
    lastUsedAt: x.last_used_at,
    userEmail: x.email,
  }));
}

export async function deleteApiToken(db: Queryable, id: string, userId?: string): Promise<boolean> {
  const r = await db.query(
    `DELETE FROM api_tokens WHERE id = $1 ${userId ? 'AND user_id = $2' : ''}`,
    userId ? [id, userId] : [id],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Resolves a bearer token to its user and records the use. */
export async function findUserByApiToken(db: Queryable, token: string): Promise<User | undefined> {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const r = await db.query<{ id: string; user_id: string }>(
    'SELECT id, user_id FROM api_tokens WHERE hash = $1',
    [hash(token)],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  await db.query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [row.id]);
  return findUserById(db, row.user_id);
}
