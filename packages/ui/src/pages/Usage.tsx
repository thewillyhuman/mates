import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { get, qs } from '../api/client.js';
import type { Outcomes, UsageBucket } from '../api/types.js';
import { Histogram, Legend, PALETTE, StackedBars, type Series } from '../components/charts.js';
import { ErrorBox } from '../components/ui.js';
import { formatDuration, formatTokens, formatUsd } from '../lib/format.js';

/** Usage page (§13.4): four charts and three tables over a date range. */
type Grouped = Record<string, UsageBucket[]>;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function UsagePage() {
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(isoDate(new Date()));
  const [data, setData] = useState<Grouped>({});
  const [outcomes, setOutcomes] = useState<Outcomes | null>(null);
  const [error, setError] = useState<unknown>(null);
  const range = qs({ from, to: `${to}T23:59:59Z` });

  useEffect(() => {
    void (async () => {
      try {
        const groups = ['day', 'mate', 'model', 'ticket', 'repo', 'project'] as const;
        const results = await Promise.all(
          groups.map((g) => get<{ buckets: UsageBucket[] }>(`/api/stats${range}&group_by=${g}`)),
        );
        setData(Object.fromEntries(groups.map((g, i) => [g, results[i]!.buckets])));
        setOutcomes(await get<Outcomes>(`/api/stats/outcomes${range}`));
        setError(null);
      } catch (err) {
        setError(err);
      }
    })();
  }, [range]);

  // Per-day series need day × mate and day × model; the API gives one dimension at a time,
  // so the stacked charts use the day totals split by the overall mate/model shares.
  const days = useMemo(() => data.day ?? [], [data.day]);
  const mates = useMemo(() => data.mate ?? [], [data.mate]);
  const models = useMemo(() => data.model ?? [], [data.model]);
  const costByMate: Series[] = useMemo(
    () => share(days, mates, (b) => b.cost_usd, PALETTE.blues),
    [days, mates],
  );
  const tokensByModel: Series[] = useMemo(
    () =>
      share(
        days,
        models,
        (b) => b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_write_tokens,
        PALETTE.greens,
      ),
    [days, models],
  );
  const labels = days.map((d) => d.key);

  return (
    <>
      <div className="page-title">
        <h1>Usage</h1>
        <span
          className="muted small"
          title="Figures are Claude Code's client-side estimates; the invoice can differ."
        >
          estimates, not the bill
        </span>
      </div>
      <div className="card row" style={{ marginBottom: 16 }}>
        <label className="row small">
          From{' '}
          <input
            className="input"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="row small">
          To{' '}
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {outcomes && (
          <span className="muted small">
            {outcomes.runs_done} done · {outcomes.runs_blocked} blocked · {outcomes.runs_failed}{' '}
            failed · cost per ready MR {formatUsd(outcomes.cost_per_done_mr)} · p50{' '}
            {formatDuration(outcomes.duration_p50_ms)} · p90{' '}
            {formatDuration(outcomes.duration_p90_ms)}
          </span>
        )}
      </div>
      <ErrorBox error={error} />
      <div className="stats-strip" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="card chart-card">
          <h3>Cost per day, by mate</h3>
          <Legend series={costByMate} />
          <StackedBars labels={labels} series={costByMate} format={(v) => formatUsd(v, 0)} />
        </div>
        <div className="card chart-card">
          <h3>Tokens per day, by model</h3>
          <Legend series={tokensByModel} />
          <StackedBars labels={labels} series={tokensByModel} format={(v) => formatTokens(v)} />
        </div>
        <div className="card chart-card">
          <h3>Iterations to approval</h3>
          <Histogram
            buckets={(outcomes?.iterations_to_approval ?? []).map((b) => ({
              label: `${b.iterations}`,
              count: b.count,
            }))}
            color={PALETTE.blues[0]!}
          />
        </div>
        <div className="card chart-card">
          <h3>Cost per day (all mates) vs ready MRs</h3>
          <StackedBars
            labels={labels}
            series={[
              { name: 'cost', color: PALETTE.greens[0]!, values: days.map((d) => d.cost_usd) },
            ]}
            format={(v) => formatUsd(v, 0)}
          />
        </div>
      </div>
      <div className="stats-strip" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        <BucketTable
          title="Top tickets by cost"
          rows={(data.ticket ?? [])
            .slice()
            .sort((a, b) => b.cost_usd - a.cost_usd)
            .slice(0, 10)}
          link={(k) => `/tickets?q=${encodeURIComponent(k)}`}
        />
        <BucketTable
          title="Cost by repo"
          rows={(data.repo ?? []).slice().sort((a, b) => b.cost_usd - a.cost_usd)}
        />
        <BucketTable
          title="Cost by Jira project"
          rows={(data.project ?? []).slice().sort((a, b) => b.cost_usd - a.cost_usd)}
        />
      </div>
    </>
  );
}

function share(
  days: UsageBucket[],
  parts: UsageBucket[],
  pick: (b: UsageBucket) => number,
  colors: string[],
): Series[] {
  const total = parts.reduce((a, p) => a + pick(p), 0) || 1;
  return parts.map((p, i) => ({
    name: p.key,
    color: colors[i % colors.length]!,
    values: days.map((d) => (pick(d) * pick(p)) / total),
  }));
}

function BucketTable({
  title,
  rows,
  link,
}: {
  title: string;
  rows: UsageBucket[];
  link?: (key: string) => string;
}) {
  return (
    <div className="card">
      <div className="section-title">{title.toUpperCase()}</div>
      <table className="data">
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{link ? <Link to={link(r.key)}>{r.key}</Link> : r.key}</td>
              <td className="muted">
                {formatTokens(
                  r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens,
                )}
              </td>
              <td
                style={{ textAlign: 'right' }}
                title={
                  r.cost_usd_computed !== null &&
                  Math.abs(r.cost_usd_computed - r.cost_usd) /
                    Math.max(r.cost_usd, r.cost_usd_computed, 0.0001) >
                    0.1
                    ? `computed ${formatUsd(r.cost_usd_computed)} differs by more than 10 %`
                    : undefined
                }
              >
                {formatUsd(r.cost_usd)}
                {r.cost_usd_computed !== null &&
                Math.abs(r.cost_usd_computed - r.cost_usd) /
                  Math.max(r.cost_usd, r.cost_usd_computed, 0.0001) >
                  0.1
                  ? ' ⚠'
                  : ''}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="muted">No data in range.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
