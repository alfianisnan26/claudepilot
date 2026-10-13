# Orchestrator status (2026-10-13, session fdb140be, started 12:43 after an integrity ending of fe3df8bc)

Knowledge: vault "ClaudePilot dev" (6cd11f710cc3), folder Dev loop/. Tickets mirror this file: T-1..T-15 (packages A/B/C), T-16 mirror chore, T-17 vault,
T-18 deploy, T-24..T-34 owner requests, T-36/T-37 lanes and gate Jobs, T-38..T-42, T-95 deploy pipeline, T-97 browser on Kubernetes, T-98 workspace Resources.
Main folder ~/work/claudepilot, branch integration. Models per slice: opus for implementation, sonnet for narrow checks, fable only for hard diagnosis.

## LIVE
- Portal 2026.10.13-4 (deploy #13). Live (closed): T-1..T-9, T-18, T-25, T-29, T-31, T-32 part 1, T-34, T-36..T-39, T-41, migration 720.
- DEPLOY #14 (rmv6nqb6ea7ab43, on f13f9b5, gate=true): T-24, T-28, T-42 slice 1 (migration 712), T-95 (migration 731), 6c1dd47. Its build Job finished
  12:19; nothing is live beyond -4 and origin/main is still at f1a6553, so it WAITS FOR THE OWNER'S APPROVAL (this session's token cannot see CI runs:
  ci_runs_list is empty, ci_run_get says no such run). The coordinator pushed 97b4c51 to integration at 12:41 while it waited: the release merges into
  the moved tip (ffde31e) and main gets the approved commit plus tags.

## DONE THIS SESSION (local integration, not yet pushed; fast gate running on 97d25c7)
- 77c0e33 merge origin/integration (scripts/ws-resources.sh, the coordinator's narrow door; README rule added).
- 4f5d9c0 merge dev/ci-bump: T-32 part 2, Bump a CI run into a session (Fix or Ask), ci_run_bump, tools/qa/ci-bump.mjs (6afaf91, opus).
- 97d25c7 merge dev/workspace-id: T-42 slice 2, name = label, aliases, workspace_rename, migration 713 (ecd6588, opus).

## IN FLIGHT (three sub-agents, opus, dispatched 12:50)
- T-42 slice 3 (stored refs move to the stable id: tickets + the background rewrite, migration 714; then sessions, pool assignments, agent access,
  CI remotes as far as an hour allows): worktree dev-track-a-connect, branch dev/workspace-id, label workspace-id. Migrations 714-715.
- T-97 browser pool on Kubernetes (B3): worktree dev-automove-web, branch dev/browser-k8s, label browser-k8s, rig dev-rig-browser, scratch port > 3430.
  The previous sub-agent's uncommitted work (kube.ts, convergeKube, seedHomeScript, sandbox auto) is committed first as WIP. Migrations 735-736.
- T-98 workspace Resources (CPU and memory from the portal, apply now or at next restart, fit check, audit): worktree dev-gate-job, new branch
  dev/workspace-resources from 97d25c7, label workspace-resources, scratch port > 3440. Migrations 716-717.

## NEXT (in order; one slot frees -> dispatch the next)
- T-26 git monitoring (three opus slices: server scan + parsers + the commit hook and trailer parser (T-27); repos UI + MCP tools + author sheet; session Git view).
- T-27 lands with T-26. T-30 buckets (tickets, CI, knowledge) per session (opus). T-40 Portal MCP tools to create and connect a CI remote (opus, small).
- Wave 4: T-10 N2 web, T-11 N3 triggers, T-12 CI screens, T-13 Connect T5 second pass, T-14 UI resilience, T-15 onboarding. T-33 rename LAST, alone.
- After each merge: gate-quick under the lock, push origin and pilot. Full gate (scripts/gate-job.sh) every two hours on integration's head.
- Next deploy once T-42 slice 3 + T-97 + T-98 are in and the full gate is green (one a day at most; #14 must have released first).

## NEEDS A HUMAN
- APPROVE DEPLOY #14 in the portal (CI > Remotes > claudepilot > run #14): T-24, T-28, T-42 slice 1, T-95. Then check on the phone: tool rows with
  Input/Output blocks (T-24), ticket Bump (T-28), the workspace sheet shows the id (T-42).
- Live tickets to check on the phone (from deploy #13): T-1 Pinned and swipe, T-2 no sideways scroll, T-3 image upload in a cluster workspace,
  T-5/T-31/T-41 sub-agent rows, T-25 Mute similar, T-34 Home page, T-6 MCP client labels, T-29 auto move card.
- Run deploy/k3s/seed-features.sh (PORTAL_URL and the server code): automove.allowBypass (T-4) and chat.trust.autoPermissionOnly (T-38) on.
- The coordinator relabels kubernetes/kohi-event to isnan-pod after T-42 slice 2 is deployed (workspace_rename or the sheet).
- Tickets: this session's token cannot claim or comment on T-42, T-95, T-97, T-98 (FORBIDDEN, "claim with ticket_claim_next", which hands out
  Konfersi tickets instead). Assign them to session fdb140be, or accept this file as the record. T-95 and T-24/T-28/T-32 can be closed once #14 is live.
- "Deploy waits" on the iPhone (Home Screen PWA, quiet hours off) when a deploy holds for approval.
- Multi-user (parked): the owner's single-owner access reserved for a user `admin`; the password was given in chat and is written nowhere.
- Decide whether the Usage page should show "of which side questions". T6 (Connect): whatever needs Docker, macOS, Windows or a second cluster.
- After T-97 is deployed: set PORTAL_K8S_BROWSER_IMAGE in deploy/k3s/portal.yaml and assign a Browser pool to kohi-event (the sub-agent's report says the tag).

## DECISIONS
- 12:45 Deploy #14 is invisible to this session; integration is pushed anyway after a green fast gate (ffde31e makes the release merge into a moved tip,
  and the coordinator already pushed past f13f9b5). Nothing else waits for #14 except the next deploy.
- 12:48 The earlier session's uncommitted work (T-42 slice 3, T-97) is finished by new sub-agents in the same worktrees, not redone; T-97 commits it as
  WIP first so nothing is lost.
- Migration blocks today: T-42 710-715, T-98 716-717, B 720-729, C 730-734, T-97 735-736.
- Earlier (kept): the gate fails a hung test after GATE_TEST_TIMEOUT_MS and reruns failing files alone; status-only commits are pushed without a gate;
  merge commits are kept; T-29 defaults automove.prefer = model, automove.modelFallback empty; a side question counts as a request for spike rules.
- Sub-agents commit with `Co-Authored-By: Claude <noreply@anthropic.com>` plus the Pilot-Session (fdb140be-…) and Pilot-Agent trailers (T-27).
