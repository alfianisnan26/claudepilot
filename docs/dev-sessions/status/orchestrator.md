# orchestrator status (2026-10-18 05:20 UTC, session 355881a3; older entries: git history)

## DONE
- CLOSED 07:00 (stale since the 06:4x session end put them back in the queue): T-611 (ff4eaf47, QA PWG #8715, blind APPROVE
  #8537) and T-1049 (6c30af2d in b32, QA PWG #10771). T-251 CLOSED 05:18.
- Batch 33 LANDED: T-974 f70d333c (slip closed, re-gate GREEN 03:00, T-731 11206).

## IN FLIGHT (6 of 6 workers, D-71; QA/review sonnet, D-63; ids in full in session_family)
- DEPLOY #365 (rmvcyeslw4a7ecb, 62a44a10, prod, actor "ui") ran with gate=false (the tree was gated by gate-job, 10823):
  reported on T-731 11343; the coordinator opened incident T-1082. Its post-mortem is the coordinator's.
- BATCH 34: premerge/b34 037f7e4b (pushed) = integration 5e84f4d7 + T-971 H1 (+fmt f6983797) + T-976 (+fmt 99f8bb69) + T-425
  2b57efce + T-565 55f5aa8e; app.ts conflict (T-976 setSessionCookie vs T-968 healManager): kept both; pack fresh. QC#1 expired in queue
  (3600 s, ran nothing); QC#2 + gate#1 killed by the 05:3x integrity recovery -> QC#3 bau88mbxq + gate#2 bg1xhlemz on 037f7e4b running.
  Then two-step landing -> T-731. T-969 joins the next batch after V5. Rule until the queue drains: ONE Job per lane.
- T-968 (coordinator builds S1 runtime/S3/S4/S6; this crew lands S1-token + S2 only). S1-token 5ccfb52c rc0, QA PWG #11312
  -> fix a8fca5a3 (2a0edbd8, Job b1gahci5o) -> re-check c691df71; blind PWG 11365 (K8 -> test ccef3ef4, own Job;
  K12 = a8fca5a3). S2 e605c835 Job bno2lrpwq. S2b blind PWG 11302 -> last_error
  untrusted fix e605c835 (Job after a8fca5a3) -> delta c691df71 + blind d9f18599. Integration holds c6c4a589 (FAILED security
  review; fixes on coord/T-968-gm): no deploy until T-731 says so.
- T-1083 URGENT (D-84: job-run places Jobs on the cluster or the owner's Mac) -> 2a0edbd8, ahead of T-1079. Plan 11383:
  S1a 9c7022c4 (Job after K8; QA PWG by read #11426; blind d9f18599). S1b design rev2 #11493 accepted: door /jobrun/mac/*,
  own jobrun_tokens table (migration block 880-889, decided 05:25), admin-only mint; S1b-1 token+authz, S1b-2 Mac exec,
  S1b-3 placement; blind per slice. agent.json volumes, JOB_RUN_MAC_TOKEN, deploy FOR THE COORDINATOR (T-731 11389).
- T-1079 (after T-1083 S1 is in QA; owner: Konfersi stg release docs per module into vault 98af7d16def1, reuse releaseReport.ts) 2a0edbd8, S1+S2 16fee55e.
- 2a0edbd8 Jobs: T-921 db1d8d19 rc0, QA PWG #11350 (J1, J4 survive) -> tests (11368) -> delta c691df71 -> blind; T-257 d34f47b2 rc1 (test bug) -> fix e22ae23d, Job after T-968's two;
  T-976 fmt re-run baov0fphs (patch lost to $OUT), T-968 a8fca5a3 b1gahci5o, T-565 bzq96a9ey on 59451a5f running.
- T-1033 53527bfa QA mutants #11449: D1, D2 SURVIVED -> same builder 2a0edbd8 (tests + default 3600 s, decision #11467).
- T-119 S1a 11e16382, S2a bd1a5c90 (Jobs queued) -> S1b API (blind: authz route), 3753d3c2, sonnet. S1b-2 = option A. T-980 dbb1bd76 rc0 8/8, 4 killed -> QA.
- T-968 S1 delta a8fca5a3 QA PASS #11509; K8 ccef3ef4 rc0 7/7 (#11646); S1 fmt 79c2d25c check bsrlhcxps; S2 needs fmt (#11732). T-523 + T-402 audits -> a3554d40.
- 76845676: S0b x T-976 aaa9169f rc1 (5/77: member 403 on T-976 team routes, 403->404 in 2 tests, teamsSso:162 cookie
  set twice; asked: T-976 or S0b?) -> fix, re-queue -> S0c 78b0e668 -> T-1065+T-1084; meanwhile T-1094 (urgent, blind).
- a3554d40 Pilot tools 401 since the recovery (FOR THE COORDINATOR T-595 #12036): T-402 rc0 105/105, T-523 covered by
  T-1033; now T-524 open done-items (OOM message plus test, master under 85% for a busy hour, measured).
  T-961 green 128/128; T-1076 fix cae18cd6 proof bdo9erb2x queued. T-975 FIX2 3a21e02a delta QA PWG #11446 -> blind d9f18599.
- 3753d3c2: T-971 d8189e5f Job bpwzt2g06 (B10, M11 fixed); T-634 0f4ffde6 QA PWG #11432 -> C2 test; T-356 N8 Job.
- c691df71 (QA): T-968 first; T-1033 53527bfa (rc0, 8 killed) -> blind; T-277 spot-check; T-1058 PWG (already closed).
- d9f18599 (QA/blind): T-968 S2b H4/H5/H12 (bq9f0174k), S1-token blind; then T-969 V5, T-975, T-970 QA.
- T-975 FIX2 tests (a3554d40) -> delta c691df71 -> blind (mig 788). T-970 5a0fa697 rc0 -> QA; image build FOR THE COORDINATOR.
- T-565 9d1d1203 QA PWG (cfbdbfb0, T5 survived) -> T5 fix 59451a5f Job b7aafa4e rc0, QA PWG; blind PWG (T-595) -> README 55f5aa8e -> READY, into batch 34;
  image tag + bucket versioning at apply FOR THE COORDINATOR.
- T-1065 3258ec46 QA PWG #11410 (prose colon over-cut, PRD line) + T-1084 (token-shaped literal valueRedact.test.ts:9)
  -> 76845676 -> blind d9f18599. T-980 fix dbb1bd76 (bpc5x0blu) -> QA c691df71.
- T-356 S1 e03d7f21 QA PWG #11120 (N7 `/` guard authz.ts:171 survived) -> N7 test 3753d3c2 (11380) -> delta -> blind; lead reads authz.

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
- Incident T-1082 (deploy #365 gate=false): its post-mortem and the check that refuses gate=false without the owner.
- Job capacity: queue timeouts and Pending on memory (T-595 10932, 11197, 11282, 11285).
- T-961 PriorityClasses if Argo can't create them; T-974 remove the text-matching `git -C` denies (after T-425 lands).
- T-565 (now mine, 11482): name the backup bucket and its secret (BACKUP_S3_*). T-257 DECISIONS row (11198).
- T-948: PORT_PROXY_HOST_SUFFIX and the claudepilot-app-ports route. T-976: live Traefik X-Forwarded-Proto (10855).
- T-1058 pre-push hook for the context-pack check. T-382 DOM test library; T-1032 QC format skips readFileSync files.
- a3554d40 Pilot tools 401 (T-595 12036); `git apply <job-out patch>` for 2a0edbd8 (T-968).

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
