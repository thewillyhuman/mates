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
  init: { raw?: Blob | ArrayBuffer; contentType?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.raw !== undefined)
    headers['content-type'] = init.contentType ?? 'application/octet-stream';
  else if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCsrfToken(document.cookie);
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const request: RequestInit = { method, headers, credentials: 'same-origin' };
  if (init.raw !== undefined) request.body = init.raw;
  else if (body !== undefined) request.body = JSON.stringify(body);
  const res = await fetch(path, request);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText);
  }
  return json as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body);
export const put = <T>(path: string, body?: unknown) => api<T>('PUT', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

/** Builds a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  if (entries.length === 0) return '';
  return (
    '?' +
    entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
  );
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: 'viewer' | 'operator' | 'admin';
  auth: 'local' | 'oidc';
}
