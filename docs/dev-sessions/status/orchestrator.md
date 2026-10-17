# orchestrator status (2026-10-17 15:55 UTC, session 355881a3, continuation of de232389; older: git history)

## DONE
- Batches 22-26: git history (to 83b7213e), gates green. Close on "Coordinator live check" PASS. T-574 re-check after 10-17 15:00Z.
- RESPAWN rule (165db813 + D-78 4e101a59): respawn each lane BETWEEN tickets on a worktree cut from integration; scripts by abs path.
- BATCH 29 edde2073 (T-524 S3c, T-733 S5, T-881 S1b, T-416 S2c, T-382 S1, T-781 S8c, T-675 R2c+R2d) RELEASED 2026.10.17-2: close on live checks.
## IN FLIGHT (6 of 6, D-71; lanes respawned per ticket, D-78; sonnet)
- BATCH 30 premerge-b30: T-772 S2f, T-736 S3g, T-612 S1+S1b, T-868 S1-S3, T-436 S1+S2 (deploy note), T-379 S2, T-860 S2c,
  T-382 S2-S4, lead format commits (traces T-595 9742, 9916). QC 6259948c GREEN (16 tests; jobRun.test.ts to the gate, T-1032).
  GATE 67a6e53 RED: claudeversion.test.ts reads BASE_FLAGS as one line; MY format commit 0dd31914 split it (premerge only, not
  integration) -> e078b2f4 one line + prettier-ignore -> 2f5214f0 QC 0201c1a2 RED format (3 tickets files from merge 60da86be)
  -> merged integration again bc668213 -> prettier Job on the 3 files -> QC -> gate. LESSON: format commits break tests that
  read source with a regex; fmtcheck tokens can't see it: grep readFileSync(*.ts) tests and run them in the QC.
- T-938 DONE 259935e8 (Job 6bd127a4 rc0) -> blind review d9f18599 -> coordinator lands. Lane a3554d40 -> T-974 URGENT
  (rule guard git argv, ruleGuard.ts; rule class: blind review, coordinator removes deny lines after PASS).
- URGENT T-948 port proxy (9810): S1 BE INFRA 2 2a0edbd8 OPUS (security), ticket/T-948-port-proxy; app-<ws>-<port> subdomain (9811).
  S1 fix f70c72bd RECHECK PASS 10380 (c691df71 now reads FIX2). S2 d08465f9 RECHECK PASS 10189; UX code-read only (no browser in
  qa lane): visual look on the premerge scratch portal later. Blind review S1 (d9f18599) PWC 10219: 2 Majors (upstream timeout +
  bridge caps; upgrade lifetime) + minors -> FIX2 5d929014 by 2a0edbd8 (10220; Job queued); deploy before T-976 own apps only.
  Premerge t948 b2d62bfd (wip/t948-b2d62bf): QC running; then FIX2, gate, land. Paused: T-921 0dfff348, T-379 S3 9dfecffb.
- T-976 __Host- cookie (security; blind review + coord live check): 2a0edbd8 opus, test fix a418de31, Job queued.
  15:25 cluster full (node2 CPU 87% reserved): every Job queues ~1 h, several lost Pending; re-run once each (D-75).
- T-382 S5 DONE 472e9015 QA PWG (877726a5, T-595 10427) -> batch 31. S6 gap 3 (unbounded ci total) 3753d3c2, proof Job running.
  be63acc8 -> T-976 QA (code read; Job after builder rc). T-382 unassigned: comments refused, assign asked FOR THE COORDINATOR (10376).
- T-425 S2b 357ff021: QA be63acc8 PWG 9970 (mutant B survives) -> test fix on next free Backend slot; same QA re-checks (T-595 10014).
- T-436 S3 + T-772 S2g fe676258: QA PWG (T-595 10003) -> batch 31; permissions class: coordinator live check before close (D-81).
- T-294 PWG 9858: crew_post/read + idle-child reuse not built -> slice after T-948 (T-595 9871).
- After T-948, planned together: T-968 General Manager (D-80, plan 9969; S0 scribe + S2 MCP tools incl. T-965 first),
  T-971 self-healing (H1+H2 first; charter-wall conflict on healer landing rule lines FOR THE COORDINATOR 9988).
  T-409 G3 ee75effd QA PWG 9820 -> merge in b31; G3b fup after T-425 S2b (T-595 9823).
- Next builds as slots free: T-965 S1 (Backend respawn) + S2 (FE after T-948), T-382 S5. D-79: uat only on the owner's explicit request.

## DECISIONS (binding)
- 12:10 D-81 (owner via coordinator): risk-based review. Same builder keeps a ticket through all fixes; one QA pass, same QA re-checks;
  blind review / 2nd QA / post-deploy only for security, auth, permissions, rule files, infra, pipelines, migrations, money, uat/prod.
  Builders push their own ticket branch (`git push -u <remote> ticket/...`, no -q). T-948 S1 (security) keeps blind review; T-425 S2b one QA.
- 10:00 Restart (~07:00 UTC, /tmp wiped; my Claude hit its session limit 03:xx): 6 lanes ended + respawned from pushed heads
  (clean worktrees); lost Jobs re-run; T-924 re-gate re-run on the same commit (verdict unavailable). T-382 merges with gaps (9694).
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
0. 12:15 audit (T-595 10033): T-924 CLOSED live; T-403 closed; after T-948 BE Infra: T-612 S1b > T-974 (T-971 H1) > T-565 portal backup >
   T-975. Older order (9542): T-938 > T-860 fups > T-921 >
   T-923 > T-911 > T-27 > T-598 > T-653 > T-654 > T-612 S2. Backend after T-382 S4: T-409 G3 > T-356 > T-30 (XL, 4 slices). Impl: T-379 S3 > T-33.1. b30 gate (+T-379 S2 merge b9dd11fd, trace 9534; T-436 deploy note: agents reach only vaults whose agentWorkspaces names them); T-924 gate ALONE; T-772 S2g (Impl); T-591 lastReleased fix; T-525 persona draft (8236). 2. T-401 in b24 (ack 8027 sat unseen 13:50-15:15: re-read HELD tickets' last comments each hour) -> T-426 S1e -> T-379 S2 3f11b28; deploys are the coordinator's. ticket_list fails: use ticket_get.
4. RTK: T-340 (person/coordinator) -> T-341 merge -> T-306 item 3. 5. T-537. 6. T-513. 7. T-472 live re-check (needs portal_status), T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-382, T-377, T-386, T-409, T-402, T-398,
   T-399, T-370 HOLD, T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-404 open till deployed.

LESSONS: a lane's rules are its worktree's .claude/settings.json: cut worktrees from integration (>= 165db813) for the absolute form; reply_of = LATEST reply only (verdict must be the last reply; T-860 S2 sat 20 min unseen: check the urgent ticket's comments too); node --test, never vitest; a gate-done notice needs action; dontAsk workers cannot read /tmp, merge, gate or wait, and Bash only in their spawn worktree (new branch = new worker); whole
test folders (T-574 red 10-15); integration moved during a gate = merge + re-gate (pack goes stale); FULL hashes; trailers in one block; a bg command's exit = its LAST command (tail!): append `echo RC=$?` to the log; status via Edit/Write ONLY; ancestor check before ff; NO status push while a gate runs (b23).
