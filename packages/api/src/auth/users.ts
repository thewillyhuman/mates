import type { Queryable } from '../db/pool.js';

/** Roles in increasing order of privilege (§10.4). */
export const ROLES = ['viewer', 'operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly auth: 'local' | 'oidc';
  readonly createdAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  auth: 'local' | 'oidc';
  password_hash: string | null;
  created_at: Date;
}

const columns = 'id, email, display_name, role, auth, password_hash, created_at';

function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    auth: r.auth,
    createdAt: r.created_at,
  };
}

/** `true` when `actual` grants at least `required`. */
export function hasRole(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

export async function countUsers(db: Queryable): Promise<number> {
  const r = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
  return Number(r.rows[0]?.n ?? 0);
}

export async function createUser(
  db: Queryable,
  input: {
    email: string;
    displayName: string;
    role: Role;
    auth: 'local' | 'oidc';
    passwordHash?: string;
  },
): Promise<User> {
  const r = await db.query<UserRow>(
    `INSERT INTO users (email, display_name, role, auth, password_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${columns}`,
    [
      input.email.toLowerCase(),
      input.displayName,
      input.role,
      input.auth,
      input.passwordHash ?? null,
    ],
  );
  return toUser(r.rows[0]!);
}

export async function findUserByEmail(
  db: Queryable,
  email: string,
): Promise<(User & { passwordHash: string | null }) | undefined> {
  const r = await db.query<UserRow>(`SELECT ${columns} FROM users WHERE email = $1`, [
    email.toLowerCase(),
  ]);
  const row = r.rows[0];
  return row ? { ...toUser(row), passwordHash: row.password_hash } : undefined;
}

export async function findUserById(db: Queryable, id: string): Promise<User | undefined> {
  const r = await db.query<UserRow>(`SELECT ${columns} FROM users WHERE id = $1`, [id]);
  return r.rows[0] ? toUser(r.rows[0]) : undefined;
}

export async function listUsers(db: Queryable): Promise<User[]> {
  const r = await db.query<UserRow>(`SELECT ${columns} FROM users ORDER BY created_at`);
  return r.rows.map(toUser);
}

export async function updateUserRole(
  db: Queryable,
  id: string,
  role: Role,
): Promise<User | undefined> {
  const r = await db.query<UserRow>(
    `UPDATE users SET role = $2 WHERE id = $1 RETURNING ${columns}`,
    [id, role],
  );
  return r.rows[0] ? toUser(r.rows[0]) : undefined;
}

export async function deleteUser(db: Queryable, id: string): Promise<boolean> {
  const r = await db.query('DELETE FROM users WHERE id = $1', [id]);
  return (r.rowCount ?? 0) > 0;
}
