# orchestrator status (2026-10-17 17:10 UTC, session 355881a3, continuation of de232389; older: git history)

## DONE
- Batches 22-26: git history (to 83b7213e), gates green. Close on "Coordinator live check" PASS. T-574 re-check after 10-17 15:00Z.
- RESPAWN rule (165db813 + D-78 4e101a59): respawn each lane BETWEEN tickets on a worktree cut from integration; scripts by abs path.
- BATCH 29 edde2073 (T-524 S3c, T-733 S5, T-881 S1b, T-416 S2c, T-382 S1, T-781 S8c, T-675 R2c+R2d) RELEASED 2026.10.17-2: close on live checks.
## IN FLIGHT (6 of 6, D-71; lanes respawned per ticket, D-78; sonnet)
- BATCH 30 LANDED 08feccc6 GATE GREEN (T-731 10494; deploy is the coordinator's): T-772 S2f, T-736 S3g, T-612 S1+S1b,
  T-868 S1-S3, T-436 S1+S2, T-379 S2, T-860 S2c, T-382 S2-S4. Close on live checks. LESSON: format commits break tests that
  read source with a regex: grep readFileSync(*.ts) tests and run them in the QC; re-run the pack check after each merge.
- BATCH 31 premerge/b31 dfb58bdd: T-436 S3+T-772 S2g fe676258, T-409 G3 ee75effd, T-382 S5 472e9015 + lead traces (T-595
  10495/10520: conflicts to ticket side; outline-hidden x3; supervisor.mjs left unformatted). GATE 4d25dc2 RED typecheck (premerge
  only): vaultBinding.test.ts:27 TS2349 (T-436 S3 assert.equal narrows to never) -> 1-line fix to lane 3753d3c2 (send when the
  portal is back; down since ~17:30) -> merge -> re-gate. LESSON: QA PASS without typecheck = "not verified: typecheck".
- T-938 259935e8 blind review PWC 10348 -> doc Major back to a3554d40 (after T-974) -> coordinator lands (QA account, T-938 10430).
- T-974 URGENT rule guard git argv: a3554d40, d8432f39 proof Job running; then blind review (rule class), coordinator removes deny lines.
- URGENT T-948 port proxy: FIX2 ac36971c RECHECK PWG 10516 (G13 onRevoked->sweep untested) -> FIX3 by 2a0edbd8 (10526) -> c691df71.
  Then premerge t948 (b2d62bfd + ac36971c + integration), QC appports+browser tests, gate, land, scratch-portal visual look; deploy
  own apps only until T-976. T-976 lands AFTER T-948 and switches PORTAL_COOKIES to SESSION_COOKIE/LEGACY (2a0edbd8).
- T-976 __Host- cookie 87d4a74f: QA PWG cabfb3d2 (10530), blind review PWC 0 blockers (10534): login clears old cookie + PORTAL_COOKIES
  switch at the rebase after T-948 (2a0edbd8); T-1042 >= 10-31 + socket stale-cookie test (comment refused; noted on T-976).
- T-382 S6 3753d3c2 70eac176 proof running (+ seesEverything fix) -> QA d9f18599 Job -> b31/b32. T-382 unassigned (10376).
- URGENT T-1043 MU2 S0a (D-82, plan 10460 + 10519): 2a0edbd8 can't reach worktree t1043-s0a (423d269f) -> after FIX3 end it and
  spawn an opus lane there (D-71 slot). S0b sockets,
  S0c MCP next; QA + blind security review each. Ahead of T-968/T-965.
- T-425 S2b 357ff021: mutant-B test fix on next free builder; be63acc8 re-checks. T-294 crew_post/read slice after T-948.
- Then: T-968 General Manager (D-80, 9969; S0 scribe, S2 MCP incl. T-965), T-971 H1+H2 (healer only detects/tickets; 9988), T-565, T-975.

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
