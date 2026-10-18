# orchestrator status (2026-10-17 23:45 UTC, session 355881a3; older entries: git history)

## DONE
- Batch 32 LANDED 22:54: integration 74599ece (gate claudepilot-gate-18d8e9d-f5f1 green on 18d8e9d0): T-382 S6, T-294 FIX1,
  T-1049. Relayed T-731 10876 -> coordinator deploys. Format sweep stays T-1032 (10857).
- Batch 31 in portal 2026.10.17-11; T-948 62a44a10 in 2026.10.17-12 (ON state = coordinator live check 10822). Close on live checks.
- T-860 S2c on integration (a87d00b8); the realpath guard side is the coordinator's. Older batches: git history.

## IN FLIGHT (6 of 6 workers, D-71; QA/review sonnet, D-63; ids in full in session_family)
- BATCH 33 GATING: premerge/b33 dc259a25 = integration + T-974 f70d333c (FIX3 PASS 10994; lead read ruleGuard diff:
  refusals only, fail closed). QC job-1fe3489c rc0 (31/31). Gate b0zeb5215 running. T-425 S2b+gaps 12acb9ed PASS
  (T-595 11065), testkit.ts conflict: marker branch ticket/T-425-s2b-int a3f79dd5 -> 3753d3c2 resolves -> batch 34.
  After landing: FOR THE COORDINATOR remove the text-matching `git -C` denies (T-974).
- T-980 (repos_list filter; worktree_create by path through can()) a3554d40, worked slice -> QA + blind.
- BATCH 34 READY: T-971 H1 FIX2 fdd38c6b (re-check PASS #10967), T-976 d68ab35c (blind PWG #11125, decisions 11135).
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
- T-968 S2b be6b3adc QA PWG #11080 (15/15 killed) -> nested mask fix 5688811c (11109), Job bj718gl5c -> delta + blind.
- T-971 H2 delta 03bc42d6 QA PWG #11062 (H5, H9 edges survive) -> edge tests 3753d3c2 (11110) -> re-check; blind on S1.
- T-565 FIX 103c4d80 QA PWG (T-595 10968) -> gap 1 9d1d1203 Job b3pik9awy rc0 (Y1-3 killed; T-595 11123); N11/N14 dropped
  (labels exist nowhere, 10973) -> delta c691df71 -> blind (infra).
- T-968 PRD fix a32754c3 (gaps 2-7) -> re-check d9f18599. T-968 S1 03fcd4c4 (2a0edbd8; seam, cpmt_, revoke,
  migration 793), fix 352194df (test was wrong, #11127), Job bcf1333pr -> QA c691df71 + blind d9f18599; lead reads seam/migration. T-1033 S1 rc 75 (11035) head
  53527bfa, Job blfnye6go rc1 (jobRun.test file timeout, a leftover process?) -> diagnosis Job -> fix -> QA + blind. T-921 4511c7be Job rc0 VOID (base test red) -> 515bb0c1, Job bl8pu6oc6 (green base first).
- T-251 (unknown usage) 3753d3c2: audit vs integration (decide.ts unknownUsage, t255.test), build only what is missing.
- T-1043 S0c (MCP tools through can()) 76845676 on ticket/T-1043-s0c, beside T-1065.
- T-961 (deploy outage: PriorityClass, headroom, release pre-check; 10887) -> QA + blind (infra); PriorityClasses in
  deploy/k3s/priorityclasses.yaml are FOR THE COORDINATOR if Argo can't create them.
- T-1065 (new: redact.ts misses short passwords/URL userinfo; 10888) 76845676 while its Job queues -> QA + blind.
- T-356 S1 64b4effa (MCP authz gaps 1-4; 10906) by 3753d3c2, Jobs pending. 10922: workspace resolver NOT wired (that is
  the multi-user switch); FR19 enforced by test + exemption list, not at start-up -> QA + blind; lead reads the authz diff.
- Queues: c691df71 S2b > T-976 > H2 delta > T-975 FIX2 > T-356 > T-425 gaps > T-565 delta. d9f18599 H2 S1 > S0b f5ae317e >
  H1 FIX2 > T-969 > T-974 FIX3 > T-565 > T-975 > PRD > S2b. a3554d40 T-974 > T-969 > H1 > T-961 rerun > T-975 FIX2.
  76845676 T-1065 + S0c (then the T-976 reader merge). 2a0edbd8 T-565 gap 1 + T-968 S1. 3753d3c2 H2 fix, T-356, T-425 gaps + T-251.

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
- T-382: pick a DOM test library. T-1032: QC format must skip files tests read with readFileSync.
- T-938: confirm the QA account is stg-only, low-privilege; job-run --pool-env loosening (T-384).
- T-666 RBAC narrowing; T-578 gate reuse; T-868 no SHOTS_TEST_MODE=1 prefix allow; T-921 rig door (11060); T-970 image build.

## NEEDS A HUMAN (production and uat only, D-62/D-78)
- T-93 Konfersi production (owner checklist). T-610 pre-deploy read-only prod count (through the coordinator).

## NEXT (in order, as slots free)
1. Batch 33: T-425 S2b + what passes (T-974, T-971 H1+H2 S1, T-975, T-969, T-968 S2a+S2b, T-1043 S0a+S0b, T-976).
2. T-1043 S0c MCP tools; T-968 S1 (after the PRD fix).
3. T-1042 (after T-976), T-30 (XL), T-33, T-379 S3 (paused), T-105, T-1031.

LESSONS: dontAsk lanes run Bash only in their spawn worktree and refuse git merge/restore: the lead pushes the merge (with
markers) to a new branch, the lane does `git switch -C <br> origin/<br>` and resolves by Edit. Never prettier files tests read
with readFileSync. Re-run `context-pack.sh --check HEAD` after every merge; integration moved during a gate = merge + re-gate.
A mutant line must prove it was applied (diff non-empty), on a GREEN base; a Job exits on its base rc. The status file: Edit/Write tools ONLY (23:47 slip, T-595). Full ids and full hashes only. Migration numbers: sorted versions on integration AND lane branches (file is by area). gate-job.sh in the background, timeout 7200000.
