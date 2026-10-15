# orchestrator status (2026-10-15 10:45 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file. Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- MERGED ff 3f81869: T-524 S2 0fbc6be (gate-job Pending report, memory peak line, ENOSPC hint). Gate GREEN claudepilot-gate-3f81869-1ecd
  (suite 575 s, peak 2325Mi/8192Mi, 0 OOM). No web files in the diff, so no web suite. Scripts only: no deploy needed.
- DEPLOYED run #37 rmv9dxygu680003 (0316fae = b37628e + status): gate 690 s, build, release, verify, chats all passed.
  Carries T-486 S1, T-490, T-450 S3, T-524 S1, T-515, T-527. CLOSED T-527 (live D-62 refusal 10:42) and T-515.
- MERGED ff b37628e (T-515 e021cb6 + T-527 ea81071 + packs): gate GREEN claudepilot-gate-b37628e-0953 (memory peak 2189Mi/8192Mi,
  0 OOM) + web 629/629 (claudepilot-job-a19b47c9).
- MERGED ff 4ba5d37: T-490 c8c8197 + T-450 S3 7f7f18c + T-524 S1 d44bf24 (gate green, web 626/626). MERGED 73bb581: T-486 S1.
- DEPLOYED runs #36 (8062398) and #35 (98e6de4): CLOSED T-483, T-397, T-491, T-435, T-476, T-449.

## IN FLIGHT (3 of 3 workers: eef38632 T-531 S2 (GO, has the slot), b1aa2e47 T-416 QA WAITING (4547), 45148907 T-486 S2)
  Slot order: T-531 S2 9cd240f -> T-416 QA -> T-486 S2.
- T-416 (high incident; 4439): S1 DONE d37c5f0 (4534: typecheck 396fbc13; server 995 pass 0 fail 4e6521ec; web 626/626 0ccd8ea5;
  proof 1d735457 weak (module absent) + a163ad18 in-flight bug caught); ad68c3a4 ended. QA b1aa2e47 (sonnet = role default) incl.
  mutation proof. Then blind review (opus), lead gate, merge, deploy. S2 = Bypass restore. D-34 vs the memory item: built as the
  ticket asks; for the coordinator.
- T-524: S1 + S2 merged (4551). Open ONLY: k3s-master under 85% in a busy hour, measured (with T-513). Minors -> T-543.
  Event Jobs over 4Gi need --big (tell Event).
- T-531 (high, authz): S1 df65563 (4515: typecheck a3cf20b8; 1105/1111 0 fail ed930af1; proof 535ee3fc 6/6); 74a6ee0e ended.
  Blind review 21731f30 PASS WITH CONDITIONS (4520: preflight at view runs a shell, adopt at operate; ended). Decision 4524: fix
  round S2 eef38632 (opus, impl-t531-2, ticket/T-531-verbs from df65563): verbs to the PRD table + a verb-table test; stop stays
  operate. Then QA -> lead gate -> merge. Open points ticketed: T-538 (pool ids in PUT), T-539 (other prefixes), T-540 (remove re-check).
- T-486 (high): S1 live. S2 45148907 (opus, impl-t486-2) on ticket/T-486-sync-s2 from 0316fae: attention for failing/diverged sync,
  webhook kick (authz seam, coalesced), upstream host allow-list setting. Then QA + real Event branch check; close after deploy.
- T-450: S3 deployed; 5 % real-data check + harness assertions (4354) still open.
- T-472: live paths/restarts/pool re-assign NOT VERIFIED (4294). Retry with the new read tools.
- T-525 (mine): QA/reviewer lack session_get (4362); scribe role has no Bash or ticket tools (4471). Coordinator decides.
- T-537 (new, low): commit the T-527 doc edit (uncommitted in worktree ticket-t-527-docs) in an implementer slice.

## STATE PER TICKET
- T-404: third blind review gave no verdict (design point -> T-451); fixes verified 3325; open until deployed.
- T-376 (high): S2 dev/t-376-3 0b0faf7 needs integration merged in by the lead, then ux re-check (production build), then S3 perf-tester.
- T-378 S1 dev/t-378-1 9834ff7 ready: needs a verifier.

## DECISIONS (binding)
- 11:00 Coordinator: the next implementer slot goes to T-401 (security: job-run env carries GIT_TOKEN/NODE_AUTH_TOKEN), then T-426
  (--pool-env door for Konfersi stg e2e), then T-379 (Python in job-run). They unblock 6 Konfersi tickets. Opus + blind review
  (gate/security). They come before T-416 S2, T-537 and T-538..T-540.
- 10:40 Scribe workers cannot hand in (no Bash, no ticket tools): doc fixes go to implementer slices until the coordinator decides.
- 10:25 dontAsk workers cannot wait: the lead hands out the cluster slot with "GO T-n"; workers end with WAITING <hash>.
- 10:02 The free-slot check counts only OUR program's Jobs (app=claudepilot-gate or job-run/program=claudepilot); Konfersi Jobs are
  capped per program by job-run.sh.
- 09:43 Server and web tests are node --test (npm test), not vitest. Vitest Jobs are no evidence.
- 09:12 Workers cannot run scripts/gate-job.sh (refused in dontAsk): the lead runs gates for slices.
- 09:05 Coordinator pushed eac20db/82cee3c straight to integration (no trailers); my candidate was re-merged and re-gated (4331).
- 09:00 Coordinator: persona, role-tool and permission questions go to the coordinator (ticket assigned to me), NEVER the owner;
  `owner-checklist` is production only.
- 08:50 Coordinator: T-524 placement coordinated with T-513 (runner anti-affinity = cluster GitOps MR, own ticket).
- 08:10 A running slice keeps its slot (no preemption). 06:00 The lead holds T-n from claim to close.
- 05:55 A5 binds touch targets at 390 px. 05:50 UX checks run as cluster Jobs. 05:04 New slices get FRESH worktrees.
- D-63: QA/ux/reviewer on SONNET (opus needs a `why`: security, gate, rule or large slice); the lead never implements or commits code.
- D-61: at most 3 live workers, NO Agent-tool sub-agents, heavy work ONLY via scripts/job-run.sh or gate-job.sh, one at a time.
- Hand over before 250k context (coordinator).

## NEEDS A HUMAN (D-62)
- T-93 Konfersi production only. Coordinator items: T-422 (sudo), T-306 item 4 / T-340; D-row for T-417's Bypass across sleep;
  T-433's persona-wall question (2984).
- For the coordinator, NOT the owner (not tagged owner-checklist): T-476 lead may START a deploy whose release waits for a person
  (3813); T-491 Event token scope until T-426 (3965); deploys #35/#36/#37 production approval showed "auto", not changed by an agent;
  T-509 kit republish; T-525 session_get + scribe tools; T-527 finding 4 (owner triggers tagging owner-checklist).

## NEXT (in order, as slots free)
1. T-531 S2 Jobs -> QA (sonnet) -> lead gate -> merge. 2. T-416 QA Jobs -> blind review (opus) -> lead gate -> merge -> deploy; then S2.
3. NEXT FREE SLOT: T-401 (opus), then T-426, then T-379 (coordinator 11:00). 4. T-524 measurement with T-513.
4. T-486 S2 -> QA -> deploy. 5. T-537. 6. T-513 (cluster GitOps MR).
7. T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-378 S1 verify, T-382, T-377, T-386, T-409, T-402, T-398, T-399, T-370 HOLD,
   T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-376 S2.

LESSONS: tests run with node --test (npm test), NEVER vitest; a gate-done notification always needs action; dontAsk workers cannot
Read /tmp, git merge, run gate-job.sh or wait; briefs run the module's WHOLE test folder; trailers in ONE block; FULL hashes with
job-run, --against included; gate before every integration push; the status file is edited with Edit/Write only (D-60 hook);
check the ancestor right before the ff; a Pending gate pod waits for memory (Konfersi Jobs share the nodes).
