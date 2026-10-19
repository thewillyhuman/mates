import { useEffect, type ReactNode } from 'react';

/** Small presentational building blocks; styles live in styles.css. */

export function StatTile({
  label,
  value,
  unit,
  detail,
  tone,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  detail?: ReactNode;
  tone?: 'amber' | undefined;
}) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` tone-${tone}` : ''}`}>
        {value}
        {unit && <span className="stat-unit"> {unit}</span>}
      </div>
      {detail !== undefined && <div className="stat-detail">{detail}</div>}
    </div>
  );
}

export function Chip({
  children,
  mono,
  tone,
  title,
}: {
  children: ReactNode;
  mono?: boolean;
  tone?: 'blue' | 'green' | 'amber' | 'red' | 'gray';
  title?: string;
}) {
  return (
    <span className={`chip${mono ? ' mono' : ''}${tone ? ` chip-${tone}` : ''}`} title={title}>
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: 'blue' | 'green' | 'amber' | 'red' | 'gray' }) {
  return <span className={`dot dot-${tone}`} aria-hidden="true" />;
}

/** Iteration bar from the mockup: one segment per allowed iteration. */
export function IterationBar({
  done,
  max,
  tone,
}: {
  done: number;
  max: number;
  tone: 'blue' | 'green' | 'amber' | 'red' | 'gray';
}) {
  const segments = Math.max(max, done, 1);
  return (
    <div className="iteration-bar" aria-label={`${done} of ${max} iterations`}>
      {Array.from({ length: segments }, (_, i) => (
        <span key={i} className={`iteration-segment${i < done ? ` filled-${tone}` : ''}`} />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Banner({
  tone,
  children,
}: {
  tone: 'amber' | 'red' | 'blue';
  children: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role="status">
      {children}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="tabs" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          className={`tab${o.value === value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Confirm dialog; Esc closes (§13.7). */
export function Dialog({
  title,
  children,
  onClose,
  actions,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="dialog-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      {error instanceof Error ? error.message : JSON.stringify(error)}
    </div>
  );
}

/** `/` focuses the search box (§13.7). */
export function useSlashFocus(id: string) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key === '/' && target && !['INPUT', 'TEXTAREA'].includes(target.tagName)) {
        e.preventDefault();
        document.getElementById(id)?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);
}
