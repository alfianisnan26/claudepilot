# orchestrator status (2026-10-16 00:10 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file (2026-10-15 DONE batches 1-7: see 4fbab374). Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- MERGED ff 7569d582 (batch 10): T-633 S2 (QA Perf PASS 6523); gate GREEN c57ab11. T-633 CLOSED (S1 batch 7 1a4a7933).
- MERGED ff 38d6d3fb (batch 8b): T-325 S1+S1b+S1c (QA Perf 6357, migration 785 read); gate GREEN e5d2de3. Open for S3 (person).
- MERGED ff 7ff6561d (batch 9): T-416 S1-S1e (QA Perf 6420); gate GREEN 1803cf2 + re-gate 15aece0 (6498). Open: S2, T-675.
  Flakes repos/actions.test.ts timer + chat/limits.test.ts -> T-697 (high, 6551; 2 of the last 3 gates).
- Earlier 2026-10-15: batches 1-7 (275cea5b, bcb27182, 1772d2d0, ce819bd0, ffd4bcdd, 8d9eab44, 1a4a7933); T-546, T-636, T-576, T-638 CLOSED.

## IN FLIGHT (6 of 6, D-71)
  Lanes' ticket_comment refused on unassigned tickets (T-341, T-549, T-675): verdicts live in their replies + this file.
- T-574: batch 8 gate RED (sessionStartParent.test.ts:71, family workers not an array; 6396) -> BACKEND lane 06e9ff5c (sonnet,
  respawned) on ticket/T-574-s2 from 124ca45f: keep the array, cap/cut tests, whole src/chat + portalmcp in a Job.
- BATCH 11 wip/main-ea46530 = T-341 e4284315 + docfix 2ed9bc64: GATE RUNNING. QA Perf idle: next T-524 S3.
- T-549 70b081f8: QA BE 2 FAIL crit 2 (full form 18,539 chars at 2 programs, ~27k at 3; job 96771ba8), mutant B (exact ceiling)
  survives, done_rate baseline regex gives kubernetes/kohi-event (ClaudePilot) Event's 12/day. QA UI PASS WITH GAPS (f7730a9b).
  Lead refused on T-549 too (unassigned). S2 (size test 3-5 programs + shrink/page, boundary test, baseline by program id) ->
  BE Infra lane after T-524 S3, fresh branch from 70b081f8.
- T-341 docfix 2ed9bc64: QA BE 2 PASS (recount: author right, QA's 10/4/1 a miscount; ls 25.0% vs 26.1% = one root entry
  differs between clones). Hook installed nowhere; D not verified stays a person's.
- QA BE 2 idle: next T-574 S2. QA UI idle: next T-681.
- T-524 measured FAIL 6488 (master peak 87% > 85%; ~1/3 of Jobs on master) -> decision 6489 (a): BE INFRA lane f5aded2f
  (sonnet, respawned) on ticket/T-524-s3: Jobs off master over the T-611 line (required) + OOM-report test.
- T-376 QA UI FAIL 6542 (job 1a3f4179 on 2611d173 = integration + harness 982c527f): open pulls ~14 MB (events read 4.7 KB),
  first row 2.5-9.6 s, no "Show all (", oldest not reached in 120 s. Decision 6543: S3 app fix + harness logging, next impl slot.
- IMPL d5c6f211 (sonnet) on ticket/T-681-ci-44px: CI Runs filter + back link to 44 px at 390.
- T-675 (unassigned, lead refused): findings 4/5 on T-416 6385, R2 on 6420.
- HELD: T-426 S1e 2174eee1 QA PASS 6169 -> merge on the T-401 ack (4941). T-578 51f6c153 review CHANGES 6168 -> owner decision.
  T-631 review CHANGES 5850: absolute-path entry (a) for the coordinator; F1 on job-run.sh -> T-635 (high).
- 16:12 OWNER PRIORITY (coordinator, T-426 5538): T-401 then T-426 FIRST. T-401 gate GREEN gate-54ba328-6502; ff only on the person's ack.

## DECISIONS (binding)
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
2. On PASS: T-633 S2, T-549, T-574 S2, T-524 S3, T-681 -> gate, merge. T-376 app fix slice after the QA UI verdict.
3. T-675 (memory findings 4/5 + R2 test, Backend lane), T-697 flake, T-416 S2 (Bypass restore).
4. RTK: T-340 (hook change landed by a person/coordinator) -> T-341 merge -> T-306 item 3 (lab A/B). 5. T-537. 6. T-513.
7. T-472 live re-check (needs portal_status), T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-382, T-377, T-386, T-409, T-402, T-398,
   T-399, T-370 HOLD, T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-404 open till deployed.

LESSONS: node --test, never vitest; a gate-done notice needs action; dontAsk workers cannot read /tmp, merge, gate or wait, and Bash only in their spawn worktree (new branch = new worker); whole
test folders (T-574 red 10-15); integration moved during a gate = merge + re-gate (pack goes stale); FULL hashes; trailers in one block; status via Edit/Write ONLY; ancestor check before ff.
