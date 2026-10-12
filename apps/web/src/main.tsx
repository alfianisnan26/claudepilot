import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './index.css';

// A deploy replaces the hashed script files under a tab that stayed open, so its next lazy page cannot load. Reload once
// to pick up the new build (not in a loop: a second failure inside 15 s falls through to the error page).
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem('pilot-preload-reload') ?? 0);
    if (Date.now() - last < 15_000) return;
    sessionStorage.setItem('pilot-preload-reload', String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Installable app: the worker only adds an offline page for page loads (see public/sw.js).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}
