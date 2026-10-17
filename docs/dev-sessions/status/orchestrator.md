# orchestrator status (2026-10-16 15:00 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file (2026-10-15 DONE batches 1-7: see 4fbab374). Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- Batches 22-26: git history (to 83b7213e), gates green. Close on "Coordinator live check" PASS. T-574 re-check after 10-17 15:00Z.
- RESPAWN rule (165db813 + D-78 4e101a59): respawn each lane BETWEEN tickets on a worktree cut from integration; scripts by abs path.
- BATCHES 27 bda180d2 + 28 63ff971c (gates GREEN) deployed in 2026.10.17-1 (details: git history). Flake boot.test.ts -> T-903.
- BATCH 29 ON INTEGRATION edde2073 (gate edde207 GREEN, suite 741s; quick-check 11 files green; first gate 4258f72 green, re-gated
  after 44fba442 T-623 browser image): T-524 S3c+T-733 S5, T-881 S1b, T-416 S2c (lead's mechanical controller.ts resolution
  67198848, APPROVE 9219), T-382 S1, T-781 S8c, T-675 R2c+R2d. Coordinator told T-731 9271.
## IN FLIGHT (6 of 6, D-71; lanes respawned per ticket, D-78; sonnet)
- T-924 GATE ALONE running: merge c7474004 (premerge-t924, wip/main-c747400; bg ba91nldwk). Quick-check a3cb8a9a green; QA PWG
  9644 (mutants refused by the guard hook: not run). Green -> land, tell coordinator T-924 + T-731 (deploy at once).
- BATCH 30 premerge-b30 25a1a36e (local): T-772 S2f, T-736 S3g, T-612 S1, T-868 S1-S3, T-436 S1+S2 (deploy note), T-379 S2
  b9dd11fd, format fix 787932e2 (lead checked format-only). After T-924 lands: merge integration, + T-860 S2c e78d727b (PWG
  9638; conflicts with T-924 in ruleGuard.ts), pack, quick-check, gate.
- QA BE aca53d2d (regitha): T-382 S2-S4 0ad8db63 (57 files) incl. authz of CI runs page + listPage bench numbers.
- BE INFRA 53c49384 (rossi): T-938 --pool-env names (exact line on ticket; blind review; coordinator lands).
- BE INFRA 2 e0715d99 (hasyim): T-921 browser init EPERM + self-heal without headers (dev rig = coordinator's).
- BACKEND 83bb50e6 (fadlilah): T-409 G3 supervisor adopts only its own chats.
- IMPL 2 0ce74ec7 (two.claude): T-436 S3 + T-772 S2g, Job queued. IMPL c68578a8 (sekar): T-425 S2, Job queued.
- Ended 02:3x between tickets (D-78): QA BE C, QA BE B, BE Infra 0f151084, Backend b367d0dd. New: T-939 job queue deadline.

## DECISIONS (binding)
- 00:35 Coordinator: 2nd workspace RESTART 00:50 UTC (browser image t623-2026.10.16-1). All 6 lanes told: push WIP, no Job after
  00:45, end `PAUSED <sha> <job> <next>`. After it: end interrupted lanes, respawn from PAUSED shas, re-run cut Jobs.
  Release 2026.10.17-1 (42b186b4, from 44fba442) holds batches 27+28, NOT 29 (edde2073): await live checks.
- 00:55 Resumed after restart 2: 6 stopped lanes ended; 6 respawned (4 QA + Backend + BE Infra; Impl's slot -> 2nd QA BE since
  QA held 6 items). QA lanes spawned with the ticket they report on (T-436, T-382, T-425, T-781) so their posts land (T-910).
- D-75 (+amend 1444d836): one Job per commit; the lead runs only the merge gate (gate-job.sh, one per batch); idle QA gets no-Job work.
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
- 01:45 D-78 (owner via coordinator, 4e101a59): only PRODUCTION and UAT wait for a person; all else -> "FOR THE COORDINATOR:"
  on the ticket with the exact change. Never tag owner-*/waits-owner/needs-person. Respawn lanes between tickets to load it.
- D-63: QA/ux/reviewer on SONNET (opus needs a `why`: security, gate, rule or large slice); the lead never implements or commits code.
- D-61: NO Agent-tool sub-agents, heavy work ONLY via scripts/job-run.sh or gate-job.sh, one at a time. Hand over before 250k.

## FOR THE COORDINATOR (D-78; each also on its ticket)
- T-938 job-run --pool-env adds E2E_QA_EMAIL/E2E_QA_PASSWORD (a loosening, T-384): BE Infra builds, blind review, coordinator lands.
- T-436 deploy note (b30): after deploy agents reach only vaults whose agentWorkspaces list names their workspace.
- T-924 deploy at once after its gate (urgent). T-921/T-923 image + pool rollout. Batch 29 edde2073 deploy + live checks.
- T-578 gate reuse: (a) portal CI store [lead default] (b) pipeline-only RBAC ConfigMap (c) accept risk (d) drop reuse.
- T-666 RBAC: workspace kohi-event can create/delete ConfigMaps in isnan-claudepilot (review 6168, can-i): narrow it.
- T-341 D needs a real Claude Code session; T-422 (sudo); T-306 item 4 / T-340; T-417 Bypass across sleep D-row; T-433 (2984);
  T-437/T-432 folder trust; T-868 allow line must not allow a SHOTS_TEST_MODE=1 prefix.
- T-476 lead may START a deploy whose release waits for a person
  (3813); T-491 Event token scope until T-426 (3965); deploys #35/#36/#37 production approval showed "auto", not changed by an agent;
  T-509 kit republish; T-594 alfian.isnan signed out; T-525 session_get + scribe tools + QA UI browser tools (5505); T-595 lane Bash (5443);
  T-591 #40 backfill after deploy (5511); T-325 S3 push door vs charter "only the main chat merges integration" + its token (5549);
  T-527 finding 4 (owner triggers tagging owner-checklist); T-657 reopen T-259/T-317/T-338; T-739 A scoring defs (scoring = person's wall).

## NEEDS A HUMAN (production and uat only, D-62/D-78)
- T-93 Konfersi production (owner checklist). T-610 pre-deploy read-only prod count of the 2 rows (through the coordinator).

## NEXT (in order, as slots free)
0. 01:55 coordinator re-triage decided on the ticket (9542-9549): T-594 closed into T-598. BE Infra queue: T-924 > T-938 > T-860 fups > T-921 >
   T-923 > T-911 > T-27 > T-598 > T-653 > T-654 > T-612 S2. Backend after T-382 S4: T-409 G3 > T-356 > T-30 (XL, 4 slices). Impl: T-379 S3 > T-33.
   QA (sonnet), next free slot: verify T-28 (bump, built) then T-294 (crew, built), then close on PASS.
1. b30 gate (+T-379 S2 merge b9dd11fd, trace 9534; T-436 deploy note: agents reach only vaults whose agentWorkspaces names them); T-924 gate ALONE; T-772 S2g (Impl); T-591 lastReleased fix; T-525 persona draft (8236). 2. T-401 in b24 (ack 8027 sat unseen 13:50-15:15: re-read HELD tickets' last comments each hour) -> T-426 S1e -> T-379 S2 3f11b28; deploys are the coordinator's. ticket_list fails: use ticket_get.
4. RTK: T-340 (person/coordinator) -> T-341 merge -> T-306 item 3. 5. T-537. 6. T-513. 7. T-472 live re-check (needs portal_status), T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-382, T-377, T-386, T-409, T-402, T-398,
   T-399, T-370 HOLD, T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-404 open till deployed.

LESSONS: a lane's rules are its worktree's .claude/settings.json: cut worktrees from integration (>= 165db813) for the absolute form; reply_of = LATEST reply only (verdict must be the last reply; T-860 S2 sat 20 min unseen: check the urgent ticket's comments too); node --test, never vitest; a gate-done notice needs action; dontAsk workers cannot read /tmp, merge, gate or wait, and Bash only in their spawn worktree (new branch = new worker); whole
test folders (T-574 red 10-15); integration moved during a gate = merge + re-gate (pack goes stale); FULL hashes; trailers in one block; status via Edit/Write ONLY; ancestor check before ff; NO status push while a gate runs (b23).
