import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { Stage } from '@mates/core';
import { get, qs } from '../api/client.js';
import type { TicketRow } from '../api/types.js';
import { Chip, Empty, ErrorBox } from '../components/ui.js';
import { formatAgo, formatUsd, STAGE_LABELS, stageTone } from '../lib/format.js';

/** Tickets table (§13.3) with filters and CSV export. */
const STAGES = Object.keys(STAGE_LABELS) as Stage[];

export function TicketsPage() {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const filters = {
    project: params.get('project') ?? '',
    repo: params.get('repo') ?? '',
    stage: params.get('stage') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    q: params.get('q') ?? '',
  };
  const query = qs(filters);

  useEffect(() => {
    get<{ tickets: TicketRow[] }>(`/api/tickets${query}`)
      .then((r) => setRows(r.tickets))
      .catch(setError);
  }, [query]);

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };

  return (
    <>
      <div className="page-title">
        <h1>Tickets</h1>
        <span className="muted">{rows.length} shown</span>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row">
          <input
            className="input"
            style={{ width: 240 }}
            placeholder="Search key or title"
            value={filters.q}
            onChange={(e) => set('q', e.target.value)}
            aria-label="Search"
          />
          <input
            className="input"
            style={{ width: 120 }}
            placeholder="Project"
            value={filters.project}
            onChange={(e) => set('project', e.target.value)}
            aria-label="Project"
          />
          <input
            className="input"
            style={{ width: 160 }}
            placeholder="Repo"
            value={filters.repo}
            onChange={(e) => set('repo', e.target.value)}
            aria-label="Repo"
          />
          <select
            className="input"
            style={{ width: 150 }}
            value={filters.stage}
            onChange={(e) => set('stage', e.target.value)}
            aria-label="Stage"
          >
            <option value="">Any stage</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
          <input
            className="input"
            style={{ width: 150 }}
            type="date"
            value={filters.from}
            onChange={(e) => set('from', e.target.value)}
            aria-label="From"
          />
          <input
            className="input"
            style={{ width: 150 }}
            type="date"
            value={filters.to}
            onChange={(e) => set('to', e.target.value)}
            aria-label="To"
          />
          <a className="btn" href={`/api/tickets.csv${query}`}>
            Export CSV
          </a>
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="card">
        {rows.length === 0 ? (
          <Empty>No tickets match.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Repo</th>
                <th>Latest run</th>
                <th>Iterations</th>
                <th>Cost</th>
                <th>MR</th>
                <th>Runs</th>
                <th>Seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span className="mono">{t.key}</span>{' '}
                    {t.latestRun ? <Link to={`/runs/${t.latestRun.id}`}>{t.title}</Link> : t.title}
                  </td>
                  <td className="muted">{t.repoId ?? '—'}</td>
                  <td>
                    {t.latestRun ? (
                      <Chip tone={stageTone(t.latestRun.stage as Stage)}>
                        {STAGE_LABELS[t.latestRun.stage as Stage]}
                      </Chip>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {t.latestRun ? `${t.latestRun.iteration}/${t.latestRun.maxIterations}` : '—'}
                  </td>
                  <td>{t.latestRun ? formatUsd(t.latestRun.costUsd) : '—'}</td>
                  <td>
                    {t.latestRun?.mrUrl ? (
                      <a href={t.latestRun.mrUrl} target="_blank" rel="noreferrer">
                        {t.latestRun.mrState ?? 'open'}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{t.runs}</td>
                  <td className="muted">{formatAgo(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
