import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './api/auth.js';
import { Shell } from './components/Shell.js';
import { BoardPage } from './pages/Board.js';
import { LoginPage } from './pages/Login.js';
import { SetupPage } from './pages/Setup.js';

/** Redirects to /setup while no admin exists, to /login while signed out. */
function Gate({ children }: { children: ReactNode }) {
  const { loading, user, setupRequired } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (setupRequired) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function SetupGate() {
  const { loading, setupRequired } = useAuth();
  if (loading) return null;
  return setupRequired ? <SetupPage /> : <Navigate to="/" replace />;
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/setup" element={<SetupGate />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <Gate>
                <Shell />
              </Gate>
            }
          >
            <Route index element={<BoardPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
