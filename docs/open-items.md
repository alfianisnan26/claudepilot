# Open items (state at the stop of 2026-10-12)

The multi-agent round was stopped on purpose: the account quota ran out (the agents' last API errors said the session limit resets at 11:10 UTC). Everything that was safe is committed on branch `integration` and pushed; unfinished code is parked on a WIP branch; the coordination files are snapshotted under `docs/coord/`. Nothing here is a promise that a feature works: the status column says what was verified and how.

## 1. Where things are

| What | Where |
| --- | --- |
| Shippable work of this round | branch `integration` (pushed), checkpoint commits per area |
| Last release before this round | `main` at `872a429` |
| Unfinished multi-user identity core (MU1), authorization evaluator (MU2), auto transfer web half (N4) | branch `wip/stopped-by-quota-20261012-0712` (pushed; migrations 400-401 are NOT released) |
| Coordination state (plans, prompts, status, ledgers) | `docs/coord/` (restore with `bash docs/coord/RESTORE.sh <dir>`; every agent's RESUME block is in `docs/coord/RESUME-BLOCKS.md`) |
| Deployed | release `cc02126` (tag `release-20261012-cc02126`, `main` fast-forwarded) runs on the owner's Docker (context `host`) behind Caddy at https://pilot.dev.isnan.me; live schema 380; Connect on. Record, rollback and backups: `docs/coord/deploy-ledger.md` |
| Old branches `backup/pre-rewrite-*` | local only; they contain a flagged token: never push, deleting them is the owner's call |

## 2. How to resume (after the quota resets)

1. `bash docs/coord/RESTORE.sh /tmp/coord` (or any scratch dir); read `ROSTER.md`, `TODO-coordinator.md`, `COMMIT-DEPLOY.md`, `DELEGATION.md`, `PLAN.md` sections 4-7 and `PLAN-2.md` section A in it. Agent ids from the old session are gone: start new agents from `prompts/<id>.md` (each prompt says which status file to continue from).
2. Keep concurrency low. Thirteen agents in parallel, six of them fable at high effort, used the whole window in about four hours. Suggested: at most six at a time, planners one or two at a time.
3. Resume order: finish and verify what is half built (section 3), then the acceptance and abuse suite for Connect (T6) before Connect is exposed anywhere, then the queue (section 4).
4. Rules that stay: agents never commit or deploy; no token-shaped literal in the repo (build fixtures at runtime; `docs/coord/scan-show.mts` shows flagged lines); never label throwaway containers `claudepilot.managed`; heavy jobs under `flock heavy.lock`; scratch portals start from `env -i` and never see the real kubeconfig or Claude profile.

## 3. Built, but stopped mid-work (resume first)

| Track | State when stopped | Next |
| --- | --- | --- |
| Connect server (T1) | registry, hub, routes, REST and wiring landed and answer; the remove query is now `onWorkspaces=keep|remove`; was editing the hub listener, `Runtimes.onLost`, the seam member and module wiring; the portal now re-checks a target when it returns (`workspaces.recheck`) | stub agent and perf test (T-PERF), a scratch-portal run in a clean env, a test that a returned target is Running at once, a token-less upgrade endpoint (request from T5) |
| Connect agent (T2) | agent core, Docker/Kubernetes/host proxies, enrollment, generated bundle (`connect/agent.generated.ts`, regenerate after any agent change); symlink entry bug fixed | remaining service tests; `docker/limits.test.ts` hung for 8 minutes in a loaded full-suite run (passes alone): reproduce with `--test-concurrency=3` |
| Connect installers (T4) and rig and acceptance (T6, not started) | installers built (48 tests, shellcheck clean); never run end to end against the final agent | T6: acceptance A1-A14, abuse and failure injection, installer on rig hosts, Windows and macOS on real devices. Do this before Connect is reachable from the internet |
| Connect web (T5) | Targets page and wizard work against a real portal and agent, light mode, 390 and 1280 px | second pass list in `docs/coord/TODO-coordinator.md` ("T5 SECOND PASS"): dark mode, other widths, offline/revoked rows, Kubernetes/Host/Windows/macOS steps, Remove question and 428 follow-up, hostile data |
| Version pin and canary (V1) | pin, UI, routes, scheduler, canary landed | add the four safe-mode guards to the canary (flag present, hook marker test, `get_usage` still answers, env var is not a substitute); make `claudeversion/service.test.ts` deterministic; final report |
| Notifications web (N2) | service worker push, subscriptions, preferences in progress | finish against the real routes, Bell unread count, action authentication check, real-device checklist |
| Triggers (N3) | cron, webhook receiver (`/hooks/:token`), providers, limits, run history; module registered in `platform/index.ts` | scratch-portal verification, UI, abuse tests, unwired parts (see its status block) |
| Auto transfer (N4) | server landed (routes, migration 220, settings `automove.*`, tool; off by default) | web half is on the WIP branch (suggestion card, divider mark, undo, settings; one test type error in `pure.test.ts` line 15) |
| Multi-user W1 (MU1, MU2) | on the WIP branch: identity pieces (passwords, throttle, sessions, devices, users) and the evaluator/policy files. MU1's edits to `platform/audit.ts` and `platform/routes.ts` (the audit columns `outcome`, `ip`, `protected` of migration 401, and the `actor`/`outcome` filters) were reverted on `integration` because migration 401 is not released: re-apply with `git diff c887bef 7f4efdd -- apps/server/src/platform/audit.ts apps/server/src/platform/routes.ts \| git apply` together with the migration | restore from the branch, finish per `docs/coord/p5-workbreakdown.md` (MU1, MU2). The first multi-user release changes sign-in: the owner must hold the setup token and approve it. **Owner (2026-10-13):** the first multi-user release reserves everything the single owner has today (the workspace `kubernetes/kohi-event`, the orchestrator's chat session, every pool and setting) for an admin user named `admin`; the owner gave its initial password in chat, it is NOT in the repository: the seed takes it from an environment variable or a Secret the owner sets, never from a file |
| Planners P3 (evidence/annotations/code viewer), P4 (ops), P7 (data placement audit), P9 (MCP both ways and gateway) | partial or no output: P4 and P9 died on the limit almost at once, P3 and P7 were stopped | start again from their prompts; check `docs/prd/` for what landed |

## 4. Not started (queue, in the order intended)

T6 (Connect rig and acceptance) -> S2b (btw UI against the real engine; the engine is verified, the UI only against a scripted socket) -> T5 second pass -> K2 and K3 (Codespaces devcontainer side, transport comparison; libsodium decision) -> GA and GB (onboarding and guidance) -> UR and US (UI resilience components, lab, screen migration) -> D1 and D2 (delegation policy) -> AG1 and AG2 (agent map) -> P6 (dev tools plan), P8 (VS Code plan and PoC) -> U5 and U6 (usage per user, after multi-user phase 1) -> MU3-MU20 (multi-user retrofit, in a quiet window; `docs/coord/p5-workbreakdown.md`) -> Q2a, Q2b, Q2c (QA, last, in a quiet window; "before" = `872a429` built in a clean copy).

Platform phases 2 and 3 (delivery flow, safety net, scale and search) are planned only: `docs/prd/platform-roadmap.md`.

## 5. Owner decisions waiting

Each has a recommended default in its PRD; agents used the default and said so.

- Multi-user MO1-MO15 (`docs/prd/multi-user.md` section 16): password length, setup token display, who may invite, admin privacy, and the rest. The first multi-user release also needs the owner holding the setup token.
- Platform O1-O12 (`docs/prd/platform-roadmap.md`) and Connect O1-O9 (`docs/prd/targets-connect.md`): public image registry, a second Cloudflare Access hostname for agents, pools and secrets default off for single hosts.
- Gitea public client ID for guided sign-in; adopting the workspace named `test`; the libsodium dependency for Codespaces enrollment; whether to add the `unsupported` problem code for a too-old Claude Code (contracts `UsageProblem` and `PROBLEM_WORDS` in the same change).

## 6. Known problems and risks

- `qa/boot.test.ts` leaves portal processes running when it fails or hangs: three `cp-qa-boot-*` portals burned 50-97 % CPU for 30 minutes during the round and made the load average climb. Kill the child in a `finally` and add a timeout.
- Flaky under load, pass alone: `browser/gate.test.ts`, `claudeversion/service.test.ts` ("at most two per pass").
- Real-device checks are not done and cannot be done here: iOS Safari keyboard and bottom sheet (btw), Home Screen push, screen readers. The checklist items are in `docs/coord/s2-checklist-items.md` and should be merged into `docs/prd/platform-roadmap.md`.
- Dark mode, 768 and 1920 px, and several wizard and list states were not looked at for the Connect web UI.
- Usage side questions: `usagespend` should subscribe to `chatController.onSideUsage` and split by `chat_usage.kind='side'`.
- Incidents disclosed during the round: two scratch portals saw the real kubeconfig for a short time (read-only listing, nothing created); one scratch portal inherited the owner's Claude profile (profile file rewritten by Claude Code, backup kept); a Docker pull briefly started on the Mac host Docker (killed); one early test run may have sent test data to a public address (no credentials).
- Commits are unsigned (no GPG key in the sandbox).

## 7. Release notes of this stop (2026-10-12)

- The release gate on a clean copy caught a real defect before deploy: platform audit code expected columns from the unreleased identity migration (two tests failed with "no such column: outcome"). The audit files were restored to their pre-identity version; both tests pass.
- Connect (agents that dial out) was first shipped OFF and then turned ON at the owner's request (release `ab65734`: `PORTAL_CONNECT_URL`, and `PORTAL_CONNECT_CA_FILE` pointing at a copy of Caddy's public root certificate in the data volume, needed because `PORTAL_TLS=internal`). Its full acceptance and abuse suite (T6) has NOT run: the control plane answers wherever the portal's address is reachable. Kill switch: `PORTAL_CONNECT_ENABLED: "false"` in `deploy/compose.yaml`.
- Not part of this deploy: the workspace image (`images/workspace`, Claude Code pin and `cp-session`): rebuild it from the portal when convenient; the running `test` workspace has Claude Code 2.1.296, which the new usage probe (`--safe-mode`, needs 2.1.169 or newer) accepts.

- After the deploy: the pre-deploy backup of the portal data and secrets is in the sandbox (`/tmp/pre-deploy-backup-20261012-0728`, mode 0600) and in the host volume `claudepilot-backup-20261012-0728`; it holds the production database and key, so delete both once the release is accepted. Previous images stay as `claudepilot-portal:previous` and `:prev2`.
- Not restarted: the owner's dev portal (tmux `portal`): `tmux new-session -d -s portal -c /workspaces/claudepilot 'npm run dev'` starts it and migrates `.data` forward (automatic pre-migrate backup).

## 8. The isnan k3s cluster (second deployment, 2026-10-12)

- Runs at https://pilot.ai.isnan.me (internal DNS only), namespace `isnan-claudepilot`, Argo CD Application `isnan-claudepilot` (project `isnan`, source: this repository, `deploy/k3s`), workspaces as pods in `isnan-claudepilot-workspaces`. Files and the by-hand steps (Secrets `claudepilot-server` and `claudepilot-secret-key`, the in-cluster kaniko builds, why pushing images from outside fails): `deploy/k3s/README.md`, `deploy/k3s-build/`.
- Sign-in code: `00000000` (the owner asked for 0000000; the portal needs exactly 8 characters). Weak on purpose for a lab: change the Secret `claudepilot-server` and restart the portal.
- Optional features turned on with `deploy/k3s/seed-features.sh` (triggers, auto move including automatic, agents self-edit). Left off: bypass sessions, auto move to an API key, MCP lockdown switches, the "This machine" target.
- The Argo Application was applied by hand; to put it under the fleet, copy `deploy/argocd/claudepilot.yaml` to `apps/isnan/isnan-claudepilot.yaml` in the isnan-infra repository.
- Found on the cluster: the Kubernetes runtime's `seed-home` init container failed on k3s local-path volumes; fixed (`cp -a --no-preserve=all`) in commit 7835b9c, image `2026.10.12-3`. The API refused `DELETE /api/workspaces/<id>` with 403 for a plain signed-in session: check what confirmation the web sends.

## 9. Housekeeping

- Scratch dirs and prefixes in `/tmp` from the round (`cx*`, `n1-n4`, `bt*`, `vc*`, `ua*`, `ub*`, `gt*`, `gu*`, `pc*`, `mu*`, `cp-qa-boot-*`, `cp-fake-claude-*`) can be deleted; containers from agents live only in the sandbox's own Docker.
- The owner's dev portal (tmux `portal`, `npm run dev`) was paused during the round so no half-finished migration touched `.data`. When it is started again it migrates `.data` forward with an automatic pre-migrate backup.

## 10. Update 2026-10-13 (a second round, from the cluster)

**Deployed** to the isnan cluster (https://pilot.ai.isnan.me, Argo CD app `isnan-claudepilot`, `main`): portal image `2026.10.13-1` at commit `2a9affb`, schema 610. Gate on a clean copy: 2421 tests, 0 failed. What is in it:
- Kubernetes delivery (pools, MCP sets, secrets, skills, personas, context and the chat host reach pods): `workspaces/kubernetesDelivery.ts`. Seen working on the real cluster: creating the CI remote installed the runner into the dev workspace as `root:root 755` in `/etc/claudepilot/bin`. Still to try on a throwaway workspace: an MCP set in `/etc/claude-code/managed-settings.d`, and redelivery after a scale 0 to 1.
- Chat: Restart without losing context (`POST /api/chat/sessions/:id/restart`), Bypass kept across a Move and a restart, the Auto permission mode (`docs/prd/chat-sessions.md` section 21). Automatic moves also keep Bypass: an open question for the owner.
- Phone UI for the iPhone PWA (`docs/prd/web-app-pwa.md` section 10.5 has the real-device checklist E1-E7).
- The deploy pipeline `.pilot/deploy.yml` (gate, build, release held for a person's approval, verify, rollback) and its approval (FR41, migration 610). Dry run seen end to end on the cluster (run #1: gate and build dry, release waited, was approved, verify read the live Argo CD state); the first real run is run #2.
- Dev kit: `CLAUDE.md`, `.claude/settings.json` and commands, `docs/dev-context.md`, `docs/dev-session.md`, `scripts/{gate,k3s-build,k3s-status,scratch-portal}.sh`, `images/workspace/Dockerfile.dev`. The kaniko build jobs ask for 100m CPU (they stayed Pending at 500m on a node whose requests were 96% allocated).
- Hermes agents Riski (`isnan-hermes`) and Afgan (`konfersi-hermes`) are connected to the pilot MCP: a read-scope Portal MCP token in each agent's `/opt/data/.env` as `PILOT_MCP_TOKEN` (labels `hermes-isnan`, `hermes-konfersi`, 90 days: **renew before about 2027-01-11**), and `mcp_servers.pilot` in their config through GitOps (isnan-infra !79, konfersi-infra !24, merged; `hermes mcp test pilot` says Connected, 93 tools, in both). The skill `claudepilot-pilot` is installed in both (what pilot is, the rules, the tool list; Afgan's also has the outline of moving Konfersi's development here, to be started only on a human's instruction). Afgan has no GitLab token of its own: infra changes for it go through Riski's or a person's.

**Found while starting the first autonomous session in the cluster** (fixed in `ecf3092`): a session that ran a command in the background was ended for integrity when the command finished. Claude Code reports that as a user line it marks `origin: {kind: task-notification, producer: session-task}`; the replay check now accepts exactly that origin and still refuses every other. Other synthetic origins (a scheduled wake-up, a monitor event, a cron fire) may exist: a failure now names the origin, so the next one is easy to judge.

**Autonomous development sessions** (`docs/dev-sessions/`): the protocol and three tracks (A Connect, B deploy notification, notifications, triggers, version pin, auto move and flaky tests, C the phone and desktop UI), in Bypass mode, each in its own worktree of the dev workspace `kubernetes/kohi-event`. The owner approves deploys only: a deploy waits in the portal (CI run page) until a person presses Approve; no tool approves. A session in that workspace still holds cluster-admin `kubectl` and the owner's GitHub token, so the approval guards the pipeline, not the shell (`docs/dev-session.md`).

**Still open from this round**
- The weak sign-in code `00000000` (Secret `claudepilot-server`): rotate it.
- A GitLab token with write access for the dev workspace (today it has the read-only Argo CD one); not needed for ClaudePilot's own work, which is on GitHub.
- Real-device checks on the iPhone (E1-E7), the Light-mode dark band under the status bar (UX1 decision), removing and re-adding the Home Screen icon after the viewport change.
- The pre-deploy backups of the Docker deployment (delete after acceptance); the probe image `claudepilot/probe` in the registry; the leaked htpasswd bcrypt hash disclosed earlier.
- Commits are unsigned (no GPG key).
