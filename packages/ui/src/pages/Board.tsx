import { Link, useNavigate } from 'react-router';
import { useMemo, useState } from 'react';
import type { Stage } from '@mates/core';
import { useBoard } from '../api/board.js';
import type { RunSummary } from '../api/types.js';
import {
  Banner,
  Chip,
  Dot,
  ErrorBox,
  IterationBar,
  StatTile,
  useSlashFocus,
} from '../components/ui.js';
import {
  formatAgo,
  formatDateTime,
  formatTokens,
  formatUsd,
  mrRef,
  stageTone,
} from '../lib/format.js';

/** Board (§13.1): stats strip, "Needs a human" lane, six columns, live over SSE. */
const COLUMNS: { stage: Stage; label: string }[] = [
  { stage: 'queued', label: 'Queued' },
  { stage: 'intake', label: 'Intake' },
  { stage: 'implementing', label: 'Implementing' },
  { stage: 'reviewing', label: 'In review' },
  { stage: 'mr_ready', label: 'MR open' },
  { stage: 'blocked', label: 'Blocked' },
];

/** Column a run belongs to; done runs with an MR show under "MR open" for a day. */
function columnOf(run: RunSummary): Stage | null {
  if (run.stage === 'done') return run.mr ? 'mr_ready' : null;
  if (run.stage === 'failed' || run.stage === 'cancelled') return null;
  return run.stage;
}

export function describeHuman(run: RunSummary): string {
  switch (run.blockedReason ?? (run.stage === 'failed' ? 'failed' : '')) {
    case 'needs_clarification':
      return run.questions[0]
        ? `Clarification requested — "${run.questions[0]}"`
        : 'Clarification requested';
    case 'iteration_cap':
      return `Iteration cap reached (${run.iteration}/${run.maxIterations})${run.mr ? ` — draft MR ${mrRef(run.mr.id, run.mr.url)} opened` : ''}${run.lastVerdict ? ` with ${run.lastVerdict.blocking} unresolved review point${run.lastVerdict.blocking === 1 ? '' : 's'}` : ''}`;
    case 'budget_exceeded':
      return 'Budget exceeded — raise the budget and retry';
    case 'failed':
      return `Failed — ${run.currentAction.replace(/^Failed · /, '')}`;
    default:
      return run.currentAction;
  }
}

export function RunCard({ run }: { run: RunSummary }) {
  const tone = run.stage === 'done' ? 'green' : stageTone(run.stage);
  const filled =
    run.stage === 'done' || run.stage === 'mr_ready'
      ? run.iteration
      : Math.max(run.iteration - (run.currentMate === 'implementer' ? 1 : 0), 0);
  return (
    <Link
      to={`/runs/${run.id}`}
      className={`run-card edge-${tone}`}
      data-testid="run-card"
      data-stage={run.stage}
    >
      <div className="key">{run.ticket.key}</div>
      <div className="title">{run.ticket.title}</div>
      <div className="repo">
        {run.repo ?? '—'}
        {run.mr && (
          <>
            {' '}
            · {mrRef(run.mr.id, run.mr.url)}
            {run.mr.draft ? ' draft' : ''}
          </>
        )}
      </div>
      {run.stage !== 'queued' && run.stage !== 'intake' && (
        <IterationBar done={filled} max={run.maxIterations} tone={tone} />
      )}
      <div className={`action tone-${tone}`}>
        <Dot tone={tone} />
        {run.currentAction}
        {run.stage !== 'done' && <span className="muted"> · {formatAgo(run.stageChangedAt)}</span>}
      </div>
    </Link>
  );
}

export function BoardPage() {
  const { runs, stats, error } = useBoard();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  useSlashFocus('board-search');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? runs.filter((r) =>
          `${r.ticket.key} ${r.ticket.title} ${r.repo ?? ''}`.toLowerCase().includes(q),
        )
      : runs;
  }, [runs, query]);
  const needsHuman = visible.filter((r) => r.stage === 'blocked' || r.stage === 'failed');
  const byColumn = (stage: Stage) => visible.filter((r) => columnOf(r) === stage);
  const readyThisWeek = runs.filter(
    (r) =>
      r.stage === 'done' &&
      r.finishedAt &&
      Date.now() - new Date(r.finishedAt).getTime() < 7 * 86_400_000,
  );

  return (
    <>
      <ErrorBox error={error} />
      {stats?.daily_budget.exceeded && (
        <Banner tone="amber">
          Daily budget reached: {formatUsd(stats.daily_budget.spent)} of{' '}
          {formatUsd(stats.daily_budget.limit)} spent. New invocations wait until{' '}
          {formatDateTime(stats.daily_budget.resets_at)}.
        </Banner>
      )}
      <div className="row spread" style={{ marginBottom: 16 }}>
        <div className="muted small">
          Live board · {runs.length} run{runs.length === 1 ? '' : 's'}
        </div>
        <input
          id="board-search"
          className="search"
          placeholder="Search tickets, repos…  ( / )"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search runs"
        />
      </div>
      {stats && (
        <div className="stats-strip">
          <StatTile
            label="Running now"
            value={stats.running.total}
            detail={
              Object.entries(stats.running.by_stage)
                .map(([s, n]) => `${n} ${s}`)
                .join(' · ') || 'nothing running'
            }
          />
          <StatTile
            label="Waiting on a human"
            value={stats.waiting.total}
            tone={stats.waiting.total ? 'amber' : undefined}
            detail={
              Object.entries(stats.waiting.by_reason)
                .map(([r, n]) => `${n} ${r.replace(/_/g, ' ')}`)
                .join(' · ') || 'nobody waiting'
            }
          />
          <StatTile
            label="MRs opened today"
            value={stats.mrs_opened_today.total}
            detail={`${stats.mrs_opened_today.ready} ready · ${stats.mrs_opened_today.draft} draft`}
          />
          <StatTile
            label="Iterations to approval"
            value={stats.iterations_to_approval_7d.average ?? '—'}
            unit="avg · 7 days"
            detail={`cap is ${stats.iterations_to_approval_7d.cap}`}
          />
          <StatTile
            label="Spend today"
            value={formatTokens(stats.spend_today.tokens)}
            unit="tokens"
            detail={`${formatUsd(stats.spend_today.usd)} · ≈ ${formatTokens(stats.spend_today.per_ticket_tokens)} per ticket`}
          />
        </div>
      )}
      {needsHuman.length > 0 && (
        <section className="lane" aria-label="Needs a human">
          <div className="lane-title">⚠ NEEDS A HUMAN</div>
          {needsHuman.map((r) => (
            <div className="lane-row" key={r.id}>
              <span className="mono">{r.ticket.key}</span>
              <span className="title" style={{ fontWeight: 600 }}>
                {r.ticket.title}
              </span>
              <span className="reason">{describeHuman(r)}</span>
              <span className="muted small">{formatAgo(r.stageChangedAt)}</span>
              <span className="lane-actions">
                {r.blockedReason === 'needs_clarification' && r.ticket.url && (
                  <a className="btn btn-sm" href={r.ticket.url} target="_blank" rel="noreferrer">
                    Reply on Jira
                  </a>
                )}
                {r.blockedReason !== 'needs_clarification' && r.stage === 'blocked' && (
                  <button
                    className="btn btn-sm"
                    onClick={() => void navigate(`/runs/${r.id}#nudge`)}
                  >
                    Nudge
                  </button>
                )}
                {r.mr && (
                  <a
                    className="btn btn-sm btn-primary"
                    href={r.mr.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View MR
                  </a>
                )}
                <Link className="btn btn-sm btn-primary" to={`/runs/${r.id}`}>
                  Open
                </Link>
              </span>
            </div>
          ))}
        </section>
      )}
      <div className="board">
        {COLUMNS.map((c) => {
          const items = byColumn(c.stage);
          return (
            <section key={c.stage} aria-label={c.label}>
              <div className={`column-title${c.stage === 'blocked' ? ' tone-amber' : ''}`}>
                <span>{c.label.toUpperCase()}</span>
                <span>{items.length}</span>
              </div>
              {items.map((r) => (
                <RunCard key={r.id} run={r} />
              ))}
            </section>
          );
        })}
      </div>
      {readyThisWeek.length > 0 && (
        <section className="card footer-merged">
          <div className="section-title">READY FOR HUMAN REVIEW THIS WEEK</div>
          <div className="row">
            {readyThisWeek.slice(0, 8).map((r) => (
              <Chip key={r.id} mono>
                <Link to={`/runs/${r.id}`}>{r.ticket.key}</Link> · {r.iteration} iteration
                {r.iteration === 1 ? '' : 's'} · {formatUsd(r.costUsd)}
              </Chip>
            ))}
            <Link to="/tickets?stage=done">All history</Link>
          </div>
        </section>
      )}
    </>
  );
}
