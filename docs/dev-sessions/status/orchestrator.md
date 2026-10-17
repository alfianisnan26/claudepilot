# orchestrator status (2026-10-17 23:40 UTC, session 355881a3; older entries: git history)

## DONE
- Batch 32 LANDED 22:54: integration 74599ece (gate claudepilot-gate-18d8e9d-f5f1 green on 18d8e9d0): T-382 S6, T-294 FIX1,
  T-1049. Relayed T-731 10876 -> coordinator deploys. Format sweep stays T-1032 (10857).
- Batch 31 in portal 2026.10.17-11; T-948 62a44a10 in 2026.10.17-12 (ON state = coordinator live check 10822). Close on live checks.
- T-938 FIX2 73b8137c re-check PASS 10685 -> the coordinator lands it (T-938 10695). Older batches: git history.

## IN FLIGHT (6 of 6 workers, D-71; QA/review sonnet, D-63; ids in full in session_family)
- T-425 S2b merge e2e4a2b6 (bvl4mr4k1 rc0, 851/851; PRD hunk taken from integration by lead 0d1afd3b) -> QA delta c691df71 -> b33.
- T-974 FIX2 42b95954 BLIND PWG 10892 -> FIX3 test rows (prune/update allowed on record, set-url --add/--delete refused;
  10902) a3554d40 -> re-check d9f18599 -> b33 -> FOR THE COORDINATOR: remove the text-matching `git -C` denies.
- T-971 H1 FIX fade65c2 (a0d0b91a rc0, 11/11) -> delta d9f18599 -> b33.
- T-971 H2 S1 11d5a5a1 QA PWG 10847 -> FIX 03bc42d6 (Job running) + deterministic race test (M11) by 3753d3c2 -> QA delta
  c691df71; blind d9f18599 on 11d5a5a1 running. No auto Bypass on resume stands (10736).
- T-975 FIX 6650e8ff (e7750582 rc0 3x45/45; one unexplained links.test failure in bdwtltcfm, builder owns it if seen again)
  -> QA delta c691df71 -> blind d9f18599 (migration 788).
- T-969 8144c5ce (c2159b27 rc0, 112/112) -> QA c691df71 -> blind d9f18599 (authz).
- T-1043 S0a+S0b ONE unit (10790) on ticket/T-1043-s0b, 76845676: M14/M16 tests, app.all behind ALL /api/*, sockets via
  sessionToken; Job queued -> QA c691df71 + blind d9f18599. Denial = 404 (10605).
- T-976 conflicted merge 130fb339 pushed by lead (ticket/T-976-merge, 4 markers in app.ts) -> 2a0edbd8 resolves -> QA + blind.
- T-968 S2a 896daa98 PWG x2 -> gaps in S2b be6b3adc by 2a0edbd8: Job bdeqeg7e5 rc1 (40/40 but TESTS=1; mutants
  "applied=0", kills unproven) -> per-file Job bp02vzvse -> fix -> QA c691df71 + blind. T-968 PRD fix 2a0edbd8 -> re-check d9f18599.
- T-565 S1 64f7c137 QA PWG (T-595 10773) -> FIX 2a0edbd8 -> delta c691df71 -> blind (infra).
- T-961 (deploy outage: PriorityClass, headroom, release pre-check; 10887) a3554d40 S1 pushed -> QA + blind (infra).
- T-1065 (new: redact.ts misses short passwords/URL userinfo; 10888) 76845676 while its Job queues -> QA + blind.
- T-356 (MCP authz gaps 1-4; 10906) 3753d3c2 while its Job runs -> QA + blind; lead reads the authz diff.
- Queues: c691df71 T-425 > T-969 > T-975 > S0a+S0b > S2b > T-565 > T-976 > H2 delta. d9f18599 H2 S1 > H1 delta > T-974
  FIX3 > T-969 > T-975 > PRD > S2b > S0b. a3554d40 T-961 + T-974 FIX3. 76845676 T-1043 + T-1065. 2a0edbd8 T-976 > S2b >
  T-565 > PRD. 3753d3c2 H2 fix > T-356.

## DECISIONS (binding)
- D-81 risk-based review: same builder through all fixes; one QA, the same QA re-checks; blind review only for security, auth,
  permissions, rule files, infra, pipelines, migrations, money, uat/prod.
- Coordinator order: T-948 > T-1043 MU2 S0 (D-82, blind review per slice) > T-968 (D-80) > T-971 H1+H2, T-974, T-975, T-565.
- The coordinator runs all deploys; I start none. I gate with gate-job.sh before every merge and tell T-731 when a batch lands.
- 17:40 pace order: no idle lanes; a lane waiting on its Job takes the next slice. D-75 stays: one Job per commit.
- D-78: only production/uat go to a person; all else "FOR THE COORDINATOR:" on the ticket. D-70 feed lanes by session_message.
- D-61 nothing heavy in the pod; D-66 the lead runs QC at premerge (lanes' allow lists refuse it, T-586).
- The pipeline gate stays on; only the owner's own word turns it off (T-731 10699).

## FOR THE COORDINATOR (D-78; each also on its ticket)
- Deploy batch 32 (74599ece). T-948: PORT_PROXY_HOST_SUFFIX and the claudepilot-app-ports route. T-976: live Traefik X-Forwarded-Proto;
  cookie-shadowing nuisance until T-976 is live (10855).
- T-961: the cluster-scoped PriorityClass objects, if Argo cannot create them (the builder names them).
- T-974 after the FIX3 re-check: remove the text-matching `git -C` deny lines.
- T-565: assign it to session 355881a3; name the backup bucket and its secret (BACKUP_S3_*).
- T-382: pick a DOM test library. T-1032: QC format must skip files tests read with readFileSync.
- T-938: confirm the QA account is stg-only, low-privilege; job-run --pool-env loosening (T-384).
- T-436 deploy note: agents reach only vaults whose agentWorkspaces names their workspace.
- T-666 RBAC narrowing; T-578 gate reuse choice; T-868 allow line must not allow a SHOTS_TEST_MODE=1 prefix.
- Older: T-341 D, T-422, T-306/T-340, T-417, T-433, T-437/T-432, T-476, T-491, T-509, T-525, T-591, T-325 S3, T-527, T-657, T-739.

## NEEDS A HUMAN (production and uat only, D-62/D-78)
- T-93 Konfersi production (owner checklist). T-610 pre-deploy read-only prod count (through the coordinator).

## NEXT (in order, as slots free)
1. Batch 33: T-425 S2b + what passes (T-974, T-971 H1+H2 S1, T-975, T-969, T-968 S2a+S2b, T-1043 S0a+S0b, T-976).
2. T-1043 S0c MCP tools; T-968 S1 (after the PRD fix).
3. T-860, T-30 (XL), T-33, T-921, T-379 S3 (paused).

LESSONS: dontAsk lanes run Bash only in their spawn worktree and refuse git merge/restore: the lead pushes the merge (with
markers) to a new branch, the lane does `git switch -C <br> origin/<br>` and resolves by Edit. Never prettier files tests read
with readFileSync. Re-run `context-pack.sh --check HEAD` after every merge; integration moved during a gate = merge + re-gate.
A mutant line must prove it was applied (diff non-empty). Full ids and full hashes only. gate-job.sh in the background, timeout 7200000.
