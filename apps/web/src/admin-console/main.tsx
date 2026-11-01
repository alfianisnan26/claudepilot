import { ADMIN_STEP_UP_CHANNEL, type AdminStepUpMessage } from '@portal/contracts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Console } from './Console';
import { popupResult } from './model';
import './console.css';

// The Admin console (docs/prd/organizations.md §6.11): its own small entry (admin.html, vite.admin.config.ts), served under /admin-ui/ on the
// admin host only. No app shell, no router, no service worker.
//
// A step-up popup (owner, 2026-11-01): the provider sends the popup back here with `?oidc=stepped&popup=1` (or refused). It tells the console
// that opened it, through window.opener and a BroadcastChannel (same origin only: a provider that cuts the opener still leaves the channel),
// and closes; the console then runs the action the step-up interrupted.
const result = popupResult(window.location.search);
if (result) {
  const message: AdminStepUpMessage = { type: 'admin-step-up', outcome: result };
  try {
    window.opener?.postMessage(message, window.location.origin);
  } catch {
    // the opener is gone or another origin: the channel still carries it
  }
  try {
    const channel = new BroadcastChannel(ADMIN_STEP_UP_CHANNEL);
    channel.postMessage(message);
    channel.close();
  } catch {
    // no BroadcastChannel: the console sees the popup close and asks the server
  }
  window.close();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {result ? (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-2 px-4 text-center">
        <h1 className="text-lg font-semibold">{result === 'stepped' ? 'Done' : 'Not confirmed'}</h1>
        <p className="text-sm text-muted">You can close this window.</p>
      </main>
    ) : (
      <Console />
    )}
  </StrictMode>,
);
