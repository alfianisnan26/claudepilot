# RESUME blocks of every agent status file (generated at the stop, 2026-10-12)

## status-a1.md
# A1 (QA) status - updated 2026-10-12 ~04:05 UTC: FINAL HARDENING PASS DONE; everything of mine is stopped. Verdict and counts: docs/qa/qa-report.md (Summary).

## status-a2.md
# A2 status (workspaces, sessions, usage) - updated 2026-10-12 (after the account change)
## RESUME HERE (A2): FINISHED. Scratch cleaned (containers/volumes ws-e2e and ws-demo removed, tmux wsportal/wsmock killed, /tmp/ws* gone). Nothing is mid-way; the final report was handed to the coordinator.
Built and verified for real (Docker workspace, real Claude Code 2.1.296, stand-in API): transfer flow, Bypass (C5), worktrees (FR50), running-session caps and spending limit settings (FR39/40 first cut), multi-agent (FR51), QA-006/007, I8 token + pre-allowed `mcp__pilot__*` (flag accepted by the CLI; the no-prompt effect itself I did not re-run), small hooks (staged reads, persona prompt flag, ENA
Gaps if someone continues: FR40 mid-turn budget stop / FR41 turn caps, memory check and "Waiting for a slot", LFS smudge in portal worktrees, usage audit of very large transcripts, paginated session list, worker cost rollup cap.
Tests at the end: chat+workspaces+store+portalmcp 395 green, qa/boot 4 green, server and web tsc clean, web build OK; full server run earlier: 1156 tests, my area green (3 failures were A3b/A5 tests, green alone).

## DONE + verified with real Claude Code 2.1.296 (stand-in API, Docker ws-e2e, my portal on 3102; 390/1280 px looked at)
- SWITCH (one chat = one portal id; handoff default; rollback; legacy fold): POST /api/chat/sessions/:id/switch, GET .../switch-options, .../segments. Tests in switch/legacy/sessionList/actors.
- BYPASS (C5/FR20): policy = shared setting `sessions.allowBypass` (off, ON asks confirm, on A3a's Settings page). Opt-in only via the app's create route; never inherited/MCP/tickets/spawn. Flag only for capable sessions. Enter = POST .../bypass {acknowledged} after policy+capable+tick+re-auth
  (re-auth = server code again, POST /api/chat/reauth, 10 min per sign-in, wrong code 403). Real: refusals, entry, Bash ran unasked, DENY rule still held, leave = 1 tap, kill+resume -> default (flag still there), policy off -> live session back to default, raw `bypass_not_launched` without the flag.
  Bypass now ends with its process (sleep/stopped/restart notes) + audit (GET /api/chat/audit, entering = high). UI: mode row (danger) / "Restart to allow Bypass", confirm dialog (Cancel focused, tick text from true facts only), code step, danger header + "Bypass x" pill, row badge, "Allow Bypass later in this session". 4 taps + code.
- FIXED: Claude Code's control_cancel_request was ignored (after Stop an approval stayed open, waiting count stuck): now `withdrawn`. QA-007 targets() stale-while-revalidate (manager.test.ts). QA-006 value redactor (chat/valueRedact.ts: raw/base64 x3 alignments/URL/JSON, stream hold-back) wired through controller.scrub + live deltas + requests + tasks.
- I8: agent token minted at every launch/resume/wake/move; env on exec stdin (`cp-session start --env N`), `--mcp-config`; real call of mcp__pilot__portal_status OK; printed token stored as [redacted] (cp(at|oa|or|st)_ shape). session_rename_self registered (chat/portalTools.ts).
- Small hooks: staged-upload Read auto-allow (A2b), openRequests(), persona prompt file flag in the host (real), ENABLE_CLAUDEAI_MCP_SERVERS (real), onRateLimit (A6), `ci` actor + From CI card, persona name/avatar in header/rows/transcript, ClaudeHeadroom in the switch dialog.
- Tests: chat 250+, workspaces 43, boot test green. images/workspace/cp-session regenerated.

## status-a2b.md
# A2b status (chat content: artifacts, media, files) - FINISHED 2026-10-12 ~03:25 UTC (no RESUME needed; only the optional leftovers below)

## status-a3a.md
# A3a status - FINAL for this run, 2026-10-12 ~03:50 UTC (everything of mine is stopped and cleaned up)

## status-a3b.md
# A3b status (platform: Portal MCP + tickets) - updated 2026-10-12 ~03:25 UTC (FINISHED; everything stopped)

## status-a3c.md
# A3c status (personas, instruction contexts, I11 identity) - FINAL 2026-10-12 ~03:15 UTC. Nothing of mine is running (portal, containers, tmux, scratch files removed).

## status-a4.md
# A4 (browser, desktop, proxy browser) status - updated 2026-10-12 ~03:50 UTC - DONE except B4 (desktop), everything of mine is stopped

## status-a4b.md
# A4b (knowledge) status - updated 2026-10-12 03:35 UTC - K0 to K2 BUILT; final report pending the full-suite result

## status-a5.md
# A5 status (local git + CI/CD) - FINAL, updated 2026-10-12 ~04:30 UTC

## status-a6.md
# A6 status (Claude account usage monitoring) - FINAL, 2026-10-12 02:25 UTC
DONE. Nothing running, nothing waiting on me. (RESUME HERE: not needed; everything is built, verified and cleaned up.)
TESTKIT: apps/server/src/claudeusage/testkit/ (README.md). PRD: docs/prd/claude-usage.md v0.2 (+ row in docs/prd/README.md).

Built: server apps/server/src/claudeusage/** (parse, probe, store, service, source, routes, portalTools, index, fixtures, testkit/), contracts claudeusage.ts (+ live topic
`claudeusage`), migration 90, config PORTAL_CLAUDE_USAGE_{PROBES,INTERVAL_S,FAST_S,ONLY}; web features/usage/claude/** (Usage -> Claudes tab with meters, countdown + local time on tap,
status icon, sparkline, check-now, history, snooze; ClaudeMeter; ClaudeHeadroom; alert toasts watcher); surgical edits: UsagePage.tsx, ClaudesSection.tsx, App.tsx, app.ts, index.ts,
live.ts, config.ts, migrations.ts, contracts index/live, chat-sessions.md + workspace-claudes.md section 6 wording (approved), README row.
Verified: 56 module tests (parse 12, probe 8, store 5, service 17, routes 4, MCP tool 2, real-CLI integration 8) + qa/boot 4 green; full server suite 1111 tests, 2 failures in
OTHER areas (browser cpb-view screencast timing, secrets job test); QA fuzz: 112 routes, 0 findings; web typecheck + build green; real Docker workspace probe (signed out, apiKeyHelper ->
no plan limits, fake Max login via stand-in -> windows); live push over the socket; UI at 390/1280 light+dark with seeded states.
NOT verified (PRD section 19): a real subscription's reply; a live chat feeding onRateLimit (A2 wired it, no live session run); pool-workspace outbox; k8s / This machine.
Cleanup: tmux sessions, container claudepilot-cu-a + volume, /tmp/cudata, /tmp/cu-scratch, /tmp/cu*.

## status-a7.md
# A7 status (chat motion and polish) - FINAL, 2026-10-12 03:15 UTC. Nothing running (portal, Chromium, /tmp files removed).

## status-b1.md
# B1 status (built-in MCP catalogue core)  [FINAL: done, cleaned up]
RESUME HERE: nothing pending. If reopened: (1) switch nothing, templates come from providers/index.ts via builtin/templates.ts; (2) B3's src/mcp/oauth/signin.test.ts had 1 failing test when I last ran src/mcp/** (theirs, in progress).
NOT DONE: mcp_builtin_propose (decision B1-5, PRD), web UI (B4), sign-in (B3), update path only tested in unit tests (no template has a v2 yet).
REQUESTS: mcpset-pool.md and portal-mcp.md could link/list docs/prd/mcp-builtin-catalogue.md and the tool mcp_builtin_list (not my files).

## status-b2.md
# B2 status (providers: research, definitions, stand-in server) - 2026-10-12  DONE
RESUME HERE: nothing pending. If asked: re-probe providers with the PRD section 2 recipe and bump template `version`/`checkedAt` when a fact changes.

## status-b3.md
# B3 status (OAuth status + guided sign-in) - FINISHED 2026-10-12 ~05:50
RESUME HERE: nothing pending; only the final report.

## status-b4.md
# B4 status (catalogue web UI) - FINISHED 2026-10-12 ~05:45
RESUME HERE: nothing pending; only the final report.

## status-cx1.md
# status-cx1 (T1 control plane and registry), FINAL 2026-10-12 ~07:10Z
RESUME HERE: nothing left to build. Only: (1) read the last typecheck (scratchpad/cx1-tsc2.out), (2) cleanup of /tmp/cx1-* (test temp dirs older than 20 min, scratch scripts, logs) and the scratchpad cx1-*.out files, (3) the final report.

Built: connect/{seams,store,events,settings,registry,enrollment,hub,admin,routes,publicRoutes,runtimes,authz,validate,tokens,agentText,config,bundle,installPort,index,testkit}.ts, connect/tunnel/** (frame, mux, stream, lines, records, auth, ws, open, memory, conformance, index), connect/qa/stubAgent.ts; migrations 130+131; config.connect; live topic 'connect'; cpen_ redactor patterns; app.ts mount
Tests: 224 in 17 files, all green (tunnel/conformance/fuzz/perf, enrollment, registry, hub, hub.attacks, routes, security, runtimes, integration with the REAL agent, stub agent, redactors). Full server suite: 2142 tests, 2119 pass, 2 fail outside Connect (agent limits.test.ts hung 8 min, passes alone 7/7; platform.test.ts "triggers already registered"), 21 skipped. Typecheck: only others' errors (
Verified on a real scratch portal (clean env): enroll/connect/rotate/revoke/restart/Locked store/kill switch, and the real agent in Docker mode with a real workspace container: 428 -> onWorkspaces=remove (container+volume gone) and keep (container stays). cx1 containers/volumes removed.
PRD: C1 row Built + §14 schema + §22.1 D19-D23 + FR9/§15 query name. README row and the PRD's top status line left to T6/coordinator.
Decisions: see the PRD §22.1 D19-D23 and the C1 note; multi-user light touch via authz seam; clean env rule; heavy commands under flock.
Blockers: none.

## status-cx2.md
# status-cx2 (T2, the agent), updated 07:55Z
RESUME HERE: C2 is built and green in the sandbox: agent module 150+ tests (node --test 'src/connect/agent/**/*.test.ts'): host (T-HOST 26 incl. 100 MB put 26-33 MB growth),
docker policy/proxy (23 policy + 10 recorded-DockerRuntime + 4 limits), kube (14, KubernetesRuntime over loopback), client/enroll/rekey with a crash at every step (12+6),
private CA + CONNECT proxy (3), protocol/refusals (5), doctor (7), canary (3), config/identity/main (21), bundle (6: sync, hygiene, symlink regression, process e2e, idle 58.6 MB),
T1's mux conformance over the agent's client (13), agent.e2e (docker A10 + real DockerRuntime + swarm + real KubernetesRuntime over the real tunnel). Opt-in (CLAUDEPILOT_DOCKER_TESTS=1), all run
and passing: real DinD policy (5), Container rig as root (1), the bundle on Node 22.13.0 in a container (1); Q4/Q5 + 117 store-free tests re-run on Node 22.13.0.
NEXT: (1) logger remote sink for caller loggers + 20/min test, (2) docker Mount Source = the workspace's own home volume, (3) kube body checks (hostPath, privileged, hostNetwork,
PVC volumeName/dataSource, Secret type) + PATCH deep scan, (4) log.ts unit tests, (5) PRD edits (Appendix A create query note) + the C2 status note, (6) heavy.lock typecheck + the
full server suite ONCE, (7) final report. Bundle build now fe6e424c3281 (regenerate after any change in connect/agent, tunnel, seams, hostexec, runtime, connect.ts).
Findings for others: server store needs Node >= 22.16 (node:sqlite backup), root package.json says >=22.13 (not the agent); T3: stop TunnelAgent sockets when the peer ENDs (idle FIN).

## status-cx2b.md

## status-cx3.md
Spawn: model=opus effort=medium - Tier A: remote runtimes over the tunnel (Docker, Kubernetes, Host), manager changes and outage rules touch the core runtime code with real blast radius; spec is detailed; escalate to fable/high if the outage rules or delivery seams prove ambiguous
RESUME HERE: W1+W2-against-T1-hub done. Remaining (blocked on others): (1) when T1 lands createConnect: add ONE line in index.ts `wireConnect({ connect, workspaces, chat: chatController, reconciler })` BEFORE the moved `workspaces.resume()` (it now sits right after reconciler.start()); (2) when T2 lands runAgent: swap serveAgentStream for runAgent in workspaces/connect/realTunnel.test.ts and docke
Done (apps/server/src/workspaces/connect/): tunnelAgent, link (Reachability/HostCall), host (HostRuntime), dockerCluster, kube (+KubeLoopback), factory (createTunnelRuntime), wire (wireConnect), testkit (FakeLink, serveAgentStream, fakeDaemon, fakeKubeApi, memoryDeps).
Edits: contracts workspace.ts + web STATUS map; runtime.ts (TargetUnreachableError, isTargetUnreachable, portalUrl?, listLastKnown?, reachable?, CreateSpec.node); docker.ts (extras.tunnel, firstFileOf destroy, tarOf -> workspaces/tar.ts); kubernetes.ts (ready KubeConfig, manageNamespace:false); manager.ts (add/replace/removeRuntime, onRuntimeChange, unreachable list, settled grace, beforeCreate, n
Tests (all green): host 8, dockerCluster 4 (incl. list of 20 <=300ms), dockerTunnel 2 (DinD), kube 2, manager.connect 5, wire 1, realTunnel 2 (T1 hub, DinD), chat/outage 1 (fails without the fix), reconciler +1, outbox.outage 1, internalUrl +1. Targeted run 123 tests, 0 fail. Web build green. PRD C3 row: Partly built + Multi-user line in §12.10.
Decisions: tunnelled Docker exposes no images/throwaway/recreate (no pinning/canary there v1); kube loopback in kube.ts; no workspace authz resolver registered (P5 retrofit); manager create requireCan(actor,'operate',target) for every target; PORTAL_INTERNAL_URL loses to an enrolled target's portalUrl.
Full server suite once: 1839 tests, 1820 pass, 1 fail (qa/boot.test.ts "not a database", passes alone: load flake, not mine), 18 skipped. Cleanup done (no cx3 containers, volumes, tmux, /tmp dirs).
Blockers: none of mine. Waiting on T1 createConnect, T2 runAgent.

## status-cx4.md
Spawn: model=opus effort=medium - Tier A: installer scripts (sh and PowerShell) run on users' machines and handle enrollment tokens, checksums and uninstall: security-relevant, big spec, verified by script tests; escalate to fable/high if the token or checksum handling proves ambiguous
RESUME HERE (W2): when T2 lands agent.generated.ts + `enroll --token-stdin` and T1 mounts createInstallRoutes, run install.sh
from a rig host against a scratch portal (port 3214) for docker, container and host (A1/A4/A5 shape); replace the fake bundle check.
Built: apps/server/src/connect/install/{routes,plan,manifest,commands,fetcher,testkit}.ts, scripts/install.{sh,ps1},
installers.generated.ts, ../node-manifest.json, scripts/gen-connect-{installers,node}.ts, package.json gen scripts, tests
(plan, manifest, commands, fetcher, routes, scripts, ps). 48/48 green with CLAUDEPILOT_DOCKER_TESTS=1; typecheck clean for my files.
Full server suite (once): 2008 pass, 2 fail outside my area (browser/cpbview.test.ts, a chat attachment test), 21 skipped.
Decisions: PILOT_RESULT also `removed`/`ok`; pty from registry tarballs + integrity, no npm; k8s Namespace is the first doc
(dropped when it exists); `run` output on fd 3; PS fetcher via env var (5.1 quoting); host kind refuses root unless PILOT_ALLOW_ROOT=1;
missing workspace image: pull, then build from the served context (PILOT_BUILD_IMAGE=1 forces, 0 forbids).
Cleanup: no cx4 containers/volumes/tmp left; pwsh and kubeconform images removed; koalaman/shellcheck kept (shared, small).

## status-cx5.md
T5 DONE (partly built, PRD C5 note written). RESUME HERE (if continued): after T1 renames the remove query, set REMOVE_QUERY in web/features/targets/api.ts and re-run the 428 Remove check; look at dark mode, partial/offline/revoked rows, Kubernetes/Host steps at 390; install symlink-entry bug (outbo
T5 DONE (partly built, PRD C5 note written). RESUME HERE (if continued): after T1 renames the remove query, set REMOVE_QUERY in web/features/targets/api.ts and re-run the 428 Remove check; look at dark mode, partial/offline/revoked rows, Kubernetes/Host steps at 390; install symlink-entry bug (outbox-cx5) blocks the one-line installer.
Built: apps/web/src/features/targets/* (+wizard.test.ts 9 green), nav/App/live edits, WorkspacesPage/NewWorkspaceDialog/WorkspaceSheet changes. Web tsc green.
Scratch portal, rig container, volumes, tmp files removed.

## status-cx6.md

## status-dg.md

## status-dv.md

## status-g1.md
# G1 status (workspace git, server) - FINISHED 2026-10-12 ~05:50 UTC
## RESUME HERE
Nothing left to do. Final report sent. If asked: re-run COORD/g1-ro-scan.mts (needs RO_IMG with git+jq), or extend the host with a clone/init command (PRD Q4).
## Done (all verified, see docs/prd/workspace-git.md section 17)
- contract packages/contracts/src/repos.ts + live topic 'repos'; migration 120; host commands repo-find / repo-state / repo-track / repo-sync (chat/host.ts, additions only; images/workspace/cp-session regenerated)
- apps/server/src/repos/*: text, parse, tree, events, store, host, service, routes, portalTools, index (+ testkit); wired in index.ts, app.ts, config.ts, live.ts
- 71 tests in repos/*.test.ts (real git + real host script), 113 with the chat host and live tests: all pass; server typecheck clean; web typecheck and build pass; QA boot tests 52/52
- live: real portal + real Docker workspace: scan of 20 and of 42 repos in 1.2 and 1.8 s, timer round noticed a commit, worktree via API and via MCP, sync updated / refused, MCP tools over /mcp; hostile repo inert
- real pool (read-only, counts only): 18 repos = root + 17 nested, 2.8-4.5 s, 0 errors
## Decisions
see PRD section 19 (home folder default root, path-based ids, re-read known repos, sync refuses repos whose config runs programs, attribution by presence, Kubernetes never scanned)
## Cleanup
tmux gtportal, container + volume gt-ws, /tmp/gt-*, test temp dirs: removed. g1-ro-scan.mts stays in COORD for you.

## status-g2.md
# G2 status (repos web UI) - 2026-10-12 07:00 UTC - FINISHED
## RESUME HERE
Nothing left. Final report sent. All my scratch resources are removed (portal :3206, container + volume gu-ws, /tmp/gu*).
## Done
- apps/web/src/features/repos/* (Repos tab, repo sheet + timeline, dialogs, list chip, 403/offline/stale states, find field, QA A1-A9 rules), loaded on demand by the workspace sheet; surgical edits in WorkspaceSheet.tsx and WorkspacesPage.tsx.
- apps/server/src/repos/events.ts lines 27 and 34: "repo" wording (coordinator's request); repos tests 73/73.
- docs/prd/workspace-git.md: status, s.16, s.17 Web UI bullet, G4 row.
## Results
- web tests features/repos 13/13; web `tsc --noEmit` clean (last run after the final edit, exit 0); root typecheck: only server test errors of other agents (chat/btw.*.test.ts, triggers/providers.test.ts); `vite build` OK (before the last lazy-load edit).
## Not done
- deep link from a chat's worktree chip to its repo; Safari scroll anchoring not measured; kit-owned 40 px controls (Dialog close, Segmented) noted for QA; full server suite not run (only repos tests).

## status-ga.md
Spawn: model=sonnet effort=medium - Tier B: server state, aggregation of existing services and a registry test against a clear spec; escalate to opus if the real-state checks or authz adoption stall

## status-gb.md
Spawn: model=sonnet effort=medium - Tier B/C: UI engine and components against a landed contract, verified by e2e and screenshots; escalate to opus if the collision/gate logic or flakiness persists

## status-k1.md
Spawn: model=opus effort=medium - Tier A: auth tokens + device flow + REST lifecycle against a stand-in; REDIRECTED by the owner from a Copilot CLI POC to a GitHub Codespaces target POC (PLAN-16 rewritten); escalate to fable/high if token/storage design proves ambiguous
RESUME HERE: nothing pending; next work = K2 (devcontainer side) and K3 (UI) per PLAN-16.

## status-mu1.md
Spawn: MU1 identity core | fable | high | Tier S: accounts, passwords, sessions, setup token = security-critical, hard to verify | 2026-10-12T06:49Z
RESUME HERE: nothing written yet; next = migrations 400-402 in store/migrations.ts (append), then identity/passwords.ts + test.

## status-mu2.md
Spawn: MU2 authorization layer (shadow mode) | fable | high | Tier S: default-deny authorization, one decision point, evasion tests | 2026-10-12T06:49Z
RESUME HERE: nothing written yet; next = policy.routes.v0.ts generated from COORD/p5-tools rules, then evaluate.ts + store.ts + tests.

## status-mx.md
Spawn: P9 MCP complete + pool gateway architect | fable | high | Tier S: authorization/untrusted-text/secret-injection gateway architecture is security-critical | 2026-10-12T07:05Z
RESUME HERE: start the audit (grep registerPortalTool; read portalmcp/registry.ts, tokens.ts, agents.ts, server.ts, module.ts).

## status-n1.md
Spawn: model=opus effort=high - Tier S/A: Web Push crypto, VAPID, single-use answer tokens bound to request+user (answering approvals from a notification is an authorization act), webhook/SSRF guard, sealed keys: security-critical; the spec is detailed (P2 verified RFC vectors); escalate to fable/hi
RESUME HERE: nothing pending. Follow-ups for others: N2 wires the Bell unread count from GET /api/notify; N3 registers its module in platform/index.ts and sets platform.notify.trustedTrigger.

## status-n2.md
Spawn: model=sonnet effort=medium - Tier B/C: web UI and a small service worker against a detailed spec and a landed contract; the server verifies the answer tokens (N1), so the worker only posts; verified by Node vm tests and Chromium; escalate to opus if the worker or tests stall
RESUME HERE (if resumed): when N1 lands, rerun against real routes; replace 'notify' topic cast after H3; nav Bell unread count (AppShell); GET for session flag (request in outbox).

## status-n3.md
Spawn: model=opus effort=high - Tier S/A: inbound webhooks with signature verification, prompt-injection exposure (payload text becomes an agent's opening), cron/DST correctness and automatic session starts with cost limits: security- and cost-sensitive; detailed spec (P2 computed vectors); escalate
RESUME HERE: write triggers/ci.ts (bus ci_failed -> facts + loop guard), scheduler.ts, receiver.ts, routes.ts, authz.ts, settings.ts, portalTools.ts, index.ts; register in platform/index.ts.

## status-n4.md
Spawn: model=opus effort=medium - Tier A: an automatic action that moves sessions between Claudes and spends quota (policy engine with safeguards, undo, audit); spec is detailed with hand-computed cases; escalate to opus/high if safeguards prove ambiguous
RESUME HERE: check apps/web/src/features/autotransfer/ for what exists; continue with the missing piece.

## status-p1.md
# P1 status (architect: Connect) - 2026-10-12
RESUME HERE: if the final report is not yet sent: re-read docs/prd/targets-connect.md once for contradictions with the contract, fix, then send the report (files, key decisions, owner decisions, work packages and waves). Do not start implementing.

## status-p2.md
# P2 status (auditor and architect: notifications, triggers, auto transfer, platform roadmap) - 2026-10-12
RESUME HERE: nothing pending. If asked again: detail phase 2 (emergency button, DB restore test, volume backups, egress, ticket levels, PR/MR status, CI M3) and phase 3 (paging, export, search) starting from docs/prd/platform-roadmap.md sections 7-8 and p2-workbreakdown.md section 8.
CLEANUP: no portal, container, tmux session or Chromium left (spike browser profile removed). Only scratchpad/pn-spike files remain (small, referenced by the PRDs).

## status-p3.md
Spawn: P3 evidence/annotations/code viewer architect | opus | high | Tier A: design with security (untrusted quotes, storage decision) but no runtime code | 2026-10-12T06:56Z
RESUME HERE: research + spike in /tmp/pe-spike (Monaco vs Shiki sizes, strict CSP in Chromium), then contracts, then PRDs, then work breakdown.

## status-p4.md
Spawn: P4 ops plan architect (secret scanner, auto-approval rules, maintenance, templates) | fable | high | Tier S: auto-approval matching + evasion = security-critical design | 2026-10-12T06:56Z
RESUME HERE: nothing written yet beyond this file.

## status-p5.md
# P5 status (auditor and architect: multi-user, security) - FINISHED 2026-10-12 ~06:50 UTC
RESUME HERE: nothing pending. If asked: (1) re-run COORD/p5-tools/dump-routes.mts and policy-gen.mjs after routes change to refresh Appendix A; (2) re-read docs/prd/multi-user.md s12 when new plans land (13-21 were mapped; later ones need rows); (3) MU1/MU2 may start now (see p5-workbreakdown.md).
BLOCKERS: none.

## status-ps.md
Spawn: P7 data placement audit (READ-ONLY) | opus | high | Tier A: audit across the whole schema, no code changes; stages a migration plan | 2026-10-12T06:56Z
RESUME HERE: write seeder (scratchpad/ps-seed.mts) -> run -> db-measure -> backup timing -> write COORD/p7-inventory.md and docs/prd/data-placement.md.

## status-px.md

## status-q2.md

## status-q2a.md

## status-q2b.md

## status-q2c.md

## status-s1.md
# S1 status (btw engine) - DONE, final report sent

## status-s2.md
# S2 status (btw UI) - DONE (pending engine wiring by S1)
RESUME HERE: nothing required. Scratch portal stopped (tmux bvportal), Chromium closed by the harness.
Built: apps/web/src/features/chat/btw/{BtwCard,BtwSheet,BtwSidePanel,PinnedBtw,layout,slash,state}.ts(x), Composer (slash list + btw button), SessionPage wiring, useChatSocket btw state, Transcript pinned card, tools/qa/btw-layout.mjs + btw-fake.js, PRD chat-sessions.md 20.12, COORD/s2-checklist-items.md.
Verified: matrix 12 configs (6 sizes x light/dark, reduced motion at 1280): 555/562 first full run, the 7 failures were test races (synthetic scroll) and one hot-update break from other agents; fixed and re-run per config: phone-landscape 82/82, desktop-1280-dark 53/53, 1280-light 52/52. Not re-run as ONE full matrix after the last test fixes.
Unit tests: slash.test.ts, state.test.ts pass (6). web tsc: only error is targets/TargetSheet.tsx (not mine).
Not verified: real engine (btw_ask is not handled by the server socket yet), production build (heavy lock), real iOS.

## status-u1a.md
# U1a status (usage engine A) - FINAL, 2026-10-12
RESUME HERE: nothing pending.

## status-u1b.md
# U1b status (usage engine B: attribution, budgets, spikes, MCP tools)
RESUME HERE: nothing pending. If anything is reopened: (1) `cd apps/server && env -u KUBECONFIG -u KUBERNETES_SERVICE_HOST node --import tsx --disable-warning=ExperimentalWarning --test 'src/usagespend/*.test.ts'` (63 tests); (2) PRD docs/prd/claude-usage.md sections 21-26 (appended; U1a owns 1-20); (3) web pages are U2's (contract packages/contracts/src/usagebudget.ts, routes USAGE_SPEND_API unde

Built: contracts usagebudget.ts; migrations 180-183 (usage_sessions, usage_persona, usage_budgets, usage_spikes, usage_spike_snoozes, created_by/owner, usage_audit); apps/server/src/usagespend/** (periods, model, attribution, spikes, budgets, store, settings, service, csv, routes, portalTools, actor, index, testkit + 8 test files); surgical seams: chat/controller.ts (onUsage, onLaunch, sendGate, #
Verified: 63 own tests (hand-computed); chat/qa/settings/store/portalmcp 416 green; full server suite minus src/connect (another track, in progress): 1521 tests, 1505 pass, 15 skipped, 1 timing flake in browser/gate.test.ts that passes alone; live scratch portal :3222 (schema 183 from scratch, K8s off): summary $7.00/700 in/3 req, by session/ticket/persona/claude/workspace match hand numbers, budg
Decisions: persona recorded at launch on change (older = not_recorded); ticket = session link, children inherit; usage_sessions snapshot survives deletes; all dollars estimate; budgets all/claude/workspace, day/month in usage.timezone, alert-only default, pause opt-in via sendGate (409 USAGE_BUDGET); spikes rate/burst/outlier heuristics; live topic claudeusage reused; multi-user seams (actorId, cr
Not done: UI (U2); ticket-claim links; in-turn runaway detection; real-workspace chat spend check.

## status-u2.md
# U2 status (usage page UI) - 2026-10-12 06:40 - DONE (final report sent)
RESUME HERE: nothing pending; scratch scripts (seed/check/stress/sweep/drive2) stay in scratchpad/uu for QA (they need a portal on 3223 started with start-portal.sh and a docker workspace 'uuws' with Claudes Satria, Kresna, Arjuna, Nakula, Sadewa).

## status-u3.md
# U3 status (glance framework + Quota widget) - 2026-10-12  -- FINISHED, final report sent
RESUME HERE (only if asked to extend): U4 fills PRD §10.1-10.4; when push lands (PLAN-5) the service worker can set the badge and open
/admin/sessions?glance=attention; when accounts land swap glance/user.ts currentUserId() for the auth user id and `mayUse` in
widgets/quota/quota.ts for the rows' rights.

## status-u4.md
# U4 status (glance widgets + aggregator + approval-text fix) - 2026-10-12: DONE, final report written
RESUME HERE: nothing pending. If anything is reopened: scratch portal recipe = env -i + /tmp/uwhome (see outbox-u4 incident), stand-in
Messages API + chat.mjs + seed were in /tmp/uwstub (deleted; rebuild from the glance PRD section 14 description).

DONE
- Server: apps/server/src/glance/{build,service,routes,authz,index,testkit}.ts, topic `glance` (contracts live.ts, live.ts hub + `watching`),
  wired in index.ts/app.ts; every read takes the seam's Actor (glance/authz.ts, declarePolicies, actorOf); 33 glance tests + live test.
- Web: features/glance/widgets/{shared,sessions,agents,attention,shortcuts}, 4 lines in registry.ts; Ctrl/Cmd+K palette; QA A9 steady lists.
- Approval fix (P1): contracts ChatRequest.full/fullCut/requestReview, protocol requestFull, migration 190, store, controller guard,
  ApprovalCard + ApprovalBlock + approvalReview, widget; chat/approvalText.test.ts (13) + web agreement tests.
- PRDs: glance-widgets.md 8, 10.1-10.6, 13, 14-17; chat-sessions.md FR25a + data model.
- Verified: real Claude Code 2.1.296 + scripted stand-in (no credentials): Deny, Allow, Stop task; 390/landscape/768/1024/1280/1920 light+dark;
  states, extreme data, neighbour shift. Screens: COORD/u4-screens/. Full server suite 1971 tests, 0 fail (21 skipped); web 315 tests, 0 fail;
  web build passes; tsc clean for my files (other agents' files have their own errors).


## status-ur.md
Spawn: model=sonnet effort=medium - Tier B: small accessible UI components, a dev-only lab and browser measurement harness against a precise spec; escalate to opus if the neighbour-shift/CLS measurements prove unreliable or the popover/keyboard behaviour keeps failing

## status-us.md

## status-v1.md
# status V1 (version pin + canary)   updated 2026-10-12 06:30 UTC
RESUME HERE: read this + outbox-v1.md + coord/v1-edits.md; code in apps/server/src/claudeversion/; my portal: tmux vcportal (kill at the end), containers claudepilot-vcx / vc-canary-*, images claudepilot-workspace-vc:*, volume claudepilot-vcx-home, /tmp/vcdata /tmp/vchome.

## status-v2.md
Spawn: model=sonnet effort=medium - Tier B/C: UI against V1's landed contract (chips, a Configuration section, a canary report view); mechanical, verified by screenshots; escalate to opus if stuck

## status-vx.md
Spawn: model=opus effort=high - Tier A/S: the choice among five remote-workspace designs and the extension's auth/token/CSP/approval security model decide a long-lived platform surface; real-test PoCs with licence analysis; escalate to fable/high if the security design proves ambiguous

