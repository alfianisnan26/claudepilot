# orchestrator status (2026-10-17 19:55 UTC, session 355881a3; older entries: git history)

## DONE
- Batches 22-30: git history (b30 08feccc6 gate green). Batch 29 released 2026.10.17-2. Close each on the coordinator's live checks.

## IN FLIGHT (6 of 6 workers, D-71; QA/review sonnet, D-63)
- BATCH 31 RELEASED: c9cf3089 is in release bbca47f4 (portal 2026.10.17-11, merged d244f466). Close its tickets on the coordinator's live checks.
- T-948 URGENT: gate b70da24 GREEN (claudepilot-gate-b70da24-35dc), but integration moved (949f37be) -> merged, pack fresh,
  premerge/t948 867873e0 -> GATE RE-RUN (bzg8mw9fp) -> ff land -> visual -> coordinator deploys. QC: format only on 12 shared files (10722).
- T-976 FIX 42772333 + doc 1b99696f (QA PWG 10664): re-merge the T-948 final head, land after T-948.
- BATCH 32 ready: T-425 S2b, T-382 S6, T-294 FIX1 a30505db (PASS 10754), T-1049 6c30af2d (PWG 10771). Premerge after T-948.
- T-1043 S0a FIX1 3c907e76 (badfb8da rc0, 274/274) -> delta c691df71 + blind d9f18599. S0b: lead merged S0a in, 789474e4
  (trace T-1043 10772) -> 76845676 continues. Denial = 404 (10605).
- T-974 URGENT FIX 6abbf44f blind PWG 10774 (10 mutants killed) -> FIX2 `git remote set-url/add` + -c case row, a3554d40 first.
- T-1043 S0a QA FAIL 10788 (M14, M16) + blind PWG 10775 (app.all behind ALL /api/*) -> S0a+S0b ONE unit (10790), fixes on S0b
  by 76845676; sockets via sessionToken. T-976 note 10791 (sockets read the cookie name).
- 21:20 cluster Job queue 16 deep: QA lanes code-read first, mutants in one Job when the queue < 5 (T-975 QA c691df71).
- T-968 PRD PWG 10735 -> PRD fix 2a0edbd8 (decision 10779: cards for guarded classes) -> re-check d9f18599.
- T-938 FIX2 73b8137c re-check PASS 10685 -> coordinator lands (T-938 10695).
- T-971 H1 25d9d9b1 QA PWG 10737 -> FIX gaps 1+3 a3554d40 (10770) -> delta d9f18599 -> batch 32.
- T-971 H2 S1 restart recovery -> 3753d3c2 (ticket/T-971-h2, decision T-971 10736: no auto Bypass).
- T-565 S1 64f7c137 QA PWG (relay T-595 10773) -> FIX gaps 1+2 2a0edbd8 -> delta c691df71 -> blind (infra).
- T-968 S0 PRD dce0e9f7 -> QA d9f18599 (doc). S2a 896daa98 (f6a9cc80 rc0, 105/105) -> QA + blind. S2b schedules -> 2a0edbd8.
- T-975 eacf6074 QA FAIL 10793 (hand-off race: cancel-queued vs #toRunner; migration 787 clash with T-294) -> FIX a3554d40
  after T-974 FIX2 (decision 10799: T-975 takes 788) -> delta c691df71 -> blind. T-969 verdict role -> a3554d40 (QA + blind).
- T-968 S2a 896daa98 PWG x2 (QA 10802, blind 10803 Job c04c05e7 12/13 killed) -> gaps fixed in S2b by 2a0edbd8 (10804);
  S2a+S2b land together after the c691df71 delta + d9f18599 blind.
- 21:30 both QA lanes idle (every verdict waits on a builder fix; T-595 note). 20:45 third-QA-lane plan WITHDRAWN.
- Lanes: c691df71 QA (S0a delta > T-565 delta > T-968 S2a); d9f18599 QA (T-974 > S0a blind > T-971 delta > PRD);
  a3554d40 T-971 fix + T-969; 76845676 T-1043 S0b; 3753d3c2 T-971 H2; 2a0edbd8 T-565 fix + T-968 S2b.

## DECISIONS (binding)
- D-81 risk-based review: same builder through all fixes; one QA, the same QA re-checks; blind review only for security, auth,
  permissions, rule files, infra, pipelines, migrations, money, uat/prod.
- Coordinator order: T-948 > T-1043 MU2 S0 (D-82, blind review per slice) > T-968 (D-80) > T-971 H1+H2, T-974, T-975, T-565.
- The coordinator runs all deploys; I start none. I gate with gate-job.sh before every merge and tell T-731 when a batch lands.
- 17:40 pace order: no idle lanes; a lane waiting on its Job takes the next slice. D-75 stays: one Job per commit.
- D-78: only production/uat go to a person; all else "FOR THE COORDINATOR:" on the ticket. D-70 feed lanes by session_message.
- D-61 nothing heavy in the pod; D-66 the lead runs QC at premerge (lanes' allow lists refuse it, T-586).

## FOR THE COORDINATOR (D-78; each also on its ticket)
- T-948 after landing: deploy with PORT_PROXY_HOST_SUFFIX and the claudepilot-app-ports route. T-976: live Traefik X-Forwarded-Proto.
- T-974 after a blind PASS: remove the text-matching `git -C` deny lines.
- T-565: assign it to session 355881a3; name the backup bucket and its secret (BACKUP_S3_*).
- T-382: assign it; pick a DOM test library. T-1032: QC format must skip files tests read with readFileSync.
- T-938: confirm the QA account is stg-only, low-privilege; job-run --pool-env loosening (T-384).
- T-436 deploy note: agents reach only vaults whose agentWorkspaces names their workspace.
- T-666 RBAC narrowing; T-578 gate reuse choice; T-868 allow line must not allow a SHOTS_TEST_MODE=1 prefix.
- Older: T-341 D, T-422, T-306/T-340, T-417, T-433, T-437/T-432, T-476, T-491, T-509, T-525, T-591, T-325 S3, T-527, T-657, T-739.

## NEEDS A HUMAN (production and uat only, D-62/D-78)
- T-93 Konfersi production (owner checklist). T-610 pre-deploy read-only prod count (through the coordinator).

## NEXT (in order, as slots free)
1. Batch 32: T-425 S2b, T-382 S6, plus what passes (T-294, T-938, T-974, T-1049).
2. T-948 land, then T-976. T-1043 S0b sockets, S0c MCP tools.
3. T-968 General Manager (S0 scribe, S2 MCP incl. T-965), T-971 H2, T-975.
4. T-356, T-30 (XL), T-33, T-921, T-379 S3 (paused).

LESSONS: dontAsk lanes run Bash only in their spawn worktree: push new branches from the main checkout, the lane does
`git checkout -B <br> origin/<br>`. Never prettier files tests read with readFileSync. Re-run `context-pack.sh --check HEAD`
after every merge; integration moved during a gate = merge + re-gate. QA PASS without a typecheck Job = "not verified: typecheck".
Full session ids and full commit hashes only. Start gate-job.sh in the background with timeout 7200000: Pending alone may last 5400 s,
and a killed watcher deletes the Job (T-948 20:20).
