# orchestrator status (2026-10-16 07:05 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file (2026-10-15 DONE batches 1-7: see 4fbab374). Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- DEPLOY 191 LIVE (coordinator, 2026.10.16-1 from 12c68374 = batches <=18). T-404 CLOSED (live hook in managed 10-policy.json + D-60
  refusal 7407). T-597 CLOSED (live 6208). Live checks: T-472 UNAVAILABLE with agent tokens (admin read, 7505); T-591 FAIL:
  release_report setting unset = silent skip; a person's PUT + backfill steps in 7556; silent skips -> T-776. FOR THE COORDINATOR.
- FOR THE COORDINATOR, batch sooner: the T-401 merge (security; waits the ack + gate door T-595 7316). Hold migration 383 until
  scaled by the real row count (0.41 s/1M synthetic, T-739 7487). Ready for the next batch (gate door): T-376 S4b, T-732 (7511),
  T-731 31b1ad73 (r2 APPROVE QA BE 2; QA Perf PASS WITH GAPS job 15df1fc8, 10/10 probes; lead can't comment T-731).

## IN FLIGHT (6 of 6, D-71)
  Lanes' ticket_comment refused on unassigned tickets (T-341, T-549, T-675): verdicts live in their replies + this file.
- QA PERF 7e4879c7: now re-QA T-426 S1h on wip/qa-t426-9573a08 18a3dbb1 (S1h + probes e1dd7b69 e864da9d aeae0ff9); asked to
  post its T-611 S1 verdict on T-611 (none seen). Then QA BE 2 re-reads N1-N3.
- QA UI 8b13bb5a: REVIEW T-723 CHANGES 7815 -> S3c 7832. Now re-QA T-736 S3c fdc5636b (7842, job 9e34bc35 37/0, 15 mutants),
  then a blind re-read of T-781 S3 R1-R5.
- QA BE 2 42e5408f: QA T-723 S3b PWG 7833 (job ba0960c9). T-610 r3 PASS 7844 (job a5bdc271) -> READY 7846. Now QA T-781 S3
  6563633a (7839, job 56feb0b0 271/0; lead read: write script umask 077/700/600, path check holds; asked: hard move => handoff
  skip?), then a re-read of T-736 C1. REVIEW T-611 S1 CHANGES 7762 (C1-C4) -> T-611 S1b.
- FOR THE COORDINATOR, T-781 (D-76): lead cannot claim/comment it (unassigned); Backend lane b2f0e95f on it. Order S1, S2, S4, S3, S5.
- IMPL lane 750a7327 (sonnet; 88eec6be ended: T-736 S3c DONE fdc5636b) now T-723 S3c (7832 + 7833 stub, folds T-788)
  -> T-772 S1b (7719) -> T-772 S2 (7599).
- BE INFRA fad38191 (sonnet; 3958fe14 ended: T-426 S1h DONE 9573a085 7847, job 7a3a11e7 65/0, 4 mutants killed; lead read N1
  redact/safe_name/say: mask before cut, holds). Now T-611 S1b on ticket/T-611-s1b (from S1h; S1 re-applied by hand, conflicts)
  -> T-611 S2 -> T-524 S3c (7360, job-run.sh too: base on T-611) -> T-612 S1.
- BACKEND b2f0e95f (sonnet): T-781 S3 DONE 6563633a (7839) -> QA; now T-781 S5 -> T-733 (7630, 7633). T-778 = person.
- HELD: T-426 S1e 2174eee1 QA PASS 6169, review CHANGES 7121 -> fix, re-QA, merge after T-401. T-578 51f6c153 review CHANGES 6168 -> owner. T-631 CHANGES 5850 -> coordinator.
- 16:12 OWNER PRIORITY (coordinator, T-426 5538): T-401 then T-426 FIRST. T-401 gate GREEN gate-54ba328-6502; ff only on the person's ack.

## DECISIONS (binding)
- 11:00 T-612 default A (pinned prettier/eslint devDeps, changed files only; quick-check must not say "passed" for a skipped step); FOR THE COORDINATOR 7592.
- 10:10 T-731 F1: lanes are refused rm/git rm, so the lead drops job-out/t731b/r.txt as its own traced commit in the premerge (a log, not code).
- 09:38 MERGES HELD: D-75 (lead runs no Jobs) vs gate-job.sh absent from the allow list (lanes refused). Batch 19 71a2317f
  (T-697 + T-574 S3) waits; coordinator picks (a) a person adds the allow entry [default], (b) gate exempt, (c) hold (T-595 7316).
- 09:05 T-731 before the T-426 fix (coordinator). Conflict with owner order T-401 -> T-426 named: T-426 merge waits the T-401 ack anyway; swap if owner says.
- 07:45 D-75 (coordinator): one Job per commit (checks chained), never the same command twice on a commit, QA reads the builder's log;
  the LEAD RUNS NO JOBS (quick-check and gate go to a lane); idle QA gets no-Job work (reviews, browser). T-731 -> BE Infra after T-697.
- 03:55 Lead false claim corrected: T-524 6775 said job 4d5cb657 proved the S3 patch; its log shows the rule at creation. 6788; incident T-721.
- 16:30 D-71 (coordinator): limit 6; 3rd build lane BE Infra (CI, runners, job-run, k3s, deploy, secrets delivery, usage, spend, quota):
  T-401, T-426, T-611, T-547, T-610. Backend: T-546, T-597, T-600 route, T-325. Spawn lanes with claude auto.
- 14:56 D-70 LANES (DECISIONS.md; my decision T-595 5380): freed slots become lanes, spawned ONCE on sonnet and fed
  by session_message, never ended for lack of work. Every delivery goes to its side's QA lane before merge. T-595 5389: the LEAD makes
  each ticket's worktree+branch. 16:25 (T-595 5552/5553): QA Perf may `git merge --ff-only` a base the lead pushed; lane-backend may NOT.
  An implementing lane needing a new base is ended and respawned as the same lane on a fresh branch from that base.
- BINDING: the coordinator runs deploys; I start NO deploy.
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
- T-401 gate wall (via the coordinator): ack 4941 ON HOLD. Review 7103: exit-3 evidence can leak a token, the scan fails open,
  the commit's .npmrc sees the token. Fix -> re-QA -> re-ask the ack with corrected text (scope: init cache, tw clock).
- T-341 D (updatedInput) needs a real Claude Code session (person/coordinator). T-93 Konfersi production only. Coordinator items: T-422 (sudo), T-306 item 4 / T-340; D-row for T-417's Bypass across sleep;
  T-433's persona-wall question (2984).
- For the coordinator, NOT the owner (not tagged owner-checklist): T-476 lead may START a deploy whose release waits for a person
  (3813); T-491 Event token scope until T-426 (3965); deploys #35/#36/#37 production approval showed "auto", not changed by an agent;
  T-509 kit republish; T-594 alfian.isnan signed out; T-525 session_get + scribe tools + QA UI browser tools (5505); T-595 lane Bash (5443);
  T-591 #40 backfill after deploy (5511); T-325 S3 push door vs charter "only the main chat merges integration" + its token (5549);
  T-527 finding 4 (owner triggers tagging owner-checklist); T-657 reopen T-259/T-317/T-338; T-739 A scoring defs (scoring = person's wall).

## NEXT (in order, as slots free)
1. T-401 fix (7103) + re-QA, then ack 4941 -> T-426 S1e -> T-379 S2 3f11b28 (PASS 4948, review 4938); deploys are the coordinator's.
2. Batch at the gate door: T-376 S4b, T-732, T-731, T-739 B READY 7757 (mig 383 note), T-610 r3 READY 7846, T-723 after S3c, batch 19 rebuilt; T-736 after S3c QA.
3. T-675 (memory findings 4/5 + R2 test, Backend lane), T-574 S3 (6615), T-416 S2 (Bypass restore).
4. RTK: T-340 (person/coordinator) -> T-341 merge -> T-306 item 3. 5. T-537. 6. T-513. 7. T-472 live re-check (needs portal_status), T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-382, T-377, T-386, T-409, T-402, T-398,
   T-399, T-370 HOLD, T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-404 open till deployed.

LESSONS: reply_of = LATEST reply only (verdict must be the last reply); node --test, never vitest; a gate-done notice needs action; dontAsk workers cannot read /tmp, merge, gate or wait, and Bash only in their spawn worktree (new branch = new worker); whole
test folders (T-574 red 10-15); integration moved during a gate = merge + re-gate (pack goes stale); FULL hashes; trailers in one block; status via Edit/Write ONLY; ancestor check before ff.
