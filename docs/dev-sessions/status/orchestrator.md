# Orchestrator status (2026-10-13, session fdb140be, started 12:43 after an integrity ending of fe3df8bc: "a second control response")

Knowledge: vault "ClaudePilot dev" (6cd11f710cc3), folder Dev loop/. Tickets mirror this file: T-1..T-15 (packages A/B/C), T-16 mirror chore, T-17 vault,
T-18 deploy, T-24..T-34 owner requests, T-36/T-37 lanes and gate Jobs, T-38..T-42, T-95 deploy pipeline, T-97 browser on Kubernetes, T-98 workspace
Resources, T-99 harness turn + CI after a restart, T-100 Sessions list, T-101 ticket attachments, T-102 session screen chrome. This session holds
T-24, T-32, T-42, T-95, T-97, T-98, T-99, T-100, T-101, T-102 (claimed with ticket_claim_next id=...). Models: opus implementation, sonnet checks, fable diagnosis.

## LIVE
- Portal 2026.10.13-5 (deploy run 17, released 13:4x; gate green in 282 s at dca2a99 with /tmp in memory, was 31+ min). Live: T-24, T-28, T-32 part 2,
  T-42 slices 1-2 (the workspace is labelled isnan-pod, stable id ws_7fea17373588, runtime ws-kohi-event kept), T-95 items 1-3, plus everything of -4.
- Run 14 cancelled (pod restart for requests 1 CPU / 2 GiB; automove.allowBypass ON), run 16 red on qa/runtimes.test.ts (fixed as dca2a99).

## DONE THIS SESSION (741ff4d pushed to origin and pilot by the coordinator at 13:13 with a deploy run, full gate; T-99 merged locally after it)
- 77c0e33 merge origin/integration (scripts/ws-resources.sh, the coordinator's narrow door; README rule).
- 4f5d9c0 merge dev/ci-bump: T-32 part 2, Bump a CI run into a session (Fix or Ask), ci_run_bump, tools/qa/ci-bump.mjs (6afaf91, opus).
- 97d25c7 merge dev/workspace-id: T-42 slice 2, name = label, aliases, workspace_rename, migration 713 (ecd6588, opus).
- 741ff4d T-95 item 3: the gate Job's /tmp is an emptyDir in memory (3Gi; requests 2Gi, limit 8Gi); deployPipeline.test 10/10. Numbers come
  from the next deploy's gate (compare: 31+ min, 16 first-pass failures on the overlay).
- T-99 on branch dev/t99-harness-turn (8774b5c, by the orchestrator, fable; worktree dev-track-c-ui): a turn Claude Code starts by itself after a
  sub-agent (command_lifecycle started, never queued) is accepted only when a task ran in this process, remembered as control line harness/<uuid>;
  CI reinstalls cp-ci when a run gives no reply or 126/127 with a missing or stale file, a stopped workspace forgets the mark. host.test 4/4,
  integrity tests 3/3, ci tests 35/35, server typecheck clean. Merged locally as 73b0c67 with 0520dd2: the raw runtimes refuse an empty name
  again (T-42 slice 1 let "" through: the `?.` call skipped plainName; expect the coordinator's gate to fail on qa/runtimes.test.ts, 2 tests)
  and chat/host.test no longer inherits this pod's PILOT_* env. The fast gate on 97d25c7: 2548 pass, 5 fail (3 load-flaky, passed alone).

## IN FLIGHT (three sub-agents, opus, dispatched 12:50)
- T-42 slice 3 (stored refs move to the stable id: tickets + the background rewrite, migration 714; then sessions, pool assignments, agent access,
  CI remotes as far as an hour allows): worktree dev-track-a-connect, branch dev/workspace-id, label workspace-id. Migrations 714-715.
- T-97 browser pool on Kubernetes (B3): worktree dev-automove-web, branch dev/browser-k8s (WIP committed as 9fca355), rig dev-rig-browser. Migrations 735-736.
- T-98 workspace Resources: worktree dev-gate-job, branch dev/workspace-resources from 97d25c7, label workspace-resources. Migrations 716-717.

## NEXT (in order: the coordinator's rank-NN tags, 13:33; ticket_list tag=rank-NN lists them)
- rank 01 T-42, 02 T-95, 03 T-99, 04 T-102, 05 T-100, 06 T-98, 07 T-97, 08 T-101, 09 T-28, 10 T-32, 11 T-24, 12 T-26, 13 T-27, 14 T-30, 15 T-33,
  then T-12, T-13, T-10, T-11, T-14, T-15. De-duplication: ONE fit check (T-98 builds workspaces/fit.ts first; T-97 and workspace create use it;
  scripts/ws-resources.sh and its allow rule go when T-98 lands); T-100 uses the existing chip code (no ChipList, T-14 later); T-12 does only
  what T-95 item 2 and T-32 left; T-102's queued or automatic restart keeps Bypass or does not happen; T-33 rewritten (id + `label` per entity;
  the workspace rename is T-42's). Running sub-agents were told (13:37).
1. Pushed after run 17's release: T-99 (rank-03) is on integration; the next deploy carries T-99, T-102, T-100 and whatever lands before it.
2. First free slot: T-102 session screen (item 1 first: the Tools changed chip with Restart after this turn, auto-apply for autonomous sessions,
   Bypass kept; then popover placement; then header blur and badge). Then T-100 Sessions list (clipped cards, attention order; existing chips).
   Then T-101 ticket attachments (reuse chat uploads; paste/photo path first, viewer second). Migration blocks: T-101 750-754, T-102 755-756 if any.
3. Then T-26 git monitoring (three slices, with T-27's commit hook; block 740-744), T-30 buckets (745-749), T-40 CI remote MCP tools, wave 4
   (T-10..T-15), T-33 rename LAST alone.
- After each merge: gate-quick under the lock, push origin and pilot. Full gate every two hours as a Job. One deploy a day at most; the next one
  carries T-42 slice 3, T-97, T-98, T-100, T-102 as they land.

## NEEDS A HUMAN
- APPROVE the deploy started by this session (the run number is on T-42 and below once started). Then check on the phone: tool rows (T-24),
  ticket Bump (T-28), CI Bump (T-32), the workspace sheet's Name and ID rows and a rename (T-42), that this chat survives a finished sub-agent (T-99).
- The coordinator relabels kubernetes/kohi-event to isnan-pod after the release (workspace_rename or the sheet).
- Live tickets to check on the phone (deploy #13): T-1 Pinned and swipe, T-2 no sideways scroll, T-3 image upload, T-5/T-31/T-41 sub-agent rows,
  T-25 Mute similar, T-34 Home page, T-6 MCP client labels, T-29 auto move card.
- Run deploy/k3s/seed-features.sh: chat.trust.autoPermissionOnly (T-38) on (automove.allowBypass is on already).
- "Deploy waits" on the iPhone when a deploy holds for approval. Multi-user (parked): the `admin` password lives nowhere. Usage page "side
  questions": decide. T6 (Connect): whatever needs Docker, macOS, Windows or a second cluster.
- After T-97 is deployed: set PORTAL_K8S_BROWSER_IMAGE in deploy/k3s/portal.yaml and assign a Browser pool to kohi-event (the report says the tag).
- The previous orchestrator session ended on "a second control response for request 2e919c3c" (controller #acceptControlResponse: a reply to a
  request already completed): not in T-99; the raw lines are in ~/.claudepilot/sessions/fe3df8bc-…/out.*.jsonl if it happens again.

## DECISIONS
- 13:25 (coordinator) Deploy run 16 went red in the gate on qa/runtimes.test.ts (the empty-name bug of T-42 slice 1); fixed upstream as dca2a99
  (merged here as a64886b, taking the upstream lines over 0520dd2); run 17 deploys dca2a99. LESSON, binding for every slice brief and merge: run the
  touched AREAS' tests (src/qa, src/workspaces, the module's neighbours) before a merge, not only the slice's own files. The gate Job with /tmp in
  memory takes about 6 minutes (was 31+): T-95 item 3 numbers go on the ticket when run 17's gate reports.
- 12:45 Deploy #14 was invisible to this session's token (ci_runs_list empty); the coordinator later cancelled it. Integration is pushed after a
  green fast gate; the release merges into a moved tip (ffde31e).
- 12:48 The earlier session's uncommitted work (T-42 slice 3, T-97) is finished by new sub-agents in the same worktrees; T-97 committed as WIP first.
- 13:05 T-99 built by the orchestrator itself (all three slots busy, the deploy waits on it); T-100, T-102, T-101 go to sub-agents in that order.
- 13:10 One deploy now with T-42 slices 1-2 (the owner's blocker), T-95 and T-99; T-100 and the rest go in the next one.
- Migration blocks today: T-42 710-715, T-98 716-717, B 720-729, C 730-734, T-97 735-736, T-26/27 740-744, T-30 745-749, T-101 750-754.
- Earlier (kept): the gate fails a hung test after GATE_TEST_TIMEOUT_MS and reruns failing files alone; status-only commits are pushed without a
  gate; merge commits are kept; T-29 defaults automove.prefer = model, modelFallback empty; a side question counts as a request for spike rules.
- Commits: `Co-Authored-By: Claude <noreply@anthropic.com>` (sub-agents) or `Claude Fable 5.1` (orchestrator) plus Pilot-Session and Pilot-Agent (T-27).
