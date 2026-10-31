import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Panel } from './Panel';
import './embed.css';

// The reporter panel (docs/prd/ui-reporter.md): its own small entry, served at /reporter/v1/embed inside the SDK's iframe. No app
// shell, no router, no service worker.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
);
