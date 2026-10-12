# Round 13 plan: QA standards and performance gates (coordinator: the main session)

COORD = /tmp/claude-1000/-workspaces-claudepilot/cad07383-74ea-4f0a-88e5-fc51c5b7a125/scratchpad/coord
Read COORD/QA-STANDARDS.md (the owner's addition, binding) and DELEGATION.md. Rules: PLAN.md sections 4-7, PLAN-2.md section A (dev portal paused, git read-only, no real credentials, DinD only, Kubernetes safety A.10, economy, /tmp hygiene).

## 1. Timing (important)
QA and PERFORMANCE MEASUREMENT happen in a QUIET window, after the builders have landed (the machine is shared: 13 agents at once give a load average of 8-10 and ruin latency, FPS and Lighthouse numbers). The coordinator starts the QA agents only when no other builder is running or measuring. Before that, the UI agents in flight follow the A-list of QA-STANDARDS.md as their bar so QA finds little.
Heavier ideas: backend load tests use the scripted stand-in Anthropic API and fake processes, never real credentials, with moderate scale limits stated in the report.

## 2. Packages (prefixes and resources)
| Id | Role | Model / effort (delegation rule) | Prefix | Portal | CDP |
| --- | --- | --- | --- | --- | --- |
| Q2a | UI/UX standards audit and e2e: pass/fail with screenshots for every screen (A1-A7), deterministic e2e flows (A8) with a fake API, visual-regression baselines, flake control, accessibility checks | sonnet / medium (mechanical, large; escalate if flaky tests persist) | q2a- | 3207 | 9337 |
| Q2b | Performance and efficiency: Lighthouse CI gates, bundle budgets, runtime transcript perf, backend load and DB analysis, API and Claude-cost savings, effectiveness; before/after report; re-runnable gate scripts | opus / medium (measurement design and analysis) | q2b- | 3312 | 9442 |
| Q2c | Security and regression over the integrated tree: abuse tests of every new surface (annotations, webhooks, installers, tunnels, approval details, MCP tools, later cross-user), the full suites, boot test, migrations on old DBs; the manual real-device checklist merge | opus / high (security) | q2c- | 3313 | 9443 |
Each QA agent reads docs/qa/qa-report.md, tools/qa/*, apps/server/src/qa/*, COORD/drive.mjs and COORD/p*-checklist-items.md / s2-checklist-items.md for the real-device items.

## 3. Standing assignments
- Q2a: build on tools/qa (browser.mjs, textdiet.mjs, contrast.mjs, focus.mjs, sweep.mjs, mock-anthropic.mjs): add the design-token audit (flag ad hoc values, gradients, glow, glass effects, emoji), the text audit (placeholders, generic AI phrases, term consistency), state coverage per screen, touch-target and focus-order checks, the responsive matrix with automatic overflow/overlap/keyboard checks, the motion audit (durations, properties, layout shift, reduced motion, scroll-follow), and the e2e flow suite with traces; visual regression with baselines and a tolerance; three-run flake gate.
- Q2b: set up the QA package (tools/qa/package.json) with Lighthouse CI and the bundle analysis, measure BEFORE (commit 872a429 in a clean scratch copy) and AFTER back to back, set the gates from the measured baseline, write the runtime and backend measurements (transcripts 1k/10k/25k, session list, tabs, leaks; endpoints p50/p95, event-loop lag, CPU/memory, start time, DB/WAL growth, EXPLAIN, N+1, locks, rate limits and backpressure), the API-saving counts per page load, the Claude-side counts (cache hit rate, handoff/btw context size, probe frequency, tokens per task, wasted turns), the effectiveness metrics; findings with severity; the before/after report; re-runnable gate scripts.
- Q2c: the security and regression pass (see above); coordinate with the multi-user abuse matrix when that lands.
