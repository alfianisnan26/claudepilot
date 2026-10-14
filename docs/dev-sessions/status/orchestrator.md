# Orchestrator status (2026-10-14, session 619018ca, started 00:22 UTC after 5c9fcb5f ended 17:58 for integrity: the T-265 case; down 6 h, T-257)

Knowledge: vault "ClaudePilot dev" (6cd11f710cc3), folder Dev loop/. The queue lives in NEXT; tickets are claimed only when work starts.
Models: opus for implementation, sonnet for checks, fable for diagnosis. WIP limit three. Heavy work through scripts/job-run.sh and gate-job.sh.

## LIVE
- Portal 2026.10.13-7 (run 19, 5234892 + tags f94dca4; Argo Synced/Healthy at f94dca4; pod up since 17:38, 0 restarts; /healthz ok at 00:2x).
  Contains: T-143 (csrf same-host Origin), T-141 (image-build door), T-136 slice 1 (integrity table, continued_from, migration 772 repair), D-33..D-38, the kit docs.
- Verified by the orchestrator 00:2x (D-34), evidence in this file because the tickets are held by the ended session (see NEEDS A HUMAN):
  - T-143: `POST /api/skills/import` multipart with Origin https://pilot.ai.isnan.me -> 401 (csrf passed, the session guard stopped it); Origin https://evil.example -> 403; DELETE without a content type from the own origin -> 401. Not verified: a real Skills folder import from a signed-in browser (no credential for agents).
  - T-141: `scripts/image-build.sh --check --destination registry.int.isnan.me/claudepilot/image-build-proof:a4c2891` -> exists, rc 0, digest 36dd581b…20fba (the proof build of comment 809).
  - T-136 slice 1: NOT enough. The orchestrator still ended at 17:58 for a second control response: the stream reader re-read line 1 of out.1.jsonl (the id appears once in the file) and the first copy had no digest (read before 771). Filed T-265 (urgent, rank-02a, D-40).
- Still in_review from 2026.10.13-6: T-42, T-95, T-99 (the post-deploy check, item 3c, not yet run).

## IN FLIGHT (00:3x: three slices)
- t265 (fable): dev-track-c-ui, dev/t265-replay. Root cause of the re-read (host.ts tail offset), the duplicate rule without a digest, the ending logged, PRD §10.4.
- t105 (opus): dev-automove-model, dev/t105-automove-proven (303e376). Finish T-105 + T-109 + D-39 (re-evaluated on every poll, never latched), the coordinator's acceptance list (comment 910), the harness, area tests as a Job, PRD. Then T-255 in the same worktree.
- t259 (opus, 00:5x): dev-t107-job-run, dev/t259-watchdog. T-259 slice 1: the keepGoing policy (migration 790), the sweep inside the portal (nudge, wake, answer a question, report an approval, out-of-Bypass, ended or down: one notification kind and one ticket per cause), Session info row and chip, T-257 items 1-2 in supervisor.mjs, PRD. No Bypass re-entry (the lease is slice 2).
- DONE t256 (opus, 00:4x): not a move bug: the move kept Bypass, the idle chat SLEPT and the wake came back on the start mode (FR20). Merged locally (T-256 merge on top of the T-110 merge; the coordinator's inline supervisor block c349364 replaced by t256's paced ensureBypass). Gate Jobs running: a4f18be (T-110 merge) and the T-256 merge head; push integration when green. T-256 in_review.
- Orchestrator: T-102 is on integration (9e15498, full gate green: typecheck 51 s, web build 28 s, suite 309 s; pushed bfcc452 to origin and pilot). T-110 slice 1 merged locally (its test file 14/14 in the pod after merging integration; diff read: the new route is manage-only with the person guard, dry mode approves nothing, the runner's `changes` is plumbing only).
  T-159 (fix uncommitted in the main folder: scratch-portal.sh closes fds 3-9, README `flock -o`): its test waits for /tmp/heavy.lock, held by the Event and Konfersi chats' npm runs since 00:2x; commits when the test has passed.
  A stray branch wip/orch-c072676 (= integration's head, pushed by mistake): deleting a remote branch is denied here; a person may delete it.

## NEXT (rank order; the coordinator 00:2x: T-259, T-255, T-256, T-257, T-258 right after T-136)
1. T-265 (running), T-105/T-109 (running), T-259 slice 1 (running).
2. Gates green -> push integration (T-110, T-256) -> when T-105 and T-265 are merged: deploy (gate=true, D-7), then the post-deploy check (8).
3. T-259 slice 2 (the restart of an ended chat from its status file, the Bypass lease T-104 item 3, the Home Autonomy widget, session_keepgoing_set); then delete supervisor.mjs (T-104 item 6).
4. T-255 (after T-105 merges, same worktree): unknown usage never wins; a limit message in the transcript marks the Claude exhausted.
5. T-257 items 3-4 (supervisor.mjs: notify when left down, cap per cause) if not covered by 3; T-258 (tokens: short lifetimes, cap, bulk revoke).
6. T-136 slice 2 (recover in place, the supervisor uses it) after T-265; then slice 3.
7. T-110 slice 1 (dev/t110-autoapprove-dry, 7cd7951, 16 behind): review the diff, merge integration, gate, merge. Production protection is OFF so no dry line will appear until it is on again.
8. Post-deploy check (sonnet, D-34) of 2026.10.13-6/-7 at 390 px and 1280 px, light and dark: T-42, T-95, T-99, T-1, T-2, T-3, T-5, T-24, T-25, T-28, T-32, T-34; limits on the tickets.
9. T-100 (paused at cf86a26; one harness run left), T-125, T-127, T-128, then T-148, T-149, T-146, T-158, T-210, T-211, T-212, T-115, T-104/T-108 (the rest), T-118 (WIP 7b02a4e).
---- CUT LINE: nothing below starts before 8 is merged and deployed ----
T-126, T-129, T-121, T-122, T-113, T-114, T-101, T-106, T-120, T-26/T-27 (in T-134), T-30, T-33, T-123, T-132..T-135 with T-140, T-137, T-138, T-130, T-131, fitOf/fit.ts.

## NEEDS A HUMAN (required escalations only, D-10 and D-34)
- PERMISSIONS: ten tickets are assigned to the ended session 5c9fcb5f and an agent cannot take them over (ticket_update: "assigned to another session"):
  T-136, T-143, T-141, T-105, T-109, T-102, T-110, T-100, T-159, T-42, T-95, T-99. Reassign them to session 619018ca (the orchestrator) so it can write
  on them; until then its evidence is in this file. (T-136 slice 2 should make this automatic: a continued session takes its predecessor's tickets.)
- BYPASS RULE (the owner's, charter walls): a wake from sleep drops Bypass as FR20/FR20a are written, which is what idled the Event chat for 5 hours (T-256). Options: (a) Keep-going chats do not sleep; (b) a wake keeps Bypass under the T-104 lease the owner grants once (recommended: the sanctioned path for the in-portal watchdog, no owner code in a pod); (c) leave it, the supervisor re-asserts (built, works only while the supervisor runs). (c) holds until the owner answers; T-259 slice 2 builds the lease.
- PRODUCTION: run 19 was released with approval `auto` (protection off). If that is the owner's choice, write it as a DECISIONS row; if not, switch it back on (CI > Remotes > claudepilot). T-110 comment 955.

## DECISIONS
- 00:3x Ranking: the coordinator's five tickets (T-259, T-255, T-256, T-257, T-258) go right after T-136; T-265 (the actual cause of the 17:58 ending) is worked
  first as the T-136 part A gap, with fable (a diagnosis nobody cracked). T-256 and T-105 fill the other two slots (both built or nearly, highest value per hour).
- 00:3x T-102's migration 755 is kept at its number before 770-772 (a lower number still runs; same as the t105 branch's 760-761).
- 00:3x Status-only commits are not pushed while the unpushed T-102 merge sits ahead of them: integration gets the merge and the status together after the gate.
- Binding, kept from earlier entries (the full log is in git history of this file):
  - Before a merge, run the touched AREAS' tests, not only the slice's own files. The gate fails a hung test after GATE_TEST_TIMEOUT_MS and reruns failing files alone.
  - Commits carry Ticket, Pilot-Session and Pilot-Agent (CHARTER). An unpushed merge for a gate Job goes to a fresh wip/orch-<sha>, never -f.
  - Claim a ticket only when work starts; the queue lives in this file. WIP limit three. No sub-agent calls SendMessage (README 7).
  - Never print the environment in any form (T-124); every sub-agent brief says so. A scratch portal under the heavy lock takes `flock -o` (T-159).
  - Migration blocks: T-42 710-715, T-98 716-717, B 720-729, C 730-734, T-97 735-736, T-26/27 740-744, T-30 745-749, T-101 750-754, T-102 755, T-105 760, T-109 761, T-136 770-772, T-110 780-784.
  - Quota: keep turns short (background waits) so auto move sees turn boundaries (T-105 G2).
