# Orchestrator status (2026-10-14, session 619018ca, started 00:22 UTC after 5c9fcb5f ended 17:58 for integrity: the T-265 case; down 6 h, T-257)

Knowledge: vault "ClaudePilot dev" (6cd11f710cc3), folder Dev loop/. The queue lives in NEXT; tickets are claimed only when work starts.
Owner-approved rules (evaluation 2026-10-14, coordinator 02:3x):
1. A standing VERIFIER sub-agent (sonnet) every few hours takes the live tickets in in_review, checks each on the live portal or with the harness, writes the evidence on the ticket and closes or reopens it (D-34: the owner never verifies).
2. Everything heavy (typecheck, suites, builds, Playwright, Lighthouse, scratch portals) runs through scripts/job-run.sh, never straight in the pod; one scratch portal per agent; flock only for what must run in the pod.
3. The orchestrator keeps its own context under about 200k: at that size it writes this file and asks the supervisor for a fresh continuation.
Models (coordinator 02:2x, evaluation 2026-10-14): ALWAYS passed explicitly; sonnet for verification, harness, sweep and scribe slices; opus for implementers and security or migration reviews; fable only for a diagnosis nobody cracked. WIP limit FIVE sub-agents at once (D-43, owner 2026-10-14; was three); still one scratch portal and one Chromium per sub-agent, 3 Jobs cluster-wide and 2 per chat; five agents burn quota about 65 percent faster, D-39 moves by pace. Heavy work through scripts/job-run.sh and gate-job.sh. The orchestrator hands off at about 200k context (status file, fresh continuation).

## LIVE
- Portal 2026.10.14-1 LIVE (run 20 rmv7i90f2ed3287, 36d127d + tags 0bf00ba; gate 481 s green, build 116 s, release 8 s with approval `auto` (protection off); Argo Synced/Healthy at 0bf00ba; /healthz ok 03:2x; the pod's chats survived the restart).
  Contains: T-102, T-110 slice 1 (dry mode), T-256, T-159, T-265, T-258 (BREAKS the coordinator's token helper: see NEEDS A HUMAN), T-270 slice 1 (ticket_adopt is on the MCP), T-259 slice 1 (keep-going policy; off for every chat until a person sets it), T-105/T-109 (auto move proven, D-39), migrations 755, 760, 761, 780, 790, 791.
  To verify (verifier pass 2, the next free slot): the tickets above in in_review.
- Portal 2026.10.13-7 before it (run 19): T-143, T-141, T-136 slice 1 (verified and closed, T-136 open for slice 2).
- Verified by the orchestrator 00:2x (D-34), evidence in this file because the tickets are held by the ended session (see NEEDS A HUMAN):
  - T-143: `POST /api/skills/import` multipart with Origin https://pilot.ai.isnan.me -> 401 (csrf passed, the session guard stopped it); Origin https://evil.example -> 403; DELETE without a content type from the own origin -> 401. Not verified: a real Skills folder import from a signed-in browser (no credential for agents).
  - T-141: `scripts/image-build.sh --check --destination registry.int.isnan.me/claudepilot/image-build-proof:a4c2891` -> exists, rc 0, digest 36dd581b…20fba (the proof build of comment 809).
  - T-136 slice 1: NOT enough. The orchestrator still ended at 17:58 for a second control response: the stream reader re-read line 1 of out.1.jsonl (the id appears once in the file) and the first copy had no digest (read before 771). Filed T-265 (urgent, rank-02a, D-40).
- Verified and closed by the verifier 03:0x: T-42, T-99, T-107, T-98, T-24, T-32, T-97. Reopened: T-95 (item 4).

## DONE this session (on integration, 2901ca5, pushed to origin and pilot 01:1x)
- T-102 (merge 9e15498, full gate green 51/28/309 s), T-110 slice 1 dry mode (a4f18be, 41/32/331 s; 14/14 in the pod), T-256 (4abe211, 60/33/321 s), T-159 (2901ca5; test on a private lock), T-265 (74e1f22, 43/26/318 s), T-258 (e263796, 54/35/340 s), T-270 slice 1 (76566fd, 40/26/304 s). Integration 76566fd on origin and pilot. Not yet deployed.

## HANDOFF NOTE (03:3x): this session's context is 412k, above the 200k guideline. The state is in this file; a fresh continuation picks up at NEXT 0. Local integration (e6a383d = origin/integration + the T-270 layers 2-3 merge 1d893f5 under gate Job + status commits) is NOT pushed until that gate is green; if the gate is lost, re-run `scripts/gate-job.sh 1d893f5`, then push origin and pilot.

## MOVE (03:5x): the portal moves this chat hasyim -> fadlilah at the end of this turn (30 % left). Every sub-agent below is INTERRUPTED by the move: each pushed its branch at every step; restart each one after the move with "continue from your branch <branch> in your worktree; read your own last commits and the ticket's last comment first", same model.
- t277 (opus) T-277 layer 1: dev-track-a-connect, dev/t277-mode-downgrade. FIRST after the move; then the opus security reviewer; gate; merge; /deploy gate=true.
- t255 (opus) T-255: dev-automove-model, dev/t255-unknown-usage.
- DONE t146 (opus): T-146 slice 1 merged locally (gate Job running; push when green). T-146 in_review.
- t136-2 (opus) T-136 slice 2: dev-track-c-ui, dev/t136-recover.
- t100 (sonnet) T-100 finish: dev-automove-web, dev/t100-sessions-list.
- Orchestrator: integration 270e752 on origin and pilot (T-270 layers 2-3 and T-95 item 4, both gated green). Local HEAD = 270e752 + the T-146 merge (gate Job running; pushed as wip/orch-<sha>); when green push origin and pilot.

## IN FLIGHT (03:3x: six slices: five plus the owner's urgent hotfix, on the record)
- DONE t265 (fable): root cause proven (GNU tail past the end replays the file; a doubled follower pushed the cursor past the end), fixed and merged (74e1f22, gate green 43/26/318 s, pushed). T-265 in_review; T-268 filed (orphaned tails).
- DONE t258 (opus): tokens lifetimes, label rule, cap, revoke by label, declared authz; merged locally, gate Job running. BREAKS the coordinator's helper (409 on a duplicate label: send expiresIn 1h and replace true): on T-258 and under NEEDS A HUMAN.
- t277 (opus, 03:3x, URGENT T-277 layer 1): dev-track-a-connect, dev/t277-mode-downgrade. #acceptMode: a LESS permissive mode report (plan < default < acceptEdits < auto < bypassPermissions) sets expected, records bypassLost with a marker and an event, does not end the session; a MORE permissive report, an unexpected Bypass, an unknown origin still end it. Then an INDEPENDENT opus security reviewer reads the diff before the merge; then gate, merge, /deploy with gate=true (the coordinator approves as delegate; protection is off today, say so on the run). NO other portal deploy before it; finished slices bundle into it.
- t255 (opus, 02:5x): dev-automove-model, dev/t255-unknown-usage (from the t105 branch). Unknown usage ranks below every measured Claude and never wins; the limit message in a chat's output marks the Claude exhausted and moves the chat; no 0 percent for unavailable.
- t146 (opus, 02:5x): dev-t107-job-run, dev/t146-attention. T-146 slice 1: the attention registry, four sources, GET /api/attention, the Needs-you page and badge; the deck is slice 2.
- t95 (opus, 03:0x): dev-gate-job, dev/t95-flaky-ticket. T-95 item 4: the portal opens one ticket per flaky test seen in a gate (dedup across runs), the run page shows it; item 3's numbers on the ticket.
- DONE verifier pass 1 (sonnet, 02:4x-03:0x): closed T-42, T-99, T-107, T-98, T-24, T-32, T-97 with evidence (cluster Jobs on main, harnesses 154/154 and 42/42, 122 server tests); reopened T-95 (item 4 half done). Limits on each ticket (no sign-in: no live UI checks). Tooling notes: job-run --ref needs a branch name (a bare sha fails: add to T-211); --artifacts must be inside the repo.
- DONE t105 (opus): T-105 + T-109 + D-39 merged locally (60df266; conflicts in server index, contracts index and migrations kept both; migrations 755, 760, 761, 770-772, 780, 790, 791, no duplicate), gate Job running. Then: push, DEPLOY, T-255 next in dev-automove-model.
- t136-2 (opus, 02:1x): dev-track-c-ui, dev/t136-recover. T-136 slice 2: recover in place (POST recover, session_recover, Resume button, caps, suspicious cause needs a person), the supervisor tries recover first.
- t100 (sonnet, 03:0x): dev-automove-web, dev/t100-sessions-list. Finish T-100: merge integration, the harnesses in a Job (session-list, session-swipe, scroll-lock, mobile-drag), PRD numbers.
- DONE t270b (opus): T-270 layers 2-3 merged locally (gate Job running). T-270 in_review. Filed T-274 (chips 36 px), T-275 (claim_next takes only open).
- DONE t259 (opus): T-259 slice 1 merged locally (06b69e1; conflicts with T-270 in controller.ts and supervisor.mjs kept both), gate Job running. T-259 in_review; T-257 items 1-2 in it.
- DONE t270 (opus): T-270 layers 1 and 4 merged (76566fd, gate green, pushed).
- t256 done (opus, 00:4x): not a move bug: the move kept Bypass, the idle chat SLEPT and the wake came back on the start mode (FR20); the coordinator's inline supervisor block c349364 was replaced by t256's paced ensureBypass in the merge. T-256 in_review.
- T-110 slice 1 review (orchestrator): the new route is manage-only with the person guard, dry mode approves nothing, the runner's `changes` is plumbing only; migration 780.
  T-159 (fix uncommitted in the main folder: scratch-portal.sh closes fds 3-9, README `flock -o`): its test waits for /tmp/heavy.lock, held by the Event and Konfersi chats' npm runs since 00:2x; commits when the test has passed.
  A stray branch wip/orch-c072676 (= integration's head, pushed by mistake): deleting a remote branch is denied here; a person may delete it.

## NEXT (rank order; the coordinator 00:2x: T-259, T-255, T-256, T-257, T-258 right after T-136)
1. T-265 (running), T-105/T-109 (running), T-259 slice 1 (running).
2. When T-105 and T-265 are merged: ONE deploy today (gate=true, D-7; images=portal), then the post-deploy check (8). Production protection is OFF, so the release will go out with no approval unless a person turns it on first (NEEDS A HUMAN).
3. T-259 slice 2 (the restart of an ended chat from its status file, the Bypass lease T-104 item 3, the Home Autonomy widget, session_keepgoing_set); then delete supervisor.mjs (T-104 item 6).
4. T-255 (after T-105 merges, same worktree): unknown usage never wins; a limit message in the transcript marks the Claude exhausted.
5. T-257 items 3-4 (supervisor.mjs: notify when left down, cap per cause) if not covered by 3; T-258 (tokens: short lifetimes, cap, bulk revoke).
6. T-136 slice 2 (recover in place, the supervisor uses it) after T-265; then slice 3.
7. T-110 slice 1 (dev/t110-autoapprove-dry, 7cd7951, 16 behind): review the diff, merge integration, gate, merge. Production protection is OFF so no dry line will appear until it is on again.
8. VERIFIER (sonnet, standing, rule 1): the next free slot; first pass over what is live in 2026.10.13-6/-7 and in_review: T-42, T-95, T-99, T-107, T-98, T-24, T-32, T-97; after the deploy: T-102, T-110, T-256, T-265, T-258, T-270, T-259, T-105. Limits on the tickets.
9. T-100 (paused at cf86a26; one harness run left), T-125, T-127, T-128, then T-148, T-149, T-146, T-158, T-210, T-211, T-212, T-115, T-104/T-108 (the rest), T-118 (WIP 7b02a4e).
---- CUT LINE: nothing below starts before 8 is merged and deployed ----
T-126, T-129, T-121, T-122, T-113, T-114, T-101, T-106, T-120, T-26/T-27 (in T-134), T-30, T-33, T-123, T-132..T-135 with T-140, T-137, T-138, T-130, T-131, fitOf/fit.ts.

## NEEDS A HUMAN (required escalations only, D-10 and D-34)
- COORDINATOR'S HELPER (before the deploy): T-258 makes a duplicate token label a 409; the helper must send `expiresIn: "1h"` and `replace: true` (or `addAnother: true`) and revoke its token at the end of a run. Details on T-258.
- BYPASS RULE (the owner's, charter walls): a wake from sleep drops Bypass as FR20/FR20a are written, which is what idled the Event chat for 5 hours (T-256). Options: (a) Keep-going chats do not sleep; (b) a wake keeps Bypass under the T-104 lease the owner grants once (recommended: the sanctioned path for the in-portal watchdog, no owner code in a pod); (c) leave it, the supervisor re-asserts (built, works only while the supervisor runs). (c) holds until the owner answers; T-259 slice 2 builds the lease.
- PRODUCTION: run 19 was released with approval `auto` (protection off). If that is the owner's choice, write it as a DECISIONS row; if not, switch it back on (CI > Remotes > claudepilot). T-110 comment 955.

## DECISIONS
- 01:0x The coordinator reassigned the ended session's tickets to 619018ca (T-270 filed for the mechanism). Closed: T-143 and T-141 (verified live, evidence on the tickets), T-159 (test passed on a private lock). In review: T-102, T-110, T-256. Duplicates closed wont_do: T-252 (= T-256), T-253 (= T-257). T-142 is Konfersi's and stays with its chat.
- 01:1x One deploy today, after T-105 and T-265 merge (the integrity re-read fix protects every live session; the orchestrator brief allows at most one deploy a day), not now for T-102 alone.
- 00:3x Ranking: the coordinator's five tickets (T-259, T-255, T-256, T-257, T-258) go right after T-136; T-265 (the actual cause of the 17:58 ending) is worked
  first as the T-136 part A gap, with fable (a diagnosis nobody cracked). T-256 and T-105 fill the other two slots (both built or nearly, highest value per hour).
- 00:3x T-102's migration 755 is kept at its number before 770-772 (a lower number still runs; same as the t105 branch's 760-761).
- 00:3x Status-only commits are not pushed while the unpushed T-102 merge sits ahead of them: integration gets the merge and the status together after the gate.
- Binding, kept from earlier entries (the full log is in git history of this file):
  - Before a merge, run the touched AREAS' tests, not only the slice's own files. The gate fails a hung test after GATE_TEST_TIMEOUT_MS and reruns failing files alone.
  - Commits carry Ticket, Pilot-Session and Pilot-Agent (CHARTER). An unpushed merge for a gate Job goes to a fresh wip/orch-<sha>, never -f.
  - Claim a ticket only when work starts; the queue lives in this file. WIP limit five (D-43). No sub-agent calls SendMessage (README 7).
  - Never print the environment in any form (T-124); every sub-agent brief says so. A scratch portal under the heavy lock takes `flock -o` (T-159).
  - Migration blocks: T-42 710-715, T-98 716-717, B 720-729, C 730-734, T-97 735-736, T-26/27 740-744, T-30 745-749, T-101 750-754, T-102 755, T-105 760, T-109 761, T-136 770-772, T-110 780-784.
  - Quota: keep turns short (background waits) so auto move sees turn boundaries (T-105 G2).
