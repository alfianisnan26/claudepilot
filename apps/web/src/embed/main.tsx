import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Panel } from './Panel';
import { installShim } from './webmcpShim';
import './embed.css';

// WebMCP without a browser that has it (PILOT-1128, docs/prd/ui-reporter-webmcp.md): the dev server only, with ?webmcp=shim. A
// production build drops this (import.meta.env.DEV is false there) and the shim with it.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('webmcp') === 'shim') installShim(document);

// The reporter panel (docs/prd/ui-reporter.md): its own small entry, served at /reporter/v1/embed inside the SDK's iframe. No app
// shell, no router, no service worker.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
);
