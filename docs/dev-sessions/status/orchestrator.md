# orchestrator status (2026-10-15 10:45 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file. Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- MERGED ff 3f81869: T-524 S2 0fbc6be (gate-job Pending report, memory peak line, ENOSPC hint). Gate GREEN claudepilot-gate-3f81869-1ecd
  (suite 575 s, peak 2325Mi/8192Mi, 0 OOM). No web files in the diff, so no web suite. Scripts only: no deploy needed.
- DEPLOYED run #37 rmv9dxygu680003 (0316fae = b37628e + status): gate 690 s, build, release, verify, chats all passed.
  Carries T-486 S1, T-490, T-450 S3, T-524 S1, T-515, T-527. CLOSED T-527 (live D-62 refusal 10:42) and T-515.
- MERGED ff b37628e (T-515 e021cb6 + T-527 ea81071 + packs): gate GREEN claudepilot-gate-b37628e-0953 (memory peak 2189Mi/8192Mi,
  0 OOM) + web 629/629 (claudepilot-job-a19b47c9).
- Earlier: 4ba5d37, 73bb581 merged; deploys #35/#36 (closed T-483, T-397, T-491, T-435, T-476, T-449).

## IN FLIGHT (4 of 4 workers, D-65: c10daf0e T-426 WAITING ab93b54 (on T-401 060aca4), cffb12b1 T-486 S2b WAITING 27b95c7,
  47710391 qa (sonnet) T-531 done -> now T-401 QA (code reading, then GO), 0df3dd19 impl-t379 (sonnet) T-379 f2135be: 140/142, 2 fails = T-401's (4841); merging 060aca4 + 3 minors)
  Sweep: PASS T-109/280/282/285, GAP T-259/294/136(?)/338/317/287; nobody can claim in_review tickets -> coordinator (T-525 4659).
  Cluster: T-486 S2b (GO 12:07) -> T-401 QA / T-379 re-run (whichever is ready) -> T-426. T-379 live proof PASS (4845, job-2d70c331). Next free workers: T-401 blind review (opus), T-531 S2c fix. T-486 QA goes to 47710391 after T-531 (reuse); T-416 S1b QA after that. Next free worker slot: T-546 + T-548 (T-426 waits for T-401).
- T-401 (high, security): S1 DONE 060aca4 (4 Jobs green per author; fetch does npm ci --ignore-scripts with creds). Touches
  gate-job.yaml: review must confirm the gate's checks unchanged (4745). Next: blind review (opus) + QA, lead gate, merge.
- T-416 (high incident): S1 d37c5f0; QA b1aa2e47 PASS WITH GAPS (4623: 995/999 0 fail job-2c410105; mutations A2/B/C caught);
  ended. Decision 4637: S1b a769b00 (race fix + push-bridge test, UNTESTED; author ended for T-379, 4688). QA runs its Jobs,
  then blind review (opus), lead gate, merge, deploy. S2 = Bypass restore.
- T-426 (claimed 4642): starts on T-401's merged head (same Secret block of job-run.sh); opus + blind review. T-379 (4687) running.
- T-531 (high, authz): S1 df65563; blind review PASS WITH CONDITIONS (4520); S2 9cd240f. QA 47710391 PASS WITH GAPS (4761/4762:
  1428/1433 0 fail job-a8a40ad8; mutation holds job-620ab38d; no agent path uses the refused routes). Decision 4763: S2c (sonnet)
  tests legacy refs get the same 404 (workspaceRefGuard checks ws_ ids only) -> lead gate -> merge. T-538..T-540 ticketed.
- T-486 (high): S1 live. S2 DONE 75fd6a4 (4671, Jobs green; webhook, attention, allow-list, migration 783); 45148907 ended.
  Blind review 10382d36 PASS WITH CONDITIONS (4693, 6 minors); decision 4703: S2b cffb12b1 fixes m1/m4/m5 + PRD risks m2/m3;
  web hookSecret field -> T-556. Then QA -> lead gate -> merge -> deploy -> real Event branch check.
- T-450: S3 deployed; 5 % real-data check + harness assertions (4354) still open.
- T-525 (mine): QA/reviewer lack session_get (4362); scribe role has no Bash or ticket tools (4471). Coordinator decides.

## STATE PER TICKET
- T-404: third blind review gave no verdict (design point -> T-451); fixes verified 3325; open until deployed.
- T-376 (high): S2 dev/t-376-3 0b0faf7 needs integration merged in by the lead, then ux re-check (production build), then S3 perf-tester.
- T-378 S1 dev/t-378-1 9834ff7 ready: needs a verifier.

## DECISIONS (binding)
- 11:30 Coordinator (owner priority, metocean): T-379 NOW in its own worker; built on T-401's fe62fa6 (fetch stage holds creds).
- 12:00 Coordinator tool review: lead edits of code (dev-t-376 commits 01:57-02:03, no trailers, before D-63 03:36; 4820).
  The lead edits ONLY the status file and notes. Order: T-379, T-426, T-558, T-546, T-548, T-561 (opus, deny rules), T-557.
- 11:40 Coordinator: epic T-557 (external runners, Codespaces first) after T-379/T-426; S0 + S1 in parallel with T-546/T-548.
- 11:15 D-65 (coordinator): 4 ClaudePilot workers; implementers sonnet by default (opus only with a written why); small QA/review
  findings fixed in the same slice; a worker takes 2-3 related tickets (reuse under 150k); full report on the ticket, the lead
  reads line 1 and opens it only on FAIL; ready features over chores. Targets under 8 USD per ticket, lead share under 30 %.
- 11:15 Coordinator priority: T-524 (done), T-401, T-426, T-379, then T-546 (report digest), T-548 (auto hand-off), then T-547
  (quota placement), T-549 (scorecard rows).
- 11:00 Coordinator: the next implementer slot goes to T-401 (security: job-run env carries GIT_TOKEN/NODE_AUTH_TOKEN), then T-426
  (--pool-env door for Konfersi stg e2e), then T-379 (Python in job-run). They unblock 6 Konfersi tickets. Opus + blind review
  (gate/security). They come before T-416 S2, T-537 and T-538..T-540.
- 11:05 Coordinator: sweep 10 in_review tickets against live. Order: T-401 keeps the first free slot (it blocks 6 Konfersi tickets);
  the sweep takes the second. QA cannot close tickets it doesn't hold, so it reports and the lead closes on PASS (D-63).
- 10:25 dontAsk workers cannot wait: the lead hands out the cluster slot with "GO T-n"; workers end with WAITING <hash>.
- 10:02 The free-slot check counts only OUR program's Jobs (app=claudepilot-gate or job-run/program=claudepilot); Konfersi Jobs are
  capped per program by job-run.sh.
- 09:00 Coordinator: persona, role-tool and permission questions go to the coordinator (ticket assigned to me), NEVER the owner;
  `owner-checklist` is production only.
- 08:10 A running slice keeps its slot. 06:00 The lead holds T-n claim to close. 05:50 UX checks are cluster Jobs; fresh worktrees.
- D-63: QA/ux/reviewer on SONNET (opus needs a `why`: security, gate, rule or large slice); the lead never implements or commits code.
- D-61: (worker count now 4 by D-65), NO Agent-tool sub-agents, heavy work ONLY via scripts/job-run.sh or gate-job.sh, one at a time.
- Hand over before 250k context (coordinator).

## NEEDS A HUMAN (D-62)
- T-93 Konfersi production only. Coordinator items: T-422 (sudo), T-306 item 4 / T-340; D-row for T-417's Bypass across sleep;
  T-433's persona-wall question (2984).
- For the coordinator, NOT the owner (not tagged owner-checklist): T-476 lead may START a deploy whose release waits for a person
  (3813); T-491 Event token scope until T-426 (3965); deploys #35/#36/#37 production approval showed "auto", not changed by an agent;
  T-509 kit republish; T-525 session_get + scribe tools; T-527 finding 4 (owner triggers tagging owner-checklist).

## NEXT (in order, as slots free)
1. T-531 S2 Jobs -> QA (sonnet) -> lead gate -> merge. 2. T-416 QA Jobs -> blind review (opus) -> lead gate -> merge -> deploy; then S2.
3. NEXT FREE SLOTS: T-426 (opus, why: secret door) once T-401 merges; T-558 (lead starts own stg-deploy, authz: opus +
   blind review, D-62; coordinator 11:45); then in parallel T-557 S0 PRD (sonnet implementer),
   T-557 S1 runner seam (sonnet, fake runner), T-546 + T-548 (one sonnet worker); then T-547 + T-549; T-557 S2 (opus, transport). Sweep results (47710391): the lead closes on PASS or reopens with the gap. 4. T-524 measurement with T-513.
4. T-486 S2 -> QA -> deploy. 5. T-537. 6. T-513 (cluster GitOps MR).
7. T-472 live re-check (4294), T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-378 S1 verify, T-382, T-377, T-386, T-409, T-402, T-398, T-399, T-370 HOLD,
   T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-376 S2.

LESSONS: node --test, never vitest; a gate-done notice needs action; dontAsk workers cannot read /tmp, merge, gate or wait; whole
test folders; trailers in one block; FULL hashes; gate before every push; status via Edit/Write only; ancestor check before ff.
