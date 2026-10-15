# orchestrator status (2026-10-15 10:45 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file. Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- MERGED ff 3f81869: T-524 S2 0fbc6be (gate-job Pending report, memory peak line, ENOSPC hint). Gate GREEN claudepilot-gate-3f81869-1ecd
  (suite 575 s, peak 2325Mi/8192Mi, 0 OOM). No web files in the diff, so no web suite. Scripts only: no deploy needed.
- DEPLOYED run #37 rmv9dxygu680003 (0316fae = b37628e + status): gate 690 s, build, release, verify, chats all passed.
  Carries T-486 S1, T-490, T-450 S3, T-524 S1, T-515, T-527. CLOSED T-527 (live D-62 refusal 10:42) and T-515.

## IN FLIGHT (4 of 4 workers, D-65: 445c3e1b impl-t561 (opus, why deny rules/authz) T-561 S1 WAITING a649874 (migration 778, no clash),
  d2e7b532 impl-t576 (sonnet) T-576 Runners UI WAITING 7b26e14 (web only). T-558 e652c44: 7d33708d ended (125k, coordinator); QA runs its Jobs (5052).
  fb538d7d qa-t486 (sonnet) T-486 QA WAITING GO, 03c496b6 impl-t546 (sonnet) T-546 crew digest WAITING bb7cdb0 (118k: ends after T-546).)
  Sweep: PASS T-109/280/282/285, GAP T-259/294/136(?)/338/317/287; nobody can claim in_review tickets -> coordinator (T-525 4659).
  Cluster: lead gate T-531 pre-merge 55d5fad (re-merged on T-557 S1 59eca49) -> T-486 QA -> T-546 -> T-561 -> T-576 -> T-558 QA.
  Then DEPLOY integration (carries T-557 S1 + T-575, coordinator asked). Next free slot: T-558 QA (sonnet), then T-576 ux-checker.
  Later: T-426 QA + blind review (after T-401 merges), T-416 S1b QA, T-548.
- T-557: the COORDINATOR builds it (dev/t557-runners); 8dc6a739 ended, its 02357fd offered as input (4925). Collision lines on T-557.
- T-426 (mine again, 4926): ab93b54 --pool-env; the coordinator reuses its secret resolution. QA + blind review after T-401 merges.
- T-379 3ddbcbc: src/ci 144/144 job-5b4609a6 (4905); lead live proof PASS job-c71c5bfe (4906); blind review 30dc0f13 PASS WITH
  CONDITIONS (4938) -> S2 3f11b28 PASS src/ci 144/144 job-83899ca9 (4948; d39c25c1 ended) -> merge after T-401.
- T-401 060aca4: blind review PASS WITH CONDITIONS (4936). HELD for a person's ack of the gate change (4941, NEEDS A HUMAN);
  QA PASS WITH GAPS (4943: 189/189 --big; 4Gi hit ENOSPC /tmp). Gate GREEN 3d7ba13 (gate-3d7ba13-2c4f, 5002). On ack: re-merge + re-gate. T-567.
- T-416 (high incident): S1 d37c5f0; QA b1aa2e47 PASS WITH GAPS (4623: 995/999 0 fail job-2c410105; mutations A2/B/C caught);
  ended. Decision 4637: S1b a769b00 (race fix + push-bridge test, UNTESTED; author ended for T-379, 4688). QA runs its Jobs,
  then blind review (opus), lead gate, merge, deploy. S2 = Bypass restore.
- T-531 (high, authz): S1 df65563; blind review PASS WITH CONDITIONS (4520); S2 9cd240f. QA 47710391 PASS WITH GAPS (4761/4762:
  1428/1433 0 fail job-a8a40ad8; mutation holds job-620ab38d; no agent path uses the refused routes). Decision 4763: S2c (sonnet)
  tests legacy refs get the same 404 -> S2c 7afbd0d QA PASS no gap (5008) -> lead gate 950c17d -> merge. T-538..T-540 ticketed.
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
- 14:30 Coordinator (D-65 idle slots): workers waiting on the one-at-a-time cluster hold slots; over 120k they end after their
  ticket. 7d33708d ended, T-576 started in its slot. The cluster queue (D-61), not the workers, is the bottleneck.
- 14:15 Coordinator: T-575 + T-557 S1 ride the next deploy; then it makes kohi-event's Browser pool and names the restart time.
- 12:50 Coordinator: it builds T-557 itself (owner's ask); no T-557 slices from me; T-426 stays mine; a line on T-557 when I touch
  ci/ or connect/ in a big way. (Supersedes 12:45's fold of T-426 into the lease.)
- 13:20 D-66 (pulled, 619b4b5): workers run scripts/quick-check.sh (one Job: format, lint, named tests) before a branch goes
  to the gate; every brief from now on says so. Workers cannot git merge: the lead merges base heads into slice branches (4852).
- 11:30 Coordinator (owner priority, metocean): T-379 NOW in its own worker; built on T-401's fe62fa6 (fetch stage holds creds).
- 12:00 Coordinator tool review: lead edits of code (dev-t-376 commits 01:57-02:03, no trailers, before D-63 03:36; 4820).
  The lead edits ONLY the status file and notes. Order: T-379, T-426, T-558, T-546, T-548, T-561 (opus, deny rules), T-557.
- 11:15 D-65 (coordinator): 4 ClaudePilot workers; implementers sonnet by default (opus only with a written why); small QA/review
  findings fixed in the same slice; a worker takes 2-3 related tickets (reuse under 150k); full report on the ticket, the lead
  reads line 1 and opens it only on FAIL; ready features over chores. Targets under 8 USD per ticket, lead share under 30 %.
- 10:25 Workers end with WAITING <hash>; the lead hands out the cluster slot with "GO T-n" (free-slot check: OUR Jobs only).
- 09:00 Coordinator: persona, role-tool and permission questions go to the coordinator (ticket assigned to me), NEVER the owner;
  `owner-checklist` is production only.
- 08:10 A running slice keeps its slot. 06:00 The lead holds T-n claim to close. 05:50 UX checks are cluster Jobs; fresh worktrees.
- D-63: QA/ux/reviewer on SONNET (opus needs a `why`: security, gate, rule or large slice); the lead never implements or commits code.
- D-61: (worker count now 4 by D-65), NO Agent-tool sub-agents, heavy work ONLY via scripts/job-run.sh or gate-job.sh, one at a time.
- Hand over before 250k context (coordinator).

## NEEDS A HUMAN (D-62)
- T-401 gate wall (via the coordinator): the owner acks on T-401 that gate-job.yaml's change is credential plumbing plus one
  stricter red (exit 3 on a credential value in the gate's files); gate.sh's checks unchanged. Question text in 4941.
- T-93 Konfersi production only. Coordinator items: T-422 (sudo), T-306 item 4 / T-340; D-row for T-417's Bypass across sleep;
  T-433's persona-wall question (2984).
- For the coordinator, NOT the owner (not tagged owner-checklist): T-476 lead may START a deploy whose release waits for a person
  (3813); T-491 Event token scope until T-426 (3965); deploys #35/#36/#37 production approval showed "auto", not changed by an agent;
  T-509 kit republish; T-525 session_get + scribe tools; T-527 finding 4 (owner triggers tagging owner-checklist).

## NEXT (in order, as slots free)
1. Merges: T-401 -> T-379 -> T-531 (S2c) -> T-486 -> T-426; then deploy. 2. T-416 S1b QA -> blind review (opus) -> merge; then S2.
3. NEXT FREE SLOTS: T-426 QA + blind review; T-558 review (opus); T-546 + T-548 (one sonnet worker); T-561 (opus, deny rules);
   T-547 + T-549 (+ wasted-calls row, 4802); T-574 (session_family summary, from T-282 4801). Sweep results: the lead closes on PASS or reopens with the gap. 4. T-524 measurement with T-513. 5. T-537. 6. T-513.
7. T-472 live re-check (4294), T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-378 S1 verify, T-382, T-377, T-386, T-409, T-402, T-398, T-399, T-370 HOLD,
   T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-376 S2.

LESSONS: node --test, never vitest; a gate-done notice needs action; dontAsk workers cannot read /tmp, merge, gate or wait, and Bash only in their spawn worktree (new branch = new worker); whole
test folders; trailers in one block; FULL hashes; gate before every push; status via Edit/Write ONLY (broken twice 2026-10-15: python, sed -i); ancestor check before ff.
