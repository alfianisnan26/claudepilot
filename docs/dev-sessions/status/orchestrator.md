# orchestrator status (2026-10-15 10:45 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file. Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- MERGED ff cc26c96: T-531 S2c (gate GREEN 55d5fad, suite 587 s, peak 1971Mi). CLOSED T-531. Rides the deploy after #38.
- MERGED ff 3f81869: T-524 S2 0fbc6be (gate-job Pending report, memory peak line, ENOSPC hint). Gate GREEN claudepilot-gate-3f81869-1ecd
  (suite 575 s, peak 2325Mi/8192Mi, 0 OOM). No web files in the diff, so no web suite. Scripts only: no deploy needed.
- DEPLOYED run #37 rmv9dxygu680003 (0316fae = b37628e + status): gate 690 s, build, release, verify, chats all passed.
  Carries T-486 S1, T-490, T-450 S3, T-524 S1, T-515, T-527. CLOSED T-527 (live D-62 refusal 10:42) and T-515.

## IN FLIGHT (5 of 5 workers, D-68): T-561 a649874 blind review PASS W/ CONDITIONS (5227); decision 5230:
  7f11145e impl-t561-s1b (sonnet) on ticket/T-561-s1b fixes the 6 findings: WAITING fc35ded. T-576 DONE 2427d98 (Jobs green; no
  prettier/eslint in the Job): ux BLOCKED again (build OK; a `folder` spawn gets no Bash; 5368): waits on T-586 worktree-deps.sh (2ae78a99 impl-t586, sonnet). T-558 e652c44: QA runs its Jobs (5052).
  T-486 ab61f5c: blind review PASS W/ CONDITIONS (5349); decision 5352: 5feb4875 impl-t486-s2d (sonnet) adds the tests; then lead merge + gate.
  T-548 S1 DONE 9b822ba (Jobs green, 5364; d23cb713 ended): QA (sonnet) + blind review (opus, authz) next. eaec4cc5 impl-t591 (sonnet) S1 (plan 5366).
  T-546 bb7cdb0: 8822ba59 jobs-t546 (sonnet, ticket/T-546-jobs) re-runs the Jobs the restart cut (5143): WAITING. Next free slots: T-548 QA, T-576 ux (after T-586), T-592 (low).
  Sweep: PASS T-109/280/282/285, GAP T-259/294/136(?)/338/317/287; nobody can claim in_review tickets -> coordinator (T-525 4659).
  Cluster: T-561 S1b (now) -> T-486 S2d -> T-546 -> T-558 QA. quick-check unusable by dontAsk workers: T-586 (mine,
  coordinator decides); briefs say: its checks in ONE job-run Job. Next free slot: T-546 Jobs, T-558 QA, T-486 review.
- T-557: the COORDINATOR builds it (dev/t557-runners); 8dc6a739 ended, its 02357fd offered as input (4925). Collision lines on T-557.
- T-426 (mine again, 4926): ab93b54 --pool-env; the coordinator reuses its secret resolution. QA + blind review after T-401 merges.
- T-379 3ddbcbc: src/ci 144/144 job-5b4609a6 (4905); lead live proof PASS job-c71c5bfe (4906); blind review 30dc0f13 PASS WITH
  CONDITIONS (4938) -> S2 3f11b28 PASS src/ci 144/144 job-83899ca9 (4948; d39c25c1 ended) -> merge after T-401.
- T-401 060aca4: blind review PASS WITH CONDITIONS (4936). HELD for a person's ack of the gate change (4941, NEEDS A HUMAN);
  QA PASS WITH GAPS (4943: 189/189 --big; 4Gi hit ENOSPC /tmp). Gate GREEN 3d7ba13 (gate-3d7ba13-2c4f, 5002). On ack: re-merge + re-gate. T-567.
- T-416 (high incident): S1 d37c5f0; QA b1aa2e47 PASS WITH GAPS (4623: 995/999 0 fail job-2c410105; mutations A2/B/C caught);
  ended. Decision 4637: S1b a769b00 (race fix + push-bridge test, UNTESTED; author ended for T-379, 4688). QA runs its Jobs,
  then blind review (opus), lead gate, merge, deploy. S2 = Bypass restore.
- T-486 (high): S1 live. S2 DONE 75fd6a4 (4671, Jobs green; webhook, attention, allow-list, migration 783); 45148907 ended.
  Blind review 10382d36 PASS WITH CONDITIONS (4693, 6 minors); decision 4703: S2b cffb12b1 fixes m1/m4/m5 + PRD risks m2/m3;
  web hookSecret field -> T-556. Then QA -> lead gate -> merge -> deploy -> real Event branch check.
- T-525 (mine): QA/reviewer lack session_get (4362); scribe role has no Bash or ticket tools (4471). Coordinator decides.

## STATE PER TICKET
- T-404: third blind review gave no verdict (design point -> T-451); fixes verified 3325; open until deployed.
- T-376 (high): S2 dev/t-376-3 0b0faf7 needs integration merged in by the lead, then ux re-check (production build), then S3 perf-tester.
- T-378 S1 dev/t-378-1 9834ff7 ready: needs a verifier.

## DECISIONS (binding)
- 16:10 Coordinator back: deploy #40 (pilot at 433da24) is its own; no deploy from me; one workspace restart after #40. The 4th slot
  (T-546 Jobs on bb7cdb0, ticket/T-546-crew-digest) is spawned after that restart, since the cluster is busy until then.
- 14:30 Coordinator (D-65 idle slots): workers waiting on the one-at-a-time cluster hold slots; over 120k they end after their
  ticket. 7d33708d ended, T-576 started in its slot. The cluster queue (D-61), not the workers, is the bottleneck.
- 15:50 Workspace restarted 13:46 UTC; 03c496b6 (T-546, mid-Jobs) and cee43422 (T-486 port, WAITING 3cb0883) are gone, all branches
  pushed and clean. Deploy #39 (coordinator, RBAC + T-557 fix) holds the cluster, finishes by itself. 14:05 Coordinator AWAY (owner offline): restart POSTPONED, long work OK, Mac runner off.
  The coordinator ran #38/#39. After it: fresh workers re-run T-546's Jobs on bb7cdb0 and T-486's on 3cb0883.
- 12:50 Coordinator: it builds T-557 itself (owner's ask); no T-557 slices from me; T-426 stays mine; a line on T-557 when I touch
  ci/ or connect/ in a big way. (Supersedes 12:45's fold of T-426 into the lease.)
- 13:20 D-66 (pulled, 619b4b5): workers run scripts/quick-check.sh (one Job: format, lint, named tests) before a branch goes
  to the gate; every brief from now on says so. Workers cannot git merge: the lead merges base heads into slice branches (4852).
- 12:00 Coordinator tool review (4820): the lead edits ONLY the status file and notes.
- 11:15 D-65 (coordinator): 4 ClaudePilot workers; implementers sonnet by default (opus only with a written why); small QA/review
  findings fixed in the same slice; a worker takes 2-3 related tickets (reuse under 150k); full report on the ticket, the lead
  reads line 1 and opens it only on FAIL; ready features over chores. Targets under 8 USD per ticket, lead share under 30 %.
- 10:25 Workers end with WAITING <hash>; the lead hands out the cluster slot with "GO T-n" (free-slot check: OUR Jobs only).
- 09:00 Persona/role-tool/permission questions go to the coordinator, NEVER the owner; `owner-checklist` = production only.
- D-63: QA/ux/reviewer on SONNET (opus needs a `why`: security, gate, rule or large slice); the lead never implements or commits code.
- D-61: (worker count now 5 by D-68, coordinator 2026-10-15), NO Agent-tool sub-agents, heavy work ONLY via scripts/job-run.sh or gate-job.sh, one at a time. Hand over before 250k.

## NEEDS A HUMAN (D-62)
- T-401 gate wall (via the coordinator): the owner acks on T-401 that gate-job.yaml's change is credential plumbing plus one
  stricter red (exit 3 on a credential value in the gate's files); gate.sh's checks unchanged. Question text in 4941.
- T-93 Konfersi production only. Coordinator items: T-422 (sudo), T-306 item 4 / T-340; D-row for T-417's Bypass across sleep;
  T-433's persona-wall question (2984).
- For the coordinator, NOT the owner (not tagged owner-checklist): T-476 lead may START a deploy whose release waits for a person
  (3813); T-491 Event token scope until T-426 (3965); deploys #35/#36/#37 production approval showed "auto", not changed by an agent;
  T-509 kit republish; T-525 session_get + scribe tools; T-527 finding 4 (owner triggers tagging owner-checklist).

## NEXT (in order, as slots free)
1. Merges: T-401 -> T-379 -> T-486 -> T-426; then deploy. 2. T-416 S1b QA -> blind review (opus) -> merge; then S2.
3. NEXT FREE SLOTS: T-558 QA (sonnet) + review (opus); T-426 QA + blind review; T-548 (sonnet); T-578 (high: deploy reuses a green gate for the same
   tree + per-file gate progress; a gate change: built + blind review, merged only on a person's ack like T-401); then RTK (coordinator 14:55):
   T-340 (hook refuses typed rtk hiding a denied command; a hook change is landed by a person/coordinator) -> T-341 -> T-306
   delivery (dev/t-306-1 has items 1-2); T-547 + T-549 (+ wasted-calls row, 4802); T-574 (session_family summary, from T-282 4801). Sweep results: the lead closes on PASS or reopens with the gap. 4. T-524 measurement with T-513. 5. T-537. 6. T-513.
7. T-472 live re-check (4294), T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-378 S1 verify, T-382, T-377, T-386, T-409, T-402, T-398, T-399, T-370 HOLD,
   T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-376 S2.

LESSONS: node --test, never vitest; a gate-done notice needs action; dontAsk workers cannot read /tmp, merge, gate or wait, and Bash only in their spawn worktree (new branch = new worker); whole
test folders; trailers in one block; FULL hashes; gate before every push; status via Edit/Write ONLY (broken twice 2026-10-15: python, sed -i); ancestor check before ff.
