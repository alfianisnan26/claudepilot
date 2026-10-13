# Orchestrator status (2026-10-13)

Knowledge: vault "ClaudePilot dev" (6cd11f710cc3), folder Dev loop/ (the loop, decisions, package reports). Tickets mirror this file (owner, 07:2x): T-1 Pinned, T-2 sideways scroll, T-3 upload exit 4, T-4 automove.allowBypass, T-5 sub-agent visibility, T-6 MCP client label, T-7 auto-move web, T-8 Connect T6, T-9 phone chrome, T-10 N2, T-11 N3, T-12 CI screens, T-13 T5 second pass, T-14 UR, T-15 GA/GB, T-16 mirror chore, T-17 vault (a person), T-18 first deploy, T-19 deploy-waits (done), T-20 flaky tests (done), T-21 V1 (done), T-22 Connect hang (done), T-23 btw real (done), T-24 tool rows and approvals formatting, T-25 notification mute rules, T-26 git monitoring inside workspaces + session Git view (owner, 07:5x), T-27 agentic commit trailers, verification and the author trace (lands with T-26; from now on every commit carries Pilot-Session and Pilot-Agent trailers by hand), T-28 ticket Bump button (owner, 07:58: push a ticket into a running session as a priority or a question), T-29 auto move per quota window and per model, with a model switch on the same Claude as an option (owner, 08:31), T-30 ticket buckets and knowledge buckets (vaults) assigned per session, with filters and agent scope (owner, 08:34), T-31 sub-agent output streams into the main reply (owner, 08:39; added to the T-5 slice), T-32 CI Bump to a session and auto-report of every finished run to the session that started it, moves followed (owner, 08:42; CI buckets added to T-30), T-33 rename every entity (workspace display names), T-34 Home dashboard as the first page (owner, 09:14).

Session in kubernetes/kohi-event (moved from hasyim to alfian.isnan at 06:45 after a session limit), main folder ~/work/claudepilot, branch integration. Three packages, one sub-agent each.

## DONE (pushed to integration and the pilot remote as 5bf433c at 08:17; gate green on 47dee48: 2451 tests, one load-flaky test passed alone and was made order-based)
- T-7 auto-move web half (B item 5): merged as 191edf7 (card, divider mark, Undo, session menu item, a Claude's dialog, tools/qa/automove.mjs 520/520 at 390 and 1280 px; PRD §14.1); gate green on e0f8728 (2451 tests, 0 failed), pushed 08:56 (T-7 closed). Not in deploy #4 (5bf433c): goes with the next one.
- B item 1, deploy waits -> "Deploy waits" notification (ci_waiting): 9dd73e8; migration 720 (existing devices that hear CI failures get it): ad0b7e6 via cc838d9.
- B item 6, tests that leak or flake, side-usage split: 41d4dc0 via cc838d9. B item 2, V1 canary guards + report: e818540, af7bf08.
- A items 1 and 2: the gate hang's cause (a stop landing while the agent dials; 7d41bc7), scratch-portal observations (f31f6ca) via e653847.
- T-9 phone chrome in every state (C2): merged as 64d7a96 (session-states.mjs 4596/4596, the four existing harnesses green); device checks E8-E11 for a person.
- C item 1, btw UI against the real engine (tools/qa/btw-real.mjs, the card says how many messages the answer saw): a97a950.
- Gate hygiene: shellcheck SC2015 (1f045fe), repo-find sorted (8b3316a), deploy-pipeline e2e test: the fakes' PATH in ~/.profile (b893ac8; /etc/profile resets PATH in a login shell and the real kubectl installed today at /usr/local/bin won; the test's wait now says which step failed). Passes alone 7/7.

## NOW (12:30)
- LIVE: portal 2026.10.13-4 (deploy #13, released by the coordinator; the owner skipped its gate, a gate Job on 8872b5a runs after the fact). Live tickets (closed): T-1, T-2, T-3, T-4, T-5, T-6, T-7, T-8, T-9, T-18, T-25, T-29, T-31, T-32 part 1, T-34, T-36, T-37, T-38, T-39, T-41, 005fab0 (delivery), migration 720.
- DEPLOY #14 (rmv6nqb6ea7ab43) on f13f9b5, gate=true: T-24 tool rows, T-28 ticket Bump, T-42 slice 1 (stable workspace id, migration 712), T-95 (the release pushes main alone, failure reports in the gate log, flaky notes, gate-job files, cancel attribution, migration 731), 6c1dd47 (gate Jobs never outlive their run). Its release is the first with T-95's script; still: push integration only after it released.
- Sub-agents: T-42 slices 2 and 3 (dev/workspace-id; slice 2 ecd6588 built, migration 713), T-32 part 2 CI Bump (dev/ci-bump), T-97 Browser pool on Kubernetes (dev/browser-k8s, rig dev-rig-browser).
- Next (in order): T-98 workspace Resources (high, wave 2), T-26 (three slices), T-27, T-30; wave 4 (T-10..T-15); T-33 last (after T-42).
- PACE (honest): 07:00-12:30, about 24 tickets' work merged (about 4.4 per hour); live since 12:2x for the first time today. Deploys today: 14 runs, 2 released (#13 and earlier #?), the rest failed on timing races or were cancelled to add fixes.

## NEEDS A HUMAN
- Live tickets to check on the phone: T-1 (Pinned, swipe), T-2 (no sideways scroll), T-3 (an image attaches in a cluster workspace), T-5/T-31/T-41 (sub-agents in their own rows, "Working · N agents", "Session finished" only at real idle), T-25 (Mute similar), T-34 (Home page), T-6 (MCP client labels), T-29 (auto move card words).
- Run deploy/k3s/seed-features.sh (PORTAL_URL and the server code): automove.allowBypass (T-4) and chat.trust.autoPermissionOnly (T-38) on.
- The coordinator relabels kubernetes/kohi-event to isnan-pod after T-42 slice 2 is deployed.
- ticket_claim_next hands out the Konfersi tickets (T-51) even with a tag filter; T-95, T-42, T-97, T-98 are not assigned to this session (comments refused).
- On the iPhone (Home Screen PWA, quiet hours off): "Deploy waits" arrives when a deploy holds for approval (migration 720 is live).
- Multi-user (parked, not in this backlog): the owner's current single-owner access (workspace kohi-event, this session) reserved for a user `admin`; the password was given in chat on 2026-10-13 and is written nowhere: when that work starts, the owner sets it through the setup token or a Secret.
- Decide whether the Usage page should show "of which side questions".
- T6 (Connect): whatever still needs Docker, macOS, Windows or a second cluster.

## WAVES (owner, 09:4x; work in this order)
- Wave 1: T-36 fast lane (DONE, pushed) -> push (done) -> T-38 folder trust (built) -> T-18 deploy (full gate on the exact commit) -> T-3, T-2 (fixed, merged; live with the deploy) -> T-31 (with the T-5 sub-agent) -> T-1, T-4, T-29 (merged; live with the deploy).
- Wave 2: T-37 gate as an in-cluster Job, T-5, T-6 (running), T-24, T-25, T-34 (running), T-16.
- Wave 3: T-32, T-28, T-26 + T-27, T-30. Wave 4: T-10, T-11, T-12, T-13, T-14, T-15; T-33 rename LAST, alone, with no branch open.
- Next free slot: T-37 (opus), then T-24, then T-25.

## IN FLIGHT
- Owner requests (07:00-07:50), committed on integration as d716245, bd91572 and 7c3d6d5, gate queued on 7c3d6d5 (T-1, T-2, T-3, T-4): (1) sideways scroll on the phone: not reproduced in Chromium (11 pages, 360/390/430/landscape, safe-area insets); the app root now clips horizontal overflow, mobile-drag.mjs checks it; (2) Pinned sessions: migration 381, POST/DELETE …/pin, chips Pinned · Idle · Needs you · Working · Ended · Archived · All, Pinned shown once anything is pinned and the default chip, else Idle; pinned leads its group; ⋯ Pin/Unpin on rows and the session page; a pin marker on the row; (3) swipe right = Pin, left = Archive (unarchive in Archived) on touch (swipe.ts, tested; tools/qa/session-swipe.mjs ran green on a scratch portal); (4) image upload "exit 4" (T-3): CAUSE FOUND: cp-session `put` began with `exec 2>/dev/null`; a Kubernetes exec (containerd) closes stdin once the last holder of an output pipe is gone, so head saw EOF at once; `put` keeps stderr's pipe open on fd 3 now (7c3d6d5), verified through the portal's own path (KubernetesRuntime + hostInstaller + stageFile) into the kohi-event pod with 6 MB; a test holds the pipe rule; a short arrival says "X of Y bytes arrived" and is tried once more. (5) automove.allowBypass (T-4, owner 07:2x): setting, decide rule, decide/engine tests, a controller test that a move keeps Bypass, PRD §16 decision, seeded on (7c3d6d5).
- Deploy (T-18): run #4 FAILED at the release after approval (integration had moved: the orchestrator pushed status commits while it waited); nothing deployed. Fixed in ffde31e (the release merges into a branch that moved on; deployPipeline.test 8/8). Next: gate on e7da20b green -> push (ffde31e verified by its own test file) -> a new deploy run on the head.
- T-5 + T-31 sub-agent visibility, and sub-agent text kept out of the main reply with "Idle · N agents" (opus, worktree dev-automove-web now on branch dev/subagent-visibility, scratch port 3421): model label per row, clickable detail view with the task's transcript and Stop, server task-transcript route and ChatTask.model.
- A item 3, T6 acceptance and abuse (opus, dev-track-a-connect, port 3413, rig namespace dev-rig-connect).
- C item 2, phone chrome all states (opus, dev-track-c-ui, port 3415).

## DECISIONS
- Coordinator 09:3x: integrate in small batches (gate and push every 8-10 commits or 2 hours); never `..` with a glob in a command path; scratch-portal.sh stop now ends the portal's children (fa0edd1, with a test); scripts/dev-rig.sh is the only door for dev-rig namespaces (merged 851a7ec); the next deploy is the priority (the live portal is 2026.10.13-2 and lacks allowBypass).
- 09:30 a release that waits for approval no longer fails when integration moves on (ffde31e); until a run with that script is the one waiting, do not push integration during an approval.
- 08:31 the owner switched this session to Opus 5.5: commits now end with `Co-Authored-By: Claude Opus 5.5` plus the Pilot trailers.
- T-29 defaults (PRD style, until the owner says otherwise): `automove.prefer = model` (keep the model, move Claude first), `automove.modelFallback` empty (never change model by itself until set).
- Owner (06:05): the auto-move web half runs ahead of N2 and N3.
- Model per slice (owner): sonnet for narrow checks, opus for implementation, fable only for hard diagnosis or after two failures.
- The gate fails a hung test after GATE_TEST_TIMEOUT_MS and reruns failing files alone; the cause is fixed in the package, not the gate.
- Status-file-only commits are pushed without a gate run (docs only). B's branch merges integration instead of rebasing. Merge commits are kept.
- A side question counts as a request for spike rules; "side" is a server-side split only (PRD claude-usage §22); the Usage page does not show it yet.
- Housekeeping at the move: two orphaned `yes` processes (a load simulation from B's worktree, 2 CPUs for 45 min) and the scratch portals 3405 and 3409 were stopped.

## NEXT
- T-29 is being built by the orchestrator itself in worktree dev-automove-model (branch dev/automove-model): decision, engine, card words and tests done (server 194 pass, web 9 pass); typecheck under the lock; then a browser look, PRD, merge.
- T-34 Home dashboard (opus, worktree dev-track-c-ui now on branch dev/home-dashboard, scratch port 3423).
- Full gate on e7da20b (phone chrome + T-29 + Connect T6) in its suite; the fast lane on the commits after it queued; both green -> push -> deploy with the pipeline's full gate.
- T-6 MCP client label (sonnet, worktree dev-track-a-connect now on branch dev/mcp-label, scratch port 3425).
- Next slices when a slot frees, in this order: T-24 tool rows (opus), T-26 + T-27 git monitoring with the commit trace (three opus slices: server scan + parsers + the commit hook and trailer parser; repos UI + overview + MCP tools + author sheet; session Git view), T-25 mute rules (opus), T-28 ticket Bump + T-32 CI Bump and auto-report (one opus slice, they share the picker), T-30 buckets for tickets, CI and knowledge (opus), T-33 rename everywhere (opus); then B3 N2, B4 N3, C3, A4, C4, C5.
- Merge each sub-agent branch as it reports, targeted tests, gate, push; after the deploy's verify: seed-features.sh (allowBypass), the iPhone checks (T-18, T-3).
- After the three slices: B item 3 (N2 web, opus), B item 4 (N3 triggers, sonnet/opus), C item 3 (CI screens, opus), A item 4 (T5 second pass, opus), then C items 4 and 5.
- First deploy of the day once integration is pushed with a green gate (ci_run_trigger, gate=false): the deploy-waits notification and migration 720 are user-visible.
