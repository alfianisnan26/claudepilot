# A4 (browser, desktop, proxy browser) status - updated 2026-10-12 ~03:50 UTC - DONE except B4 (desktop), everything of mine is stopped
BUILT AND VERIFIED
 B1 Docker target: browser container beside each workspace, gate + Playwright MCP (+devtools), pool type/editor/Configuration row, migrations 30-31. 21/21 real-Docker tests passed earlier (before today's later edits);
  today's edits were exercised live (below). Real Claude Code 2.1.296 lists/calls the browser.
 B2 VNC live view (noVNC 1.4.0 lazy chunk, portal bridge, view-only default, lease, handoff, Private cover, immersive route): UI e2e at 1280/390; production build + CSP: no violations, noVNC renders.
 B3 PROXY BROWSER: server preview.ts (validated narrow message set, roles, rate limits, newest-frame-wins, 4001-4004 closes, caps), container helper cpb-view, web PreviewView + Screen/Preview switch (phone: preview first).
  Real browser vs real container: 1280 px (viewer is read-only; take control; address bar; click + typing change the remote page; wheel; back/forward; tabs new/close; JS dialog; hand back) and 390 px
  (fit to screen, tap, finger drag scroll, text bar). Agent+human share one Chromium: agent navigation and new tab show in the preview; while a person holds control the agent's call is refused ("A person has control..."),
  after hand back the agent reads the title the person's click set; a second device is a viewer and its input changes nothing.
 Lockdown: `settingsModule.lockdown.addMatcherSource` registered (index.ts, BrowserService.matchers). Claude Code matches serverCommand against the EXPANDED command (plugin folder spelled out); with mcp.poolOnly ON the
  browser stays "Connected" (real 2.1.296), the unexpanded text is blocked. Boot rule: tick/event/forget paths guarded (store writable + deliveryAllowed), boot test 4/4.
 Tests: browser unit tests 88 pass (gate, supervisor, rfb, service, kind, preview 13, cpbview 12 incl. follow-front-tab and quality). typecheck (server, web, contracts) clean. web build ok (BrowserPage 27 kB, noVNC 172 kB lazy).
 QA fuzz against my portal: 112 mutating routes, 3326 requests, 0 findings. PRD updated: status line, G2, G7, non-goals, §13 rows, §18 milestone states (B0-B6), new §22 Proxy view and §23 What the build changed; README row.
NOT BUILT: B4 desktop tier/MCP server (editor hides Desktop, parse refuses it), per-view token (decision D3 in PRD: same checks as the shell socket), upstream proxy setting, pinch zoom + clipboard in Screen view,
 Monitoring/chat card/Browser panel, Reset action, Downloads/Send a file, Kubernetes, headless tier never run in a container (unit tests only).
Decisions to confirm: no per-view token; Desktop tier refused until B4; noVNC pinned at 1.4.0 (only new dependency, exact).
Requests: none open. Cleanup done: tmux brportal, containers/volume of br-x (removed through my portal: browser removed first), Chromium temp profiles. Left on purpose: image claudepilot-browser:br (1.7 GB, `docker rmi` when done),
 /tmp/brx (scripts), /tmp/brdata (scratch DB). Ports 3104/9234, prefix br-, migrations 30-31.
