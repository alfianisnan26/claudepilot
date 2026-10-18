# orchestrator status (2026-10-18 02:45 UTC, session 355881a3; older entries: git history)

## DONE
- Batch 33 LANDED: T-974 f70d333c. Slip (pushed 76bdc9d0 before its re-gate; T-595 11166) closed: re-gate GREEN 03:00,
  hold lifted on T-731 11206. Flaky unavailable.s2.test.ts:75 -> T-1076.
- Batch 32 LANDED 22:54 (74599ece): T-382 S6, T-294 FIX1, T-1049. Batch 31 / T-948 live: close on live checks.
- T-860 S2c on integration (a87d00b8); the realpath guard side is the coordinator's. Older batches: git history.

## IN FLIGHT (6 of 6 workers, D-71; QA/review sonnet, D-63; ids in full in session_family)
- T-425 S2b+gaps 12acb9ed PASS (T-595 11065), testkit.ts conflict: ticket/T-425-s2b-int a3f79dd5 -> 3753d3c2 -> b34.
  After landing: FOR THE COORDINATOR remove the text-matching `git -C` denies (T-974).
- T-980 (repos_list filter; worktree_create by path through can()) a3554d40, worked slice -> QA + blind.
- BATCH 34: premerge/b34 aa58499a = integration + T-971 H1 fdd38c6b (PASS #10967) + T-976 d68ab35c (blind PWG #11125, 11135;
  lead read sessionCookie.ts). QC bx4ymzpso running; gate bkf0swzt3 running (context pack fresh).
  Next in: T-425 (conflict), T-969 (blind PWG 10969; V5 cross-workspace mutant rerun by d9f18599).
- T-971 H2: blind #10978 (a) resumes a stopped session, (b) B13, (c) unscrubbed `why`, (d) B7 + QA edges -> one fix 3753d3c2 (11134).
- T-1043 S0b blind PWG #11081 (D5 live per-message check untested, D7) + T-976 merge with markers ticket/T-1043-s0b-976
  0d71c9fb -> 76845676 (one reader = T-976 sessionCookie.ts) PRIORITY. T-968 PRD gaps (a)(b) decided 11136 -> 2a0edbd8.
- T-961 S1 613139e3: its proof Job timed out in the queue (feea6e9e, 3600 s), rerun later. T-974 FIX3 Job bctygk2fn queued.
  a3554d40 then runs T-969 > T-971 H1 > T-975 > T-961, one at a time. The job-run queue is ~14 deep, 2 per chat (T-595 coordinator note).
- T-975 FIX 6650e8ff QA FAIL 10926, tests only (Q1, Q2 survive; R5 gap; #retry/#finishFailed rewrite a cancelled run;
  links.test 12/12 x3, not this change) -> FIX2 a3554d40 (after T-969/H1 Jobs) -> delta c691df71 -> blind d9f18599 (mig 788).
- T-976 a2da98cb QA PWG #11040 (C6 browser socket survived) -> gap fix d68ab35c (2a0edbd8: socket.test.ts handshakes,
  decode-fallback pin; index.ts wiring left as written gap), Job bplwz9ct5 rc0 (C6, D1 killed) -> delta PWG #11066 -> blind d9f18599 on d68ab35c.
  T-1042 audit only (2a0edbd8), build after T-976 is live.
- T-968 S2b be6b3adc QA PWG #11080 (15/15 killed) -> nested mask fix 5688811c (11109), Job bj718gl5c rc0 -> delta c691df71 + blind d9f18599.
- T-970 5a0fa697 (Chromium 1.62.1 in the job image) Job b3sgbc372 rc0 -> QA d9f18599; image build FOR THE COORDINATOR #11160.
- T-971 H2 delta 03bc42d6 QA PWG #11062 (H5, H9 edges survive) -> edge tests 3753d3c2 (11110) -> re-check; blind on S1.
- T-565 FIX 103c4d80 QA PWG (T-595 10968) -> gap 1 9d1d1203 Job b3pik9awy rc0 (Y1-3 killed; T-595 11123); N11/N14 dropped
  (labels exist nowhere, 10973) -> delta c691df71 -> blind (infra).
- T-968 PRD fix a32754c3 (gaps 2-7) -> re-check d9f18599. T-968 S1 03fcd4c4 (2a0edbd8; seam, cpmt_, revoke,
  migration 793), fix 352194df (test was wrong, #11127), Job bcf1333pr -> QA c691df71 + blind d9f18599; lead reads seam/migration. T-1033 S1 rc 75 (11035) head
  53527bfa, Job blfnye6go rc1 (jobRun.test file timeout, a leftover process?) -> diagnosis Job -> fix -> QA + blind. T-921 515bb0c1 Job bl8pu6oc6 rc0 (12/12, 4 killed; #11142) -> QA c691df71 -> blind.
- T-251 (unknown usage) 3753d3c2: audit vs integration (decide.ts unknownUsage, t255.test), build only what is missing.
- T-1043 S0c (MCP tools through can()) 76845676 on ticket/T-1043-s0c, beside T-1065.
- T-961 (deploy outage: PriorityClass, headroom, release pre-check; 10887) -> QA + blind (infra); PriorityClasses in
  deploy/k3s/priorityclasses.yaml are FOR THE COORDINATOR if Argo can't create them.
- T-1065 (new: redact.ts misses short passwords/URL userinfo; 10888) 76845676 while its Job queues -> QA + blind.
- T-356 S1 64b4effa (MCP authz gaps 1-4; 10906) by 3753d3c2, Jobs pending. 10922: workspace resolver NOT wired (that is
  the multi-user switch); FR19 enforced by test + exemption list, not at start-up -> QA + blind; lead reads the authz diff.
- T-968 (a) bdd1a3ce any sign-out revokes cpmt_ (Job bes6vu30j), (b) c6cc0ffe manager refused ticket_close (was ALLOWED
  before; Job bohgvhpk1). QA HOLE: ticket_update status done still closes for a manager (service.ts:1486) -> fix 2a0edbd8 FIRST (11189).
  2a0edbd8 then: T-565 T5 negative case (T-595 11179), T-921 heal.test.mjs under gate collection (11180), T-257 option A (11187).
  T-277 ALL MET (11186) -> QA spot-check c691df71 -> close.

## DECISIONS (binding)
- D-81 risk-based review: same builder through all fixes; one QA, the same QA re-checks; blind review only for security, auth,
  permissions, rule files, infra, pipelines, migrations, money, uat/prod.
- Coordinator order: T-948 > T-1043 MU2 S0 (D-82, blind review per slice) > T-968 (D-80) > T-971 H1+H2, T-974, T-975, T-565.
- The coordinator runs all deploys; I start none. I gate with gate-job.sh before every merge and tell T-731 when a batch lands.
- 17:40 pace order: no idle lanes; a lane waiting on its Job takes the next slice. D-75 stays: one Job per commit.
- Owner order 2026-10-18 (via the coordinator): WIP 2 per lane, one slice on a Job and one worked; never hold lanes for
  results. The queue runs at most 3 Jobs at once, gates first. Applied 00:44, list on T-731 10977.
- D-78: only production/uat go to a person; all else "FOR THE COORDINATOR:" on the ticket. D-70 feed lanes by session_message.
- D-61 nothing heavy in the pod; D-66 the lead runs QC at premerge (lanes' allow lists refuse it, T-586).
- The pipeline gate stays on; only the owner's own word turns it off (T-731 10699).

## FOR THE COORDINATOR (D-78; each also on its ticket)
- Deploy batch 32 (74599ece). T-948: PORT_PROXY_HOST_SUFFIX and the claudepilot-app-ports route. T-976: live Traefik X-Forwarded-Proto;
  cookie-shadowing nuisance until T-976 is live (10855).
- job-run capacity or queue timeout: the queue is ~14 deep, so proof Jobs time out unrun (T-595 10932).
- T-961: the cluster-scoped PriorityClass objects, if Argo cannot create them (the builder names them).
- T-974 after the FIX3 re-check: remove the text-matching `git -C` deny lines.
- T-565: assign it to session 355881a3; name the backup bucket and its secret (BACKUP_S3_*).
- T-382 DOM test library; T-1032 QC format skips readFileSync files; T-938 QA account stg-only, --pool-env (T-384).
- T-666, T-578, T-868 (older, see git history); T-921 rig door (11060); T-970 image build.

## NEEDS A HUMAN (production and uat only, D-62/D-78)
- T-93 Konfersi production (owner checklist). T-610 pre-deploy read-only prod count (through the coordinator).

## NEXT (in order, as slots free)
1. Batch 34 (re-cut on integration after the 76bdc9d0 re-gate) + T-425, T-969; then T-1043 S0b, T-968 S1/S2, T-975, T-565.
2. T-1042 (after T-976), T-30 (XL), T-33, T-379 S3 (paused), T-105, T-1031.

LESSONS: dontAsk lanes run Bash only in their spawn worktree and refuse git merge/restore: the lead pushes the merge (with
markers) to a new branch, the lane does `git switch -C <br> origin/<br>` and resolves by Edit. Never prettier files tests read
with readFileSync. Re-run `context-pack.sh --check HEAD` after every merge; integration moved during a gate = merge + re-gate BEFORE the push: landing is two separate commands, (1) `git diff --stat <gated> origin/integration -- . ':!docs/dev-sessions/status'` and read it, (2) push only if it is empty (02:40 slip).
A mutant line must prove it was applied (diff non-empty), on a GREEN base; a Job exits on its base rc. The status file: Edit/Write tools ONLY (23:47 slip, T-595). Full ids and full hashes only. Migration numbers: sorted versions on integration AND lane branches (file is by area). gate-job.sh in the background, timeout 7200000.
