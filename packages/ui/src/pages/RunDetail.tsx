import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import type { InvocationView, RunProjection, Stage } from '@mates/core';
import { get, post, ApiError } from '../api/client.js';
import { useAuth } from '../api/auth.js';
import { useSse } from '../api/sse.js';
import type { RunDetail, RunEvent, RunSummary, TicketDetail } from '../api/types.js';
import { Chip, Dialog, Dot, ErrorBox, Tabs } from '../components/ui.js';
import {
  formatAgo,
  formatDuration,
  formatTime,
  formatTokens,
  formatUsd,
  mrRef,
  shortModel,
  STAGE_LABELS,
  stageTone,
} from '../lib/format.js';

/** Ticket / run detail (§13.2): header, stepper, timeline, live tail, facts, nudge. */
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
const TAIL_TYPES = new Set(['invocation.tool_use', 'invocation.text', 'invocation.heartbeat']);

export function RunDetailPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const { user } = useAuth();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [older, setOlder] = useState<RunSummary[]>([]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canOperate = user?.role === 'operator' || user?.role === 'admin';

  const loadDetail = useCallback(async () => {
    try {
      const d = await get<RunDetail>(`/api/runs/${id}`);
      setDetail(d);
      setError(null);
      const t = await get<TicketDetail>(`/api/tickets/${encodeURIComponent(d.ticket.key)}`);
      setOlder(t.runs.filter((r) => r.id !== id));
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    void loadDetail();
    void (async () => {
      const all: RunEvent[] = [];
      let after = 0;
      for (;;) {
        const page = await get<{ events: RunEvent[]; next_after: number | null }>(
          `/api/runs/${id}/events?after=${after}&limit=1000`,
        );
        all.push(...page.events);
        if (page.next_after === null) break;
        after = page.next_after;
      }
      setEvents(all);
    })().catch(setError);
  }, [id, loadDetail]);

  const lastId = events.at(-1)?.id ?? 0;
  const sseStatus = useSse(
    events.length || detail ? `/api/runs/${id}/stream` : null,
    (m) => {
      const e = m.data as RunEvent;
      setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e]));
      if (!TAIL_TYPES.has(e.type) && !refreshTimer.current) {
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null;
          void loadDetail();
        }, 400);
      }
    },
    [
      'run.created',
      'run.stage_changed',
      'run.cancelled',
      'run.failed',
      'run.budget_exceeded',
      'run.paused',
      'run.resumed',
      'run.budget_changed',
      'intake.started',
      'intake.finished',
      'intake.needs_clarification',
      'intake.passed',
      'invocation.scheduled',
      'invocation.started',
      'invocation.heartbeat',
      'invocation.tool_use',
      'invocation.text',
      'invocation.finished',
      'invocation.failed',
      'implementation.pushed',
      'implementation.tests',
      'implementation.addressed',
      'review.verdict',
      'mr.opened',
      'mr.updated',
      'mr.marked_ready',
      'tracker.transitioned',
      'tracker.transition_skipped',
      'tracker.commented',
      'nudge.added',
      'nudge.consumed',
      'usage.recorded',
    ],
    lastId,
  );

  async function act(action: 'pause' | 'resume' | 'cancel' | 'retry', body?: unknown) {
    try {
      const d = await post<RunDetail>(`/api/runs/${id}/${action}`, body ?? {});
      setDetail(d);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }

  if (!detail) return error ? <ErrorBox error={error} /> : <div className="muted">Loading…</div>;
  const p = detail.projection;
  const tone = stageTone(p.stage);
  const runState = describeState(p);
  const diffBlob = latestDiff(p);

  return (
    <>
      <div className="breadcrumb">
        <Link to="/">Board</Link> / <span className="mono">{detail.ticket.key}</span>
      </div>
      <div className="row spread">
        <div className="page-title">
          <span className="mono muted" style={{ fontSize: 20 }}>
            {detail.ticket.key}
          </span>
          <h1>{detail.ticket.title}</h1>
        </div>
        {canOperate && (
          <div className="row">
            {!p.paused && !isTerminal(p.stage) && p.stage !== 'blocked' && (
              <button className="btn" onClick={() => void act('pause')}>
                ⏸ Pause
              </button>
            )}
            {p.paused && (
              <button className="btn" onClick={() => void act('resume')}>
                ▶ Resume
              </button>
            )}
            {p.stage === 'blocked' && (
              <button
                className="btn"
                onClick={() =>
                  void act(
                    'retry',
                    p.blockedReason === 'budget_exceeded' && p.budgetUsd !== null
                      ? { budget_usd: Math.ceil(p.budgetUsd * 2) }
                      : {},
                  )
                }
              >
                Retry stage
              </button>
            )}
            {diffBlob && (
              <a
                className="btn"
                href={`/api/runs/${id}/blobs/${diffBlob}`}
                download={`${detail.ticket.key}-diff.patch`}
              >
                Open workspace
              </a>
            )}
            {!isTerminal(p.stage) && (
              <button className="btn btn-danger" onClick={() => setConfirmCancel(true)}>
                Cancel run
              </button>
            )}
          </div>
        )}
      </div>
      <div className="row" style={{ margin: '8px 0 16px' }}>
        {p.intake?.repo && <Chip>≡ {p.intake.repo}</Chip>}
        {detail.branch && <Chip mono>{detail.branch}</Chip>}
        {p.mr && (
          <Chip mono>
            <a href={p.mr.url} target="_blank" rel="noreferrer">
              {mrRef(p.mr.id, p.mr.url)}
            </a>{' '}
            {p.mr.draft ? 'draft' : 'ready'}
          </Chip>
        )}
        {p.trackerStatus && <Chip>Jira {p.trackerStatus}</Chip>}
        <Chip tone={tone}>
          <Dot tone={tone} />
          {runState}
        </Chip>
        {p.paused && <Chip tone="amber">Paused</Chip>}
        {sseStatus !== 'open' && <span className="muted small">live updates: {sseStatus}</span>}
      </div>
      <ErrorBox error={error} />

      <Stepper p={p} events={events} createdBy={p.createdBy} />

      <div className="detail-layout">
        <Timeline p={p} events={events} runId={id} />
        <div>
          <LiveTail p={p} events={events} />
          <RunFacts p={p} detail={detail} />
          {canOperate && !isTerminal(p.stage) && (
            <NudgeComposer
              runId={id}
              blocked={p.stage === 'blocked'}
              onDone={loadDetail}
              focus={location.hash === '#nudge'}
            />
          )}
        </div>
      </div>

      {older.length > 0 && (
        <section className="card" style={{ marginTop: 20 }}>
          <div className="section-title">OLDER RUNS FOR {detail.ticket.key}</div>
          <table className="data">
            <tbody>
              {older.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/runs/${r.id}`}>{formatAgo(r.createdAt)}</Link>
                  </td>
                  <td>{STAGE_LABELS[r.stage as Stage]}</td>
                  <td>
                    {r.iteration} iteration{r.iteration === 1 ? '' : 's'}
                  </td>
                  <td>{formatUsd(r.costUsd)}</td>
                  <td>{r.mr ? <a href={r.mr.url}>{mrRef(r.mr.id, r.mr.url)}</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {confirmCancel && (
        <Dialog
          title="Cancel this run?"
          onClose={() => setConfirmCancel(false)}
          actions={
            <>
              <button className="btn" onClick={() => setConfirmCancel(false)}>
                Keep running
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setConfirmCancel(false);
                  void act('cancel', { reason: 'cancelled from the UI' });
                }}
              >
                Cancel run
              </button>
            </>
          }
        >
          The running pod is stopped and the run ends as cancelled. The branch and any open merge
          request stay as they are.
        </Dialog>
      )}
    </>
  );
}

function isTerminal(stage: Stage): boolean {
  return stage === 'done' || stage === 'failed' || stage === 'cancelled';
}

function describeState(p: RunProjection): string {
  if (isTerminal(p.stage) || p.stage === 'blocked') return STAGE_LABELS[p.stage];
  const inv = p.currentInvocation;
  if (inv)
    return `Running · ${inv.mate === 'reviewer' ? 'review' : inv.mate === 'implementer' ? 'iteration' : 'intake'}${inv.iteration ? ` ${inv.iteration} of ${p.maxIterations}` : ''}`;
  return STAGE_LABELS[p.stage];
}

function latestDiff(p: RunProjection): string | null {
  for (const it of [...p.iterations].reverse()) if (it.pushed?.diff_ref) return it.pushed.diff_ref;
  return null;
}

// ---------------------------------------------------------------- stepper

const STEPS: { key: string; label: (p: RunProjection) => string; stages: Stage[] }[] = [
  { key: 'queued', label: () => 'Queued', stages: ['queued'] },
  { key: 'intake', label: () => 'Intake', stages: ['intake'] },
  { key: 'implementing', label: () => 'Implementing', stages: ['implementing'] },
  {
    key: 'reviewing',
    label: (p) => `In review · ${p.iteration}/${p.maxIterations}`,
    stages: ['reviewing'],
  },
  { key: 'mr_ready', label: () => 'MR ready', stages: ['mr_ready'] },
  { key: 'done', label: () => 'Human review', stages: ['done'] },
];

function Stepper({
  p,
  events,
  createdBy,
}: {
  p: RunProjection;
  events: RunEvent[];
  createdBy: string;
}) {
  const firstAt = (stages: Stage[]) => {
    if (stages.includes('queued')) return p.createdAt;
    const e = events.find(
      (x) => x.type === 'run.stage_changed' && stages.includes((x.payload as { to: Stage }).to),
    );
    return e?.ts ?? null;
  };
  const order = ['queued', 'intake', 'implementing', 'reviewing', 'mr_ready', 'done'];
  const reached = (key: string) => {
    if (key === 'queued') return true;
    return events.some(
      (x) => x.type === 'run.stage_changed' && (x.payload as { to: string }).to === key,
    );
  };
  const currentKey =
    p.stage === 'blocked' || p.stage === 'failed' || p.stage === 'cancelled' ? null : p.stage;
  const currentIdx = currentKey ? order.indexOf(currentKey) : -1;
  const notes: Record<string, string> = {
    queued: `by ${createdBy}`,
    intake: p.intake
      ? `scope OK · ${p.intake.repo}`
      : p.questions.length
        ? 'needs clarification'
        : '',
    implementing: p.iterations.length
      ? `iteration ${p.iteration}${p.iterations.at(-1)?.pushed ? ' done' : ' running'}`
      : '',
    reviewing:
      p.currentInvocation?.mate === 'reviewer'
        ? `now · ${p.currentInvocation.lastLine ?? 'reviewer reading diff'}`
        : p.lastVerdict
          ? `${p.lastVerdict.decision === 'approve' ? 'approved' : 'changes requested'} on ${p.lastVerdict.iteration}`
          : '',
    mr_ready: p.mr
      ? `${p.mr.draft ? 'draft' : 'ready'} ${mrRef(p.mr.id, p.mr.url)}${p.mr.draft ? ' already open' : ''}`
      : '',
    done: p.stage === 'done' ? 'handed over' : '—',
  };
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="stepper">
        {STEPS.map((s, i) => {
          const done = reached(s.key) && (currentIdx > i || p.stage === 'done');
          const current = currentIdx === i && p.stage !== 'done';
          const blocked =
            p.stage === 'blocked' &&
            i ===
              Math.max(currentIdx, order.indexOf(lastStageBefore(events, 'blocked') ?? 'queued'));
          const at = firstAt(s.stages);
          return (
            <div
              key={s.key}
              className={`step${done ? ' done' : ''}${current ? ' current' : ''}${blocked ? ' blocked' : ''}`}
            >
              <div className="step-head">
                <span className="step-circle">{done ? '✓' : ''}</span>
                {i < STEPS.length - 1 && <span className="step-line" />}
              </div>
              <div className="step-label">{s.label(p)}</div>
              <div className="step-note">
                {at ? `${formatTime(at)} · ` : ''}
                {blocked
                  ? `blocked · ${p.blockedReason?.replace(/_/g, ' ')}`
                  : notes[s.key] || (at ? '' : '—')}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function lastStageBefore(events: RunEvent[], stage: Stage): Stage | undefined {
  const e = [...events]
    .reverse()
    .find((x) => x.type === 'run.stage_changed' && (x.payload as { to: Stage }).to === stage);
  return e ? (e.payload as { from: Stage }).from : undefined;
}

// ---------------------------------------------------------------- timeline

type TimelineTab = 'events' | 'diff' | 'raw';

function Timeline({ p, events, runId }: { p: RunProjection; events: RunEvent[]; runId: string }) {
  const [tab, setTab] = useState<TimelineTab>('events');
  const rows = useMemo(
    () =>
      events.filter(
        (e) =>
          !TAIL_TYPES.has(e.type) &&
          e.type !== 'usage.recorded' &&
          e.type !== 'invocation.scheduled' &&
          e.type !== 'invocation.started',
      ),
    [events],
  );
  return (
    <section className="card">
      <div className="row spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Timeline</h2>
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { value: 'events', label: 'Events' },
            { value: 'diff', label: 'Diff per iteration' },
            { value: 'raw', label: 'Raw log' },
          ]}
        />
      </div>
      {tab === 'events' && (
        <ul className="timeline" data-testid="timeline">
          {rows.map((e) => (
            <TimelineRow key={e.id} e={e} p={p} />
          ))}
        </ul>
      )}
      {tab === 'diff' && <DiffPerIteration p={p} runId={runId} />}
      {tab === 'raw' && (
        <pre className="tail" style={{ height: 520 }}>
          {events.map((e) => JSON.stringify(e)).join('\n')}
        </pre>
      )}
    </section>
  );
}

function TimelineRow({ e, p }: { e: RunEvent; p: RunProjection }) {
  const payload = e.payload as Record<string, unknown>;
  const inv = e.invocation_id ? p.invocations.find((i) => i.id === e.invocation_id) : undefined;
  let tone: 'blue' | 'green' | 'amber' | 'red' | 'gray' = 'gray';
  let head: React.ReactNode = <code>{e.type}</code>;
  let sub: React.ReactNode = null;
  let extra: React.ReactNode = null;
  switch (e.type) {
    case 'run.created':
      head = (
        <>
          <code>run.started</code> · Triggered by {str(payload.by)} ({str(payload.trigger)})
        </>
      );
      break;
    case 'run.stage_changed': {
      const to = payload.to as Stage;
      tone = stageTone(to);
      head = (
        <>
          <code>run.{to}</code> · {STAGE_LABELS[to]}
          {payload.reason ? ` · ${str(payload.reason).replace(/_/g, ' ')}` : ''}
        </>
      );
      if (to === 'queued' || to === 'implementing') return null;
      break;
    }
    case 'intake.passed':
      tone = 'green';
      head = (
        <>
          <code>intake.passed</code> · Ticket is implementable as written
        </>
      );
      sub = `Scope: ${str(payload.repo)} only · plan: ${(payload.plan as string[]).length} steps${payload.scope_notes ? ` · ${str(payload.scope_notes)}` : ''}`;
      break;
    case 'intake.needs_clarification':
      tone = 'amber';
      head = (
        <>
          <code>intake.needs_clarification</code> · Waiting for an answer on Jira
        </>
      );
      extra = (
        <div className="verdict-box">
          {(payload.questions as string[]).map((q, i) => (
            <div key={i}>• {q}</div>
          ))}
        </div>
      );
      break;
    case 'invocation.finished': {
      if (!inv) return null;
      if (inv.mate === 'intake') return null;
      const it = p.iterations.find((x) => x.n === inv.iteration);
      if (inv.mate === 'implementer') {
        tone = 'blue';
        head = (
          <>
            <code>implementation.iteration {inv.iteration}</code> · Implementer mate finished
            {it?.addressed?.blocking_ids.length
              ? ` · addressed ${it.addressed.blocking_ids.join(', ')}`
              : ''}
            {it?.addressed?.skipped.length
              ? ` · skipped ${it.addressed.skipped.map((s) => s.id).join(', ')} with reason`
              : ''}
          </>
        );
        extra = (
          <div className="pills">
            {it?.pushed && (
              <span className="pill">
                <span className="add">+{it.pushed.additions}</span>{' '}
                <span className="del">−{it.pushed.deletions}</span> · {it.pushed.files_changed}{' '}
                files
              </span>
            )}
            {it?.tests && (
              <span className="pill">
                {it.tests.passed === null
                  ? 'tests ran'
                  : `${it.tests.passed} tests passed${it.tests.failed ? `, ${it.tests.failed} failed` : ''}`}
              </span>
            )}
            <span className="pill">
              {formatDuration(inv.durationMs)} ·{' '}
              {formatTokens(
                inv.usage.inputTokens +
                  inv.usage.outputTokens +
                  inv.usage.cacheReadTokens +
                  inv.usage.cacheWriteTokens,
              )}{' '}
              tokens · {formatUsd(inv.usage.costUsd)}
            </span>
          </div>
        );
        break;
      }
      return null;
    }
    case 'invocation.failed':
      tone = 'red';
      head = (
        <>
          <code>invocation.failed</code> · {str(payload.reason).replace(/_/g, ' ')}
        </>
      );
      sub = str(payload.detail).slice(0, 300);
      break;
    case 'review.verdict': {
      const decision = payload.decision as string;
      const blocking = payload.blocking as {
        id: string;
        title: string;
        detail: string;
        file: string | null;
        line: number | null;
      }[];
      const nits = payload.non_blocking as { id: string; title: string; detail: string }[];
      tone = decision === 'approve' ? 'green' : 'amber';
      head = (
        <>
          <code>review.verdict {inv?.iteration ?? ''}</code> ·{' '}
          <strong className={`tone-${tone}`}>
            {decision === 'approve' ? 'Approved' : 'Changes requested'}
          </strong>{' '}
          · {blocking.length} blocking · {nits.length} nits
        </>
      );
      extra = (blocking.length > 0 || nits.length > 0) && (
        <VerdictBox blocking={blocking} nits={nits} summary={str(payload.summary)} />
      );
      break;
    }
    case 'mr.opened':
      tone = 'blue';
      head = (
        <>
          <code>mr.opened</code> ·{' '}
          <a href={str(payload.url)} target="_blank" rel="noreferrer">
            Draft MR {mrRef(str(payload.mr_id), str(payload.url))} opened
          </a>
        </>
      );
      break;
    case 'mr.marked_ready':
      tone = 'green';
      head = (
        <>
          <code>mr.marked_ready</code> · Merge request marked ready for human review
        </>
      );
      break;
    case 'mr.updated':
      return null;
    case 'tracker.transitioned':
      head = (
        <>
          <code>tracker.transitioned</code> · Jira {str(payload.from)} → {str(payload.to)}
        </>
      );
      break;
    case 'tracker.transition_skipped':
      tone = 'amber';
      head = (
        <>
          <code>tracker.transition_skipped</code> · could not move Jira to "{str(payload.to)}"
        </>
      );
      sub = str(payload.reason);
      break;
    case 'tracker.commented':
      head = (
        <>
          <code>tracker.commented</code> · {str(payload.kind).replace(/_/g, ' ')} comment posted on
          Jira
        </>
      );
      break;
    case 'nudge.added':
      tone = 'blue';
      head = (
        <>
          <code>nudge.added</code> · Note from {str(payload.by)}
        </>
      );
      sub = `"${str(payload.text)}"`;
      break;
    case 'nudge.consumed':
      head = (
        <>
          <code>nudge.consumed</code> · handed to the implementer
        </>
      );
      break;
    case 'run.failed':
      tone = 'red';
      head = (
        <>
          <code>run.failed</code> · {str(payload.reason)}
        </>
      );
      sub = str(payload.detail).slice(0, 300);
      break;
    case 'run.budget_exceeded':
      tone = 'amber';
      head = (
        <>
          <code>run.budget_exceeded</code> · {formatUsd(Number(payload.used))} of{' '}
          {formatUsd(Number(payload.limit))}
        </>
      );
      break;
    case 'run.cancelled':
      tone = 'gray';
      head = (
        <>
          <code>run.cancelled</code> · by {str(payload.by)}
        </>
      );
      break;
    case 'run.paused':
    case 'run.resumed':
    case 'run.budget_changed':
      head = (
        <>
          <code>{e.type}</code> · by {str(payload.by)}
          {payload.budget_usd !== undefined
            ? ` · budget ${formatUsd(Number(payload.budget_usd))}`
            : ''}
        </>
      );
      break;
    case 'implementation.pushed':
    case 'implementation.tests':
    case 'implementation.addressed':
    case 'intake.started':
    case 'intake.finished':
      return null;
    default:
      break;
  }
  return (
    <li>
      <span className="time">{formatTime(e.ts)}</span>
      <span className="rail">
        <Dot tone={tone} />
      </span>
      <div>
        <div className="headline">{head}</div>
        {sub && <div className="sub">{sub}</div>}
        {extra}
      </div>
    </li>
  );
}

function VerdictBox({
  blocking,
  nits,
  summary,
}: {
  blocking: {
    id: string;
    title: string;
    detail: string;
    file: string | null;
    line: number | null;
  }[];
  nits: { id: string; title: string; detail: string }[];
  summary: string;
}) {
  const [showNits, setShowNits] = useState(false);
  return (
    <div className="verdict-box">
      {blocking.map((b) => (
        <div className="item" key={b.id}>
          <span className="id">{b.id}</span>
          <span>
            <strong>{b.title}.</strong> {b.detail}
            {b.file && (
              <code className="muted">
                {' '}
                ({b.file}
                {b.line ? `:${b.line}` : ''})
              </code>
            )}
          </span>
        </div>
      ))}
      {blocking.length === 0 && summary && <div className="muted">{summary}</div>}
      {nits.length > 0 && (
        <>
          <button
            className="btn btn-sm"
            style={{ marginTop: 6 }}
            onClick={() => setShowNits((v) => !v)}
          >
            {showNits ? 'Hide' : 'Show'} {nits.length} nit{nits.length === 1 ? '' : 's'}
          </button>
          {showNits &&
            nits.map((n) => (
              <div className="item" key={n.id}>
                <span className="id">{n.id}</span>
                <span>
                  {n.title} {n.detail}
                </span>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

function DiffPerIteration({ p, runId }: { p: RunProjection; runId: string }) {
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const withDiff = p.iterations.filter((it) => it.pushed?.diff_ref);
  useEffect(() => {
    for (const it of withDiff) {
      const ref = it.pushed!.diff_ref!;
      if (diffs[ref] !== undefined) continue;
      void fetch(`/api/runs/${runId}/blobs/${ref}`, { credentials: 'same-origin' })
        .then((r) => r.text())
        .then((text) => setDiffs((d) => ({ ...d, [ref]: text })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withDiff.map((i) => i.pushed!.diff_ref).join(',')]);
  if (withDiff.length === 0) return <div className="empty">No diff yet.</div>;
  return (
    <div>
      {withDiff.map((it) => (
        <details key={it.n} open={it.n === withDiff.at(-1)!.n}>
          <summary>
            Iteration {it.n} · {it.pushed!.files_changed} files ·{' '}
            <span className="tone-green">+{it.pushed!.additions}</span>{' '}
            <span className="tone-red">−{it.pushed!.deletions}</span>
          </summary>
          <pre className="tail" style={{ height: 'auto', maxHeight: 480 }}>
            {diffs[it.pushed!.diff_ref!] ?? 'Loading…'}
          </pre>
        </details>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- live tail

function LiveTail({ p, events }: { p: RunProjection; events: RunEvent[] }) {
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const inv: InvocationView | undefined = p.currentInvocation ?? p.invocations.at(-1) ?? undefined;
  const lines = useMemo(
    () =>
      inv
        ? events.filter(
            (e) =>
              e.invocation_id === inv.id &&
              (e.type === 'invocation.tool_use' ||
                e.type === 'invocation.text' ||
                (e.type === 'invocation.heartbeat' && (e.payload as { note?: string }).note)),
          )
        : [],
    [events, inv],
  );
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);
  return (
    <section className="tail" ref={box} data-testid="live-tail">
      <div className="tail-head">
        <span>
          <Dot tone={inv?.status === 'running' ? 'blue' : 'gray'} />
          {inv
            ? `${inv.status === 'running' ? 'Live tail' : 'Last lines'} · ${inv.mate} mate${inv.iteration ? ` ${inv.iteration}` : ''}`
            : 'Live tail'}
        </span>
        <button className="btn btn-sm" onClick={() => setFollow((f) => !f)} aria-pressed={follow}>
          {follow ? 'Following' : 'Follow'}
        </button>
      </div>
      {lines.length === 0 && <div className="faint">No output yet.</div>}
      {lines.map((e) => {
        const pl = e.payload as { summary?: string; text?: string; note?: string; tool?: string };
        const kind =
          e.type === 'invocation.tool_use'
            ? (pl.summary ?? '').split(' ')[0]
            : e.type === 'invocation.text'
              ? 'note'
              : 'api';
        const body =
          e.type === 'invocation.tool_use'
            ? (pl.summary ?? '').slice((kind ?? '').length + 1)
            : (pl.text ?? pl.note ?? '');
        return (
          <div className="tail-line" key={e.id}>
            <span className="t">{formatTime(e.ts)}</span> <span className="k">{kind}</span> {body}
          </div>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------- facts

function RunFacts({ p, detail }: { p: RunProjection; detail: RunDetail }) {
  const end = p.finishedAt ? new Date(p.finishedAt).getTime() : Date.now();
  const tokens =
    p.usage.inputTokens + p.usage.outputTokens + p.usage.cacheReadTokens + p.usage.cacheWriteTokens;
  const live = p.currentInvocation?.liveUsage;
  const liveTokens = live
    ? live.inputTokens + live.outputTokens + live.cacheReadTokens + live.cacheWriteTokens
    : 0;
  const models = (mate: 'implementer' | 'reviewer') =>
    p.invocations
      .filter((i) => i.mate === mate)
      .map((i) => i.model)
      .at(-1);
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="section-title">RUN</div>
      <div className="facts">
        <div>
          <div className="k">Elapsed</div>
          <div className="v">{formatDuration(end - new Date(p.createdAt).getTime())}</div>
        </div>
        <div>
          <div className="k">Tokens · cost</div>
          <div
            className="v"
            title="Reported by Claude Code: a client-side estimate that can differ from the bill."
          >
            {formatTokens(tokens + liveTokens)}
            {liveTokens ? ' (est.)' : ''} · {formatUsd(p.usage.costUsd)}
            {p.budgetUsd !== null && <span className="muted"> of {formatUsd(p.budgetUsd)}</span>}
          </div>
        </div>
        <div>
          <div className="k">Iterations</div>
          <div className="v">
            {p.iteration} <span className="muted">of {p.maxIterations}</span>
          </div>
        </div>
        <div>
          <div className="k">Team context</div>
          <div className="v">
            {detail.teamContextVersion !== null ? `v${detail.teamContextVersion}` : '—'}
          </div>
        </div>
        <div>
          <div className="k">Implementer</div>
          <div className="v">
            {models('implementer') ? shortModel(models('implementer')!) : '—'}
          </div>
        </div>
        <div>
          <div className="k">Reviewer</div>
          <div className="v">{models('reviewer') ? shortModel(models('reviewer')!) : '—'}</div>
        </div>
      </div>
      <div className="links" style={{ marginTop: 12 }}>
        {detail.ticket.url && (
          <a href={detail.ticket.url} target="_blank" rel="noreferrer">
            Jira {detail.ticket.key} →
          </a>
        )}
        {p.mr && (
          <a href={p.mr.url} target="_blank" rel="noreferrer">
            Merge request {mrRef(p.mr.id, p.mr.url)} ({p.mr.draft ? 'draft' : 'ready'}) →
          </a>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- nudge

function NudgeComposer({
  runId,
  blocked,
  onDone,
  focus,
}: {
  runId: string;
  blocked: boolean;
  onDone: () => Promise<void>;
  focus: boolean;
}) {
  const [text, setText] = useState('');
  const [postToTracker, setPostToTracker] = useState(true);
  const [andRetry, setAndRetry] = useState(blocked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focus) area.current?.focus();
  }, [focus]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await post(`/api/runs/${runId}/nudges`, {
        text,
        post_to_tracker: postToTracker,
        and_retry: blocked && andRetry,
      });
      setText('');
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card" style={{ marginTop: 16 }} onSubmit={(e) => void submit(e)} id="nudge">
      <div className="section-title">NUDGE</div>
      <p className="muted small">
        Goes to the implementer at the start of its next iteration, as a human note. Does not reset
        the iteration count.
      </p>
      {error && <div className="error">{error}</div>}
      <textarea
        ref={area}
        className="input"
        style={{ minHeight: 90, fontFamily: 'inherit' }}
        placeholder="e.g. Use the existing BackoffSchedule helper in shared/ instead of a new one."
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Nudge text"
        required
      />
      <div className="row spread" style={{ marginTop: 10 }}>
        <span className="row">
          <label className="row small">
            <input
              type="checkbox"
              checked={postToTracker}
              onChange={(e) => setPostToTracker(e.target.checked)}
            />{' '}
            Also post to Jira
          </label>
          {blocked && (
            <label className="row small">
              <input
                type="checkbox"
                checked={andRetry}
                onChange={(e) => setAndRetry(e.target.checked)}
              />{' '}
              and retry
            </label>
          )}
        </span>
        <button className="btn btn-primary" type="submit" disabled={busy || !text.trim()}>
          Send to next iteration
        </button>
      </div>
    </form>
  );
}
