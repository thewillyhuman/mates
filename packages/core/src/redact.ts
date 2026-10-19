/**
 * Secret redaction (§10.3). One function applied to every event payload,
 * blob and log line the runner forwards and to anything the API logs.
 *
 * Masks: values of configured secrets (exact, longest first), common token
 * shapes, basic-auth credentials in URLs, PEM private keys, and any extra
 * user-configured patterns.
 */
export const REDACTED = '[redacted]';

const BUILTIN_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub classic / OAuth / app tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab PAT
  /\bglrt-[A-Za-z0-9_-]{20,}\b/g, // GitLab runner token
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic API key
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIALS = /(https?:\/\/)([^/:@\s]+):([^@\s/]+)@/gi;

export interface RedactOptions {
  /** Literal secret values; anything shorter than 6 characters is ignored. */
  readonly secrets?: readonly string[];
  /** Additional patterns (global flag recommended). */
  readonly patterns?: readonly RegExp[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redact(text: string, opts: RedactOptions = {}): string {
  let out = text;
  const secrets = [...(opts.secrets ?? [])]
    .filter((s) => s.length >= 6)
    .sort((a, b) => b.length - a.length);
  for (const s of secrets) out = out.replace(new RegExp(escapeRegExp(s), 'g'), REDACTED);
  for (const p of BUILTIN_PATTERNS) out = out.replace(p, REDACTED);
  out = out.replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(
    URL_CREDENTIALS,
    (_m, proto: string, user: string) => `${proto}${user}:${REDACTED}@`,
  );
  for (const p of opts.patterns ?? []) out = out.replace(p, REDACTED);
  return out;
}

/** Applies `redact` to every string inside a JSON-like value, returning a copy. */
export function redactValue<T>(value: T, opts: RedactOptions = {}): T {
  if (typeof value === 'string') return redact(value, opts) as T;
  if (Array.isArray(value)) return (value as unknown[]).map((v) => redactValue(v, opts)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = redactValue(v, opts);
    return out as T;
  }
  return value;
}
