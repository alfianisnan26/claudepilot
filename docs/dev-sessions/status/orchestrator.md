# orchestrator status (2026-10-16 07:05 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file (2026-10-15 DONE batches 1-7: see 4fbab374). Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- GATING 1c0290c7 (batch 18): T-524 S3b 23330c28 (QA Perf PASS WITH GAPS 6934), gate-1c0290c.
- MERGED bf61c5ee (batch 17): T-251 S2 9adfeee2, gate GREEN gate-5965287. T-251 all 5 reqs + gaps closed; lead can't close (T-634).
- MERGED 92900150 (batch 16): T-710 8107098a (QA UI PASS WITH GAPS ae9b7dae; mutant caught 5b304d1c; 24 px desktop -> T-724);
  gate GREEN gate-2d10963. T-710 unassigned: lead can't close (T-634), evidence here.
- MERGED be431d6a (batch 15): T-675 65d93dea + T-549 S2 5d97103d (QA BE 2 PASS WITH GAPS; T-723); gate GREEN gate-9f5afa1
  (actions.test timer flaked in suite, passed alone: T-697's case).
- MERGED de3a3515 (batch 14): T-376 S3 (QA UI 6797; open S4 6798), gate-d0975fa green.
- MERGED c3cad1a6 (batch 13): T-524 S3 (open S3b 6624) + T-681 (CLOSED; gaps -> T-710); gate-7526daa green.
- MERGED 5f54dbcf (batch 12): T-574 S2 57bc14bf (QA BE 2 PASS WITH GAPS); gate GREEN gate-5a379d4 (6637). Open for S3 (6615).
- Batches 1-11 (2026-10-15/16, 275cea5b .. 24570945): T-341 (open D), T-325 S1 (open S3), T-416 S1 (open S2); T-633, T-546, T-636, T-576, T-638 CLOSED.

## IN FLIGHT (6 of 6, D-71)
  Lanes' ticket_comment refused on unassigned tickets (T-341, T-549, T-675): verdicts live in their replies + this file.
- QA PERF 7e4879c7: standby -> T-697 rework. T-524 S3b 23330c28 PASS WITH GAPS 6934 (2ac43ac7 208/208; D,F,G killed ea36e239;
  live patch NOT verified: no log line) -> next batch; S3c log line -> BE Infra after T-697.
- QA UI 8b13bb5a: standby -> T-376 S4.
- QA BE 2 42e5408f: T-610 rework 80a2f002 (m1-m5 killed 904039f5, m6 survives; 5b21f12e 1081/1084; qc-t610b PASS job 489f5796), then T-574 S3.
  T-251: audit PASS WITH GAPS (45e984db, 8870ab0c); S2 9adfeee2 PASS (e04de7ab, A-D caught) -> batch 17.
- IMPL lane 0d799c90 (sonnet, rossi; bccb756f ended after T-710) T-376 S4 on ticket/T-376-s4 from be431d6a: createApp wiring
  test + 4x CPU, long tasks, DOM/heap, older-page render budgets.
- BE INFRA lane a7d33a84 (sonnet, sekar; 87749649 ended after T-610 rework) T-697 rework in ticket-t-697-flakes: await the scan, 30x load.
- BACKEND lane 216dbe18 (sonnet, regitha) T-574 S3 on ticket/T-574-s3: cross-lead NOT_FOUND test, size trim, bound 1.5k.
- HELD: T-426 S1e 2174eee1 QA PASS 6169 -> merge on the T-401 ack (4941). T-578 51f6c153 review CHANGES 6168 -> owner decision.
  T-631 review CHANGES 5850: absolute-path entry (a) for the coordinator; F1 on job-run.sh -> T-635 (high).
- 16:12 OWNER PRIORITY (coordinator, T-426 5538): T-401 then T-426 FIRST. T-401 gate GREEN gate-54ba328-6502; ff only on the person's ack.

## DECISIONS (binding)
- 06:50 T-251 S2: an exhausted source with a running turn is steered once and moves at the boundary (FR10a, PRD default); QA asks
  whether the owner wants a move mid-turn: product choice, not a defect; changing it means FR10a + t255 together.
- 03:55 Lead false claim corrected: T-524 6775 said job 4d5cb657 proved the S3 patch; its log shows the rule at creation. 6788; incident T-721.
- 23:55 T-524 S3 (6489): Jobs off k3s-master over the T-611 line; re-measure after merge. 22:59 T-574 out of batch 8 (6396).
- 20:14 PUSHBACK T-657: T-259 (QA FAIL 1773), T-317 (live run not done), T-338 (no QA pass) closed against the evidence -> reopen
  proposed; lead can't (T-634).
- 16:30 D-71 (coordinator): limit 6; 3rd build lane BE Infra (CI, runners, job-run, k3s, deploy, secrets delivery, usage, spend, quota):
  T-401, T-426, T-611, T-547, T-610. Backend: T-546, T-597, T-600 route, T-325. Spawn lanes with claude auto.
- 14:56 D-70 LANES (DECISIONS.md; my decision T-595 5380): freed slots become lanes, spawned ONCE on sonnet and fed
  by session_message, never ended for lack of work. Every delivery goes to its side's QA lane before merge. T-595 5389: the LEAD makes
  each ticket's worktree+branch. 16:25 (T-595 5552/5553): QA Perf may `git merge --ff-only` a base the lead pushed; lane-backend may NOT.
  An implementing lane needing a new base is ended and respawned as the same lane on a fresh branch from that base.
- BINDING: the coordinator runs deploys; I start NO deploy.
- 12:50 Coordinator: it builds T-557 itself (owner's ask); no T-557 slices from me; T-426 stays mine.
- 13:20 D-66: quick-check (format, lint, named tests) before the gate. Workers cannot git merge: the lead merges base heads in (4852).
- 11:15 D-65 (coordinator): implementers sonnet by default (opus only with a written why); small QA/review findings fixed in the same
  slice; full report on the ticket, the lead reads line 1 and opens it only on FAIL; ready features over chores.
- 15:29 Coordinator: job-run.sh caps and queues Jobs (2/program, 3 cluster); "one at a time" is PER AGENT. gate-job before each merge stays mine.
- 09:00 Persona/role-tool/permission questions go to the coordinator, NEVER the owner; `owner-checklist` = production only.
- D-63: QA/ux/reviewer on SONNET (opus needs a `why`: security, gate, rule or large slice); the lead never implements or commits code.
- D-61: NO Agent-tool sub-agents, heavy work ONLY via scripts/job-run.sh or gate-job.sh, one at a time. Hand over before 250k.

## NEEDS A HUMAN (D-62)
- T-578 (gate wall, via coordinator): owner picks same-tree gate reuse (a) portal CI store [lead default], (b) pipeline-only RBAC
  ConfigMap, (c) accept risk, (d) drop reuse; reuse also conflicts with "full gate on the exact commit" (charter). Lead can't comment (T-634).
- T-666 (high, RBAC = a person's wall): workspace kohi-event can create/delete ConfigMaps in isnan-claudepilot (review 6168, can-i).
- T-401 gate wall (via the coordinator): the owner acks on T-401 that gate-job.yaml's change is credential plumbing plus one
  stricter red (exit 3 on a credential value in the gate's files); gate.sh's checks unchanged. Question text in 4941.
- T-341 D (updatedInput) needs a real Claude Code session: a person or the coordinator.
- T-93 Konfersi production only. Coordinator items: T-422 (sudo), T-306 item 4 / T-340; D-row for T-417's Bypass across sleep;
  T-433's persona-wall question (2984).
- For the coordinator, NOT the owner (not tagged owner-checklist): T-476 lead may START a deploy whose release waits for a person
  (3813); T-491 Event token scope until T-426 (3965); deploys #35/#36/#37 production approval showed "auto", not changed by an agent;
  T-509 kit republish; T-594 alfian.isnan signed out; T-525 session_get + scribe tools + QA UI browser tools (5505); T-595 lane Bash (5443);
  T-591 #40 backfill after deploy (5511); T-325 S3 push door vs charter "only the main chat merges integration" + its token (5549);
  T-527 finding 4 (owner triggers tagging owner-checklist); T-657 reopen T-259/T-317/T-338.

## NEXT (in order, as slots free)
1. Merges: T-401 060aca4 (ack 4941) -> T-426 S1e -> T-379 S2 3f11b28 (PASS 4948, review 4938); deploys are the coordinator's.
2. On PASS: T-697, T-549 S2, T-376 S3 -> gate, merge. BE Infra after T-549 S2: T-524 S3b.
   T-710 sweep PASS WITH GAPS 6737 (job abef017c); harness slice in flight, then QA UI re-sweep. Then T-376 S3, T-549 S2, T-697 -> QA.
3. T-675 (memory findings 4/5 + R2 test, Backend lane), T-574 S3 (6615), T-416 S2 (Bypass restore).
4. RTK: T-340 (hook change landed by a person/coordinator) -> T-341 merge -> T-306 item 3 (lab A/B). 5. T-537. 6. T-513.
7. T-472 live re-check (needs portal_status), T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-382, T-377, T-386, T-409, T-402, T-398,
   T-399, T-370 HOLD, T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-404 open till deployed.

LESSONS: reply_of = LATEST reply only (verdict must be the last reply); node --test, never vitest; a gate-done notice needs action; dontAsk workers cannot read /tmp, merge, gate or wait, and Bash only in their spawn worktree (new branch = new worker); whole
test folders (T-574 red 10-15); integration moved during a gate = merge + re-gate (pack goes stale); FULL hashes; trailers in one block; status via Edit/Write ONLY; ancestor check before ff.
