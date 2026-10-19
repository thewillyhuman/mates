import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../api/auth.js';
import { useBoard } from '../api/board.js';
import { Dot } from './ui.js';

/** Header + nav from the mockup (§13.1): product name, nav, counters, user menu. */
export function Shell() {
  const { user, logout } = useAuth();
  const { stats, status } = useBoard();
  const initials = (user?.displayName ?? '?')
    .split(/[\s._-]+/)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);
  return (
    <>
      <header className="shell-header">
        <NavLink to="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Mates
        </NavLink>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>
            Board
          </NavLink>
          <NavLink to="/tickets">Tickets</NavLink>
          <NavLink to="/mates">Mates</NavLink>
          <NavLink to="/usage">Usage</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="shell-right">
          {stats && (
            <span className="header-counters" data-testid="header-counters">
              <span className="tone-blue">
                <Dot tone="blue" />
                {stats.running.total} running
              </span>
              <span className={stats.waiting.total ? 'tone-amber' : 'muted'}>
                <Dot tone={stats.waiting.total ? 'amber' : 'gray'} />
                {stats.waiting.total} need you
              </span>
            </span>
          )}
          <span className="faint small" title={`live updates: ${status}`}>
            {status === 'open' ? '● live' : '○ reconnecting'}
          </span>
          <button
            className="avatar"
            title={`${user?.email ?? ''} — sign out`}
            onClick={() => void logout()}
          >
            {initials}
          </button>
        </div>
      </header>
      <main className="shell-main">
        <Outlet />
      </main>
    </>
  );
}
