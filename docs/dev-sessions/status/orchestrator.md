# orchestrator status (2026-10-15 03:10 UTC, session de232389, continuation of 83842ba6)

Older log: `orchestrator-log-2026-10-14.md`. Previous hand-overs: ab99b45 (a8393f6b), this one.

## DONE
- DEPLOY run #32 RELEASED: portal 2026.10.15-3 (11ed6e8, merged back 8048128), Argo CD Synced/Healthy on 11ed6e8, pod running image 2026.10.15-3 (k3s-status.sh 03:20). Contains 721420f: coordinator 8ae4fb2, T-348, T-315 s1, T-330/T-331/T-272, T-349, T-352, T-321, T-376 S1, T-400. Cap of 3 deploys for 2026-10-15 reached.
- integration pushes this session: c1aa862 (T-349, T-352), 6166d2e (T-321, T-376 S1), cb48b49 (T-400), 721420f (+ coordinator 8ae4fb2, D-61, D-62); every one after a full gate Job GREEN (06e7564, 6166d2e, 575a48a). CLOSED: T-349, T-352, T-321, T-400.
- Filed: T-397 (proposal, mine), T-398, T-399, T-402, T-403 (settled by D-62), T-409, T-413 (incident: OOM 02:11, my share stated), T-422 (sudo, proposal, mine).

## IN FLIGHT (3 live workers = the D-61 budget; no Agent-tool sub-agents)
- T-366 (urgent): worker 033e1b23 (opus, on alfian.isnan: no other Claude had room) in dev-t-366-1, branch dev/t-366-1 from 688aee1: FIRST trust by repository identity (D-62 / T-403 option a; comment 2653); classifier stays the re-trust gate. Then a THIRD blind reviewer (not 7be4aeac / a72a5caa pairs), merge, deploy images=portal,workspace (after it every ClaudePilot folder re-trusts once: hash covers skills/agents/commands), real-job QA.
- T-417 (high): review SAFE AFTER FIXES (comment 2875; reviewer 775a1756 ended). Fixer a1bf3da8 (opus, fadlilah) in dev-t-336-1 on dev/t-417-1 from 9622deb: findings 1,2,3,5,7,8,9. Then a DIFFERENT reviewer (not 775a1756), merge. Finding 6 = T-425 (new, normal). Bypass across sleep rests on the owner's T-417 text; D-row is the coordinator's.
- T-375 (high): worker 07cef3b0 (opus, hasyim) in dev-t-333-1 (switched to dev/t-375-1, a5fc68a): merging origin/dev/t-369-1 (SessionRow.tsx conflict) + T-378's density check + the screenshot check. Then ONE ux-checker covering T-369 item 4 and T-375, then merge T-369 + T-375 together.

## READY, NOT MERGED
- T-369 (urgent): dev/t-369-1 ff0088d (comment 2568: web 576/576, flip proof f9d87e3b, session-crew 5/5 a9166dc2). Waits for the ux-check above.
- T-376 (high): S2 web dev/t-376-2 1fa258c (comment 2580: web 589/589). Needs a ux-checker (390/1280, light/dark, scroll-up hold) and S3 perf-tester (10k/25k fixture from T-378's seed-scale.mjs).
- T-378 (high): S1 dev/t-378-1 9834ff7 (comment 2631: FAIL proof on the owner's cases). Merge with the next batch (qa tools only); S2 transcript-perf + long-lists next; S4 the PASS runs.
- T-404 (high): dev/t-404-1 2dd0f9e (comment 2750); blind review SAFE AFTER FIXES (comment 2770): guard must protect /etc/claude-code and /etc/claudepilot, own ~20 s deadline, readers/git writers 3-4, MCP verbs 5, eval of file 6, pull scope 7, /usr/bin/env 8, audit label 9. Persona/skill text to propose after the fix, corrected for D-62.

## DECISIONS (binding)
- 03:40 coordinator (quota): until T-427 ships, never claude:auto; read claude_usage first and pass the Claude with the lowest session % not at its limit; at most 2 live sessions per Claude (now: fadlilah = me + a1bf3da8, hasyim = 07cef3b0, alfian.isnan = 033e1b23).
- 03:10 de232389 resumed: the 3 workers (033e1b23 T-366, 07cef3b0 T-375, d8dfb37f T-417) are alive and now report to this session; budget full, no new spawn until one returns. Run 32: build-portal pod running, main still d4a0adc. This session sits in kubernetes/kohi-event and ci_runs_list shows it no runs: read run 32 via main/argocd (k3s-status.sh).
- D-60/D-61/D-62: no rule-file writes by agents; at most 3 live workers, NO Agent-tool sub-agents, heavy work ONLY via scripts/job-run.sh or gate-job (never npm ci/tests/builds in the pod: OOM 02:11, T-413); the owner's only action is Konfersi production: proposals go on a ticket assigned to this session + one line to the coordinator (tightening landed by the coordinator, loosening after a blind PASS).
- New worktrees are FOLDER_UNTRUSTED until T-366 ships: spawn workers only in already-trusted spare worktrees (switch a clean one to the new branch first: dev-t-349-1, dev-t-352-1 (T-404's), dev-t-336-1 (T-417's), dev-t-333-1 (T-375's)). Update a spare to a current base before a verifier uses its scripts.
- Worker ticket tools: implementers get FORBIDDEN on the lead's tickets, verifiers/reviewers have none (T-397): the lead copies every report to the ticket.
- Deploy cap three a day: reached for 2026-10-15 with run 32.

## NEEDS A HUMAN (D-62)
- T-93 Konfersi production only. Coordinator items: T-397 (authz+persona loosening; charter-wall conflict named), T-422 (sudo removal, tightening), T-306 item 4 / T-340 (rtk hook).

## NEXT (in order, as slots free)
1. T-404 fixes (worker in dev-t-352-1 on dev/t-404-1), then a new blind reviewer.
2. T-413 post-mortem (incident-analyst worker, sonnet).
3. ux-checker for T-369+T-375 when 07cef3b0 reports; ux-checker + S3 perf-tester for T-376 S2.
4. T-416 (portal memory budget, high), T-422 build (sudo), T-147 (narrow ClusterRole in a rig, after T-416/T-417).
5. T-425, T-378 S2-S4, T-382, T-377, T-386, T-409, T-402, T-398, T-399.
6. T-370 HOLD (claudepilot-b7), then T-371..T-374, T-363 (read D-59 / PRD 8b criteria first).
7. T-365 rest, T-354, T-347, T-350, T-351, T-355, T-356, T-388, T-341, T-344, T-345, T-332, T-335, T-313, T-314, T-306 item 3, T-149.

LESSONS: no Agent-tool sub-agents and no in-pod heavy work (OOM); an idle worker is not woken by a finished Job (tell it to wait in its turn); use FULL commit hashes with job-run; merge a branch only via a worker when it conflicts; check the full D-row before quoting a decision; typecheck/gate before every integration push.
