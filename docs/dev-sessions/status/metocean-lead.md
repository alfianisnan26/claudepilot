# Konfersi: Metocean lead status (2026-10-19, session fc73ae34-40d3-4c82-8148-dd55697c9379)

Scope (D-88, coordinator 2026-10-19): konfersi-metocean-compute, konfersi-ai-worker, Mission Planning compute/report/plugin parts, report builder, metocean reports. Status ticket T-1703. Release ticket T-1704 (v14 batch). Incident T-1705.

## DONE
- T-1703 opened; status comments c17276, c17308, c17425, c17443 (gate-copy rule), c17465.
- Gate-form lead copies posted (verdict sha == branch head, Job rc=0): T-1349 c17289, T-1590 c17294, T-1164 c17445, T-1586 c17446, T-1579 c17447, T-632 c17448, T-1632 c17449, T-1021 c17451 (carries T-1020/T-1022), T-1160 c17454+c17455, T-1162 c17456. T-1617 already in gate form (c16656).
- T-1704 created and updated (c17460): v14 order, bump rule, deploy rule.
- T-1528: independent QA PASS WITH GAPS on stg c29d103 (c17424; Jobs f1e957c4, a60470c9; 4 mutants red). Held in_review on AC5 (c17428).
- T-1574 redo: candidate dbbc9a49c5728a1c09cb380a6fca3d02789f4b8f on ticket/T-1574-nominal-tp-v14-2 (Jobs 3e6e65be, 59a50ebb rc=0; c17438, c17457). a69d6ea void (T-1705).
- T-1705 incident opened; brief template fixed (allowed git shapes, a denied command stops the step).
- Gate audit of the handed-over tickets done (mo-audit, read-only): results folded into T-1703 c17443 and NEXT.
- T-1103: candidate dec58a1 (test isolation, injected-leak tests; Jobs e004edb6 rc=1 fail-first, d4e35b28, c03ad53a rc=0 362 passed; c17482).
- T-1518: Job-backed QA PASS WITH GAPS on aeab2ec (c17483); merge decision and gate copy c17487/c17488; follow-up T-1708 (directional/monthly CI, GOF, Q-Q/P-P).
- T-553: QA on 34deb24 (c17486) found regex false positives; fixed as 52afda1 on ticket/T-553-percent-unit-4 (Jobs d9d7fd43 rc=1 fail-first, c1c3cec9, 06bb719a rc=0 363 passed; c17499, c17504).
- Hourly reports on T-1703: c17425 (16:21Z), c17506 (17:05Z).
- T-1701 measurement (mo-be-g, read-only, c17513/c17514): no prompt hash in any log or ledger row, so the Explain repeat rate is unknown; no cache built (ticket rule).
- T-1353 closed done 01:08Z (10-20): fix on compute stg c29d103, QA c14616 + mo-qa-1353 c18576 (Job b304e73c rc=0, mutants e83347cc/a32a1225); test gap to T-1800 (S, mine).
- T-1593 gate-form PASS both heads: backend 4a8c7bec c18575 (Job cfb2de34), lab-plugin e94bb68 c18584 (Job 3c67391a); mutants red.
- T-603 gate copy c18585 on 68fcfd3 (ticket/T-603-altimetry-qc; NOT in aeab2ec). T-1012 gate copy c18586 on d23ffc9 (ticket/T-1012-pull-measure, carries fix 4f9d95a…882786; not on stg).
- T-1182: lab-plugin gate copy c18597 on 4e32c8e; backend (#128) and compute (#45) already on stg (c18590); gaps to T-1801.
- T-1523: read c18593; decision c18602: in_review for test a4d2850 (gate form c15834); gaps split to T-1802 (lab-plugin Run toast Cancel) and T-1803 (backend deadline); ops/AC3 stay on T-1598.
- T-1591 QA gate form PASS c18615 (Job 02c22881 rc=0, mutants 0ee75e91 14/14 red); lead c18618: D-81 money path, needs second QA + post-deploy check.
- Closed this session: 1 (T-1353).

## IN FLIGHT
- 01:11Z mo-qa-1182 (sonnet, T-1182 QA backend b7941a3 + compute c29d103 on stg); mo-fe-1802 done: T-1802 in_review, 819bf775 on ticket/T-1802-run-toast-cancel (Jobs 4285bd94 rc=1 red, 68028dea rc=0 631 passed; c18627, lead c18629); QA needs a non-lineage session (c17308). Cap on sekar: 3. Quota 01:22Z: session 57 %, projected out about 01:50Z (resets 05:50Z): no new dispatch until it eases (D-43).
- T-1803 blocked (c18623): fix staged in mo-be-1803 clone, uncommitted; commit refused 3x by an unknown rule; builder ended.
- T-1701 hash slice done: 74bae41 on ai-worker ticket/T-1701-prompt-hash-log (c17525); gate ask waits for T-1162 on stg because `npm test` is red at the stg head itself (URLPattern, Jobs b24b9ea8/21ea40b0); then cherry-pick on a fresh stg clone, QA, gate, one ai-worker deploy (c17526).
- Worker probe mo-qa-w1 (5d4cfc18, satria, sonnet, dontAsk) refused on the allow-listed clone shape at 17:00Z (T-1574 c17540): ended; c17308 stands on a third Claude. No worker, no Agent sub-agent running.
- 16:58Z Re-attached by the coordinator after a portal liveness mark at 16:21Z (process never stopped).

## DECISIONS
- 01:22Z T-1803: builder found none of the suspected denies matches its refused messages (c18619); the tests commit with the same trailers passed. Rule unknown: asked the coordinator (c18623), ticket blocked, no work-around.
- 00:53Z (10-20) Moved to sekar. T-604 is wont_do since 10-17 (superseded by T-367): dropped from v14 (T-1704 c18558). T-603 rides T-1518's aeab2ec (c17324), pending the ancestry read.
- 16:05Z Lanes on `claude: auto` (session pace over). 16:12Z Workers blocked: Agent sub-agents instead; respawn when the clone shape works.
- 16:10Z One v14 batch; T-1518's v13 bump folded (c17306). 16:09Z T-1590 first; no compute deploy before both v14 bumps (T-1704).
- 16:19Z T-1574 a69d6ea voided (denied `checkout --detach` replaced by `switch --detach`); redo via `clone -b`; incident T-1705.
- 16:22Z T-1528 held in_review until AC5 runs or the coordinator waives it (c17428): an unmet acceptance criterion is not closed as done.
- 16:35Z Gate-copy rule (c17443): "PASS WITH GAPS" whose gaps are post-deploy checks is restated as "Verdict: PASS on <sha>" with the gaps quoted; code or scope gaps are not restated. T-1416 and T-1435 held until T-1574 merges (contour files).
- 17:12Z T-1701 (c17516): no Explain cache; add prompt_hash/card_id/model to the ai-worker log line and read the repeat rate with cf-logs.sh after 24 h on stg; cache reopens only above about 10 % identical prompts.
- 16:20Z Coordinator: stg Worker logs via `/home/node/work/claudepilot/scripts/cf-logs.sh` (read-only); the "Konfersi QA e2e (agents)" service token covers the main stg hosts for Job e2e. Use after each v14 deploy and for T-1528 AC5.

## FOR THE COORDINATOR
- c17308 (re-tested 17:00Z on satria, T-1574 c17540): dontAsk workers refused on the allow-listed clone shape; check the folder's allow list loads for workers. Single blocker for every non-lineage QA record.
- c17465: non-lineage QA records needed on T-1574 dbbc9a4 (delta check before its gate ask), T-1353, T-632, T-1632; session_message cannot reach the general lead.
- AIR quota on qa-regress-scratch (T-1528 AC5, c16625); shared browser cannot reach stg-lab.konfersi.com (T-1667, T-1017 c16925, T-1089 screen check).
- T-1705: should `git switch` be denied wherever `git checkout` is; is `--detach <sha>` meant to be denied for lanes?
- Read-only `git -C <lane clone> diff origin/stg...HEAD` and `git -C <clone> log A..B` are refused for lanes (mo-qa-2, 16:45Z); QA reads whole files instead. An allow line for diff/log with a range inside /home/node/work/agentic-worktrees/* would make QA diffs exact.
- T-1803 c18623: name the rule that refused the 3 fix commits in mo-be-1803 (fc73ae34, about 01:20-01:35Z); allow the shape or fix the false positive.
- D-88 text missing from this workspace's DECISIONS.md copy (ends at D-87).

## NEEDS A HUMAN
- none (no production or uat action pending).

## NEXT
1. Next free slots (when quota eases): T-1591 second QA (opus, D-81 billing; focus nit N1 zero-amount release-failed row, forecast overstating spend); then T-1803 commit + `npm run ci` Job once the coordinator answers c18623; then work whose QA is not blocked (QA of other sessions' builds, verify-first reads); then T-1800 builder (sonnet, S; its QA needs a non-lineage session). Brief rule: quote the whole job-run command (mo-qa-1593 near miss, T-1703).
2. Then: T-1007 (ai-worker, after T-1162 lands), T-1591 QA Job, T-1593 backend suite Job, T-1012 branch question.
3. When a non-lineage QA exists: T-1574, T-1103, T-553, T-1802 (819bf775) QA and gate asks.
3. After T-1574's QA and merge: gate asks T-1352 f92828f, T-1416 65d952d, T-1435 f424b1c; then the v14 bump commits (compute catalog.py, backend metocean-catalog.ts), backend migrations check, stg-deploy backend then compute, cf-logs check.
4. Need QA on head: T-1591 (billing, Job + blind review stands), T-1593 (backend suite Job, plugin sha), T-1012 (which branch is the fix: 4f9d95a on ticket/T-1012-r2-pull vs stg; merge-base denied in the pod).
5. Satria's: T-1017 gaps, T-1089 (screen check blocked), T-1021/T-1022 after merge: stg v2 JSON check; T-367, T-603; T-1182 backend and compute parts; T-1542 (QA login quota).
6. Hourly closed-count report on T-1703 (next ~17:05Z).
