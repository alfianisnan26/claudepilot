# orchestrator status (2026-10-18 04:35 UTC, session 355881a3; older entries: git history)

## DONE
- Batch 33 LANDED: T-974 f70d333c. Slip (pushed 76bdc9d0 before its re-gate; T-595 11166) closed: re-gate GREEN 03:00,
  hold lifted on T-731 11206. Flaky unavailable.s2.test.ts:75 -> T-1076.
- Batch 32 LANDED 22:54 (74599ece): T-382 S6, T-294 FIX1, T-1049. Older batches: git history.

## IN FLIGHT (6 of 6 workers, D-71; QA/review sonnet, D-63; ids in full in session_family)
- DEPLOY #365 (rmvcyeslw4a7ecb, 62a44a10, prod, actor "ui"): gate step `skipped (input gate=false)`. The tree was gated by
  gate-job (10823), but the pipeline gate was off. Asked the coordinator for the owner's word (T-731 11343); if there is none, an incident.
- BATCH 34: premerge/b34 0a9685ea = integration + T-971 H1 fdd38c6b + T-976 d68ab35c; gate GREEN at aa58499a; QC format FAIL
  (7 batch files -> format commits a3554d40 (H1), 2a0edbd8 (T-976, Job bdlp8stxq); 8 older -> T-1080). Then add T-425 2b57efce
  (rc0), T-969 after V5 -> merge integration -> context-pack check -> QC -> gate -> two-step landing -> T-731.
- T-968 (coordinator builds S1 runtime/S3/S4/S6; this crew lands S1-token + S2 only). S1-token 5ccfb52c rc0, QA PWG #11312
  -> fix a8fca5a3 (2a0edbd8, Job b1gahci5o) -> re-check c691df71; blind PWG 11365 (K8 -> test ccef3ef4, own Job;
  K12 = a8fca5a3). S2 e605c835 Job bno2lrpwq. S2b blind PWG 11302 -> last_error
  untrusted fix e605c835 (Job after a8fca5a3) -> delta c691df71 + blind d9f18599. Integration holds c6c4a589 (FAILED security
  review; fixes on coord/T-968-gm): no deploy until T-731 says so.
- T-1083 URGENT (D-84: job-run places Jobs on the cluster or the owner's Mac) -> 2a0edbd8, ahead of T-1079. Plan 11383:
  No door from the pod to the Mac's Docker -> S1a fd67379b (Job after K8; QA c691df71 read), S1b portal door (authz, scoped
  token); agent.json volume policy, token, deploy FOR THE COORDINATOR (T-731 11389). Then S2 fail-safe, S3 measure.
- T-1079 (after T-1083 S1 is in QA; owner: Konfersi stg release docs per module into vault 98af7d16def1, reuse releaseReport.ts) 2a0edbd8, S1+S2 16fee55e.
- 2a0edbd8 Jobs: T-921 db1d8d19 rc0, QA PWG #11350 (J1, J4 survive) -> tests (11368) -> delta c691df71 -> blind; T-257 d34f47b2 rc1 (test bug) -> fix e22ae23d, Job after T-968's two;
  T-976 fmt re-run baov0fphs (patch lost to $OUT), T-968 a8fca5a3 b1gahci5o, T-565 bzq96a9ey on 59451a5f running.
- 3753d3c2: T-971 H2 head bbfd0ae3 Job b2rxfgopr (21 mutants); T-634 test 0f4ffde6 (Job after b2rxfgopr); T-251 QA PWG
  #11340 (citation only) -> reassign to me -> close.
- 76845676: T-1043 S0c 558c74ed rc0 (66/66; mutants next, redo on ticket/T-1043-s0c-on-s0b after S0b); S0b x T-976 4a57abe6
  Job b9829len2; T-1065 redact.ts worked -> QA + blind.
- a3554d40: H1 format patch, then T-961 sched-lib.sh (T-961 S1 613139e3 proof Job rerun), T-980 -> QA + blind.
- c691df71 (QA): T-968 first; T-1033 53527bfa (rc0, 8 killed) -> blind; T-277 spot-check; T-1058 PWG (already closed).
- d9f18599 (QA/blind): T-968 S2b H4/H5/H12 (bq9f0174k), S1-token blind; then T-969 V5, T-975, T-970 QA.
- T-975 FIX2 tests (a3554d40) -> delta c691df71 -> blind (mig 788). T-970 5a0fa697 rc0 -> QA; image build FOR THE COORDINATOR.
- T-565 9d1d1203 QA PWG (cfbdbfb0, T5 survived) -> T5 fix 59451a5f Job b7aafa4e rc0, QA PWG; blind PWG (T-595) -> README 55f5aa8e -> READY, into batch 34;
  image tag + bucket versioning at apply FOR THE COORDINATOR.
- T-1065 3258ec46 QA PWG #11410 (prose colon over-cut, PRD line) + T-1084 (token-shaped literal valueRedact.test.ts:9)
  -> 76845676 -> blind d9f18599. T-980 fix dbb1bd76 (bpc5x0blu) -> QA c691df71.
- T-356 S1 e03d7f21 QA PWG #11120 (N7 `/` guard authz.ts:171 survived) -> N7 test 3753d3c2 (11380) -> delta -> blind; lead reads authz.
- 04:38 a3554d40 and c691df71 processes died, then resumed; c691df71's Jobs were still alive. T-1043 S0b blind PWG #11081 (D5, D7) with 76845676 PRIORITY.

## DECISIONS (binding)
- D-81 risk-based review: same builder through all fixes; one QA, the same QA re-checks; blind review only for security, auth,
  permissions, rule files, infra, pipelines, migrations, money, uat/prod.
- Coordinator order: T-948 > T-1043 MU2 S0 (D-82, blind review per slice) > T-968 (D-80) > T-971 H1+H2, T-974, T-975, T-565.
- The coordinator runs all deploys; I start none. I gate with gate-job.sh before every merge and tell T-731 when a batch lands.
- Owner order 2026-10-18: WIP 2 per lane (one slice on a Job, one worked); never hold lanes. At most 3 Jobs at once, gates first.
  D-75 stays: one Job per commit.
- D-78: only production/uat go to a person; all else "FOR THE COORDINATOR:" on the ticket. D-70 feed lanes by session_message.
- D-61 nothing heavy in the pod; D-66 the lead runs QC at premerge (lanes' allow lists refuse it, T-586).
- The pipeline gate stays on; only the owner's own word turns it off (T-731 10699).
- D-84 (owner, 04:45): Jobs load-balance onto the owner's Mac; the gate, --pool-env, images and --big stay on the cluster (T-1083).
- 03:15 owner order (T-968 11240): coordinator builds T-968 S1 runtime/S3/S4/S6; this crew lands S1-token + S2 only.

## FOR THE COORDINATOR (D-78; each also on its ticket)
- Deploy #365's gate=false: the owner's word or an incident (T-731 11343).
- Job capacity: queue timeouts and Pending on memory (T-595 10932, 11197, 11282, 11285).
- T-961 PriorityClasses if Argo can't create them; T-974 remove the text-matching `git -C` denies (after T-425 lands).
- T-565: assign to session 355881a3; name the backup bucket and its secret (BACKUP_S3_*). T-257 DECISIONS row (11198).
- T-948: PORT_PROXY_HOST_SUFFIX and the claudepilot-app-ports route. T-976: live Traefik X-Forwarded-Proto (10855).
- T-1058 pre-push hook for the context-pack check. T-382 DOM test library; T-1032 QC format skips readFileSync files.
- T-938, T-666, T-578, T-868 (older, git history); T-921 rig door (11060); T-970 image build (11160).

## NEEDS A HUMAN (production and uat only, D-62/D-78)
- T-93 Konfersi production (owner checklist). T-610 pre-deploy read-only prod count (through the coordinator).

## NEXT (in order, as slots free)
1. Batch 34 (format commits, + T-425, T-969); then T-1043 S0b, T-968 S1-token/S2 landing, T-975, T-565.
2. T-1042 (after T-976 is live), T-30 (XL), T-33, T-379 S3 (paused), T-105, T-1031.

LESSONS: dontAsk lanes run Bash only in their spawn worktree and refuse git merge/restore: the lead pushes the merge (with
markers) to a new branch; the lane resolves it by Edit. Never run prettier on files tests read with readFileSync. Run
`context-pack.sh --check HEAD` after every merge. Landing is two commands: (1) `git diff --stat <gated> origin/integration --
. ':!docs/dev-sessions/status'` and read it, (2) push only if it is empty. A mutant line must prove it was applied, on a
GREEN base. The status file: Edit/Write ONLY. Full ids and hashes. Migration numbers: check integration AND lane branches.
gate-job.sh runs in the background (timeout 7200000). `git -C` is refused by the guard: cd instead. A Job has no $OUT:
write a patch to the repo root and name it with `--artifacts fmt.patch --out job-out/` (job-run.sh:27; lost 74feba75).
