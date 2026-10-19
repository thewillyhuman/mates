/**
 * Minimal API client. Same origin, cookie session, CSRF header on mutations
 * (§10.4). Every error becomes an `ApiError` with the server's code.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Reads the CSRF token the API set as a JS-readable cookie. */
export function readCsrfToken(cookieHeader: string): string | undefined {
  return cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('mates_csrf='))
    ?.slice('mates_csrf='.length);
}

export async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCsrfToken(document.cookie);
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(path, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText);
  }
  return json as T;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: 'viewer' | 'operator' | 'admin';
  auth: 'local' | 'oidc';
}
