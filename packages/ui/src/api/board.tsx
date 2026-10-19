import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { get } from './client.js';
import { useSse, type SseStatus } from './sse.js';
import type { BoardStats, RunSummary } from './types.js';

/**
 * Board state shared by the header counters and the board page: the run
 * summaries (live over the global SSE stream) and the stats strip.
 */
interface BoardState {
  runs: RunSummary[];
  stats: BoardStats | null;
  status: SseStatus;
  error: unknown;
  refresh: () => Promise<void>;
}

const BoardContext = createContext<BoardState | undefined>(undefined);

export function BoardProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<Map<string, RunSummary>>(new Map());
  const [stats, setStats] = useState<BoardStats | null>(null);
  const [error, setError] = useState<unknown>(null);
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStats = useCallback(async () => {
    try {
      setStats(await get<BoardStats>('/api/stats/board'));
    } catch (err) {
      setError(err);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { runs: list } = await get<{ runs: RunSummary[] }>('/api/runs');
      setRuns(new Map(list.map((r) => [r.id, r])));
      setError(null);
    } catch (err) {
      setError(err);
    }
    await loadStats();
  }, [loadStats]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void loadStats(), 60_000);
    return () => clearInterval(t);
  }, [refresh, loadStats]);

  const status = useSse(
    '/api/stream',
    (m) => {
      if (m.event !== 'run') return;
      const run = m.data as RunSummary;
      setRuns((prev) => new Map(prev).set(run.id, run));
      // Coalesce stat refreshes: at most one per 3 s.
      if (!statsTimer.current) {
        statsTimer.current = setTimeout(() => {
          statsTimer.current = null;
          void loadStats();
        }, 3000);
      }
    },
    ['run'],
  );

  const value = useMemo<BoardState>(
    () => ({
      runs: [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      stats,
      status,
      error,
      refresh,
    }),
    [runs, stats, status, error, refresh],
  );
  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoard(): BoardState {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error('useBoard outside BoardProvider');
  return ctx;
}
