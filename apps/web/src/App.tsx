import { AudiencePage } from './pages/AudiencePage';
import { DjPage } from './pages/DjPage';

/**
 * Two routes only: "/" (public audience page, the QR target) and "/dj" (dashboard).
 * A tiny pathname switch is enough; production serves index.html for both paths.
 */
export function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/dj') return <DjPage />;
  return <AudiencePage />;
}
