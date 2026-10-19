import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../api/auth.js';

/** Header + nav from the mockup (§13.1). Page content renders in the outlet. */
export function Shell() {
  const { user, logout } = useAuth();
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
