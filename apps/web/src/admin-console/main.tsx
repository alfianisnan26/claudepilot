import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Console } from './Console';
import './console.css';

// The Admin console (docs/prd/organizations.md §6.11): its own small entry (admin.html, vite.admin.config.ts), served under /admin-ui/ on the
// admin host only. No app shell, no router, no service worker.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Console />
  </StrictMode>,
);
