import type { Stage } from '@mates/core';

/** Presentation helpers shared by the pages; no business rules here. */

export function formatUsd(usd: number | null | undefined, digits = 2): string {
  if (usd === null || usd === undefined) return '—';
  return `$${usd.toFixed(digits)}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** "38 min ago", "1 h ago", "3 d ago". */
export function formatAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = now - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return `${Math.round(diff / 86_400_000)} d ago`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export const STAGE_LABELS: Record<Stage, string> = {
  queued: 'Queued',
  intake: 'Intake',
  implementing: 'Implementing',
  reviewing: 'In review',
  mr_ready: 'MR open',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
  failed: 'Failed',
  done: 'Done',
};

/** Colour family per meaning (§13): blue running, green ready, amber human, gray otherwise. */
export function stageTone(stage: Stage): 'blue' | 'green' | 'amber' | 'red' | 'gray' {
  switch (stage) {
    case 'intake':
    case 'implementing':
    case 'reviewing':
      return 'blue';
    case 'mr_ready':
    case 'done':
      return 'green';
    case 'blocked':
      return 'amber';
    case 'failed':
      return 'red';
    default:
      return 'gray';
  }
}

export function shortModel(model: string): string {
  const m = /claude-([a-z]+)/i.exec(model);
  return m ? m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1) : model;
}

export function mrRef(id: string, url: string): string {
  return url.includes('/pull/') || url.includes('/pulls/') ? `#${id}` : `!${id}`;
}
