# Konfersi: Metocean lead status (2026-10-20, session fc73ae34-40d3-4c82-8148-dd55697c9379)

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
- T-1089 closed 02:59Z on screen QA c18823 (Job a32445f5). T-1017 screen check c18822: PASS WITH GAPS at 1280, FAIL at 390 (overlap, T-1826).
- T-851 closed 03:10Z on QA c18803 (Job 032c16ba); gaps to T-1828. T-907 closed on QA c18804 (Job e5af00e3).
- T-1662 QA PASS c18829 on 04b45a4 (Job 61d89d7b), in_review for merge gate + stg log check (c18853). T-1611 item 1 PASS c18821 on 3305bbe (Job 5b6fc205), in_review (c18855).
- Closed this session: 4 (T-1353, T-1089, T-851, T-907).

## IN FLIGHT
- T-1591 in_review: fix 2d633120 on ticket/T-1591-metering-errors (fail-first 3e6b3f58 rc=1 on b6c5fb8; ci c29c4247 rc=0 2080 tests; c18789; lead diff read c18791). Needs non-lineage delta QA, merge gate, D-81 post-deploy check. Lane clone commits carry a person's name as author (noted c18791).
- 03:12Z (fadlilah) lane-qa-ui, opus, brief briefs/mo/qa-lp2.md: mo-qa-lp2 T-1521 18191b5 + T-1629 ff045bb (restart of the cut mo-qa-lp part); mo-qa-822 done: T-822 FAIL c18868 (dead tablet label CSS; wrap fix real); decision (a) c18872; builder mo-fe-822 (implementer, sonnet) removes the dead rules + 2 tests on ticket/T-822-mission-audit-rest; the delta QA needs a non-lineage session now (my lineage builds it, c17308). ticket_verdict is refused for my sub-agents (c18870): verdicts stay as comments. mo-qa-1611 done: probe commit refused by an unnamed rule (c18873); item 2 blocked, coordinator asked T-1703 c18874; probe staged uncommitted in its clone. 03:20Z mo-be-1801 (implementer, sonnet): T-1801 items 1 (compute DOCX render test) and 4 (backend payload test), c18876.
- mo-triage (18 tickets): builder slices T-602, T-1801, T-1809; blocked: T-1623 (commit deny), T-1542/T-1276 (AIR quota), T-1234/T-1020 (person's go D-77). Post-mortems T-1705 c18775, T-1808 c18777 in_review; rule asks T-1703 c18778.
- T-1800 in_review: head 55bdb7dc on ticket/T-1800-proponent-exact (suite Job ddd2e129 rc=0 359 passed; mutants M1 4ed6ba3a, M2 db690816 rc=1; c18769, lead c18773). Mutant refs ticket/T-1800-mutant-m1/m2 never merge. QA non-lineage (c17308).
- T-1803 blocked (c18623): fix staged in the mo-be-1803 clone, uncommitted; commit refused 3x by an unknown rule.
- T-1802 in_review 819bf775 (ticket/T-1802-run-toast-cancel); QA needs a non-lineage session (c17308).
- T-1182 in_review until lab-plugin 4e32c8e merges (c18634). T-1701 74bae41 waits for T-1162 on stg (c17526).
- 13 tickets with a gate-form PASS wait for the general lead's stg merge gate (T-1703 c18753; T-367, T-1021 first). Workers still refused Bash (T-553 c18740, c17308).

## DECISIONS
- 03:10Z Moved to fadlilah (10 %, resets 07:20Z). Found: mo-qa-scr, mo-qa-be done (verdicts posted), mo-qa-lp cut before T-1629. Closed T-851 (minor test gaps split to T-1828) and T-907 (criteria met on stg). Resumed T-1629 with T-1521; T-822 and T-1611 item 2 dispatched (stg-lab reachable by Playwright Job, so "not verified" is no longer the default there).
- 02:58Z one.claude at 95 %, out about 03:14Z (resets 03:40Z): no new dispatch; the 3 running QA slices (mo-qa-be, mo-qa-lp, mo-qa-scr) finish. If interrupted, restart each from its brief: they push nothing but qa/ refs and comments.
- 02:31Z T-1591 fix commit refused: " > held" in -m matched `git * >*` (redirect deny, false positive on quoted text). Option (a) reword without ">", same command otherwise; -F refused as another flag (c18776). Same builder resumed. Fail-first Job 3e6b3f58 rc=1 on test b6c5fb8. Brief: no ">" in commit text.
- 02:25Z Moved to one.claude (16 %, resets 03:40Z): 3 slices dispatched. T-1808 brief line in briefs/mo/common.md (--trailer flags + trailers check, c18760).
- 01:40Z T-1591 held (option a, fix before merge; money path D-81, gap new with the change). c18618's trailer claim corrected; incident T-1808.
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
- T-851 c18847: backend wrangler.jsonc sets var ACCOUNT_JWT_PRIVATE_KEY at the top level (dry-run warning); QA's check was denied; confirm no key value is committed (name only). Incident + rotation if it is.
- T-1703 c18778: deny `git switch` like checkout; checkout --detach intent; trailer gate step; `git * >*` false positive on quoted commit text. Lane clone commit author is a person's identity (T-1591 c18791).
- c17308 (re-tested 17:00Z on satria, T-1574 c17540): dontAsk workers refused on the allow-listed clone shape; check the folder's allow list loads for workers. Single blocker for every non-lineage QA record.
- c17465: non-lineage QA records needed on T-1574 dbbc9a4 (delta check before its gate ask), T-1353, T-632, T-1632; session_message cannot reach the general lead.
- AIR quota on qa-regress-scratch (T-1528 AC5, c16625); shared browser cannot reach stg-lab.konfersi.com (T-1667, T-1017 c16925, T-1089 screen check).
- T-1705: should `git switch` be denied wherever `git checkout` is; is `--detach <sha>` meant to be denied for lanes?
- Read-only `git -C <lane clone> diff origin/stg...HEAD` and `git -C <clone> log A..B` are refused for lanes (mo-qa-2, 16:45Z); QA reads whole files instead. An allow line for diff/log with a range inside /home/node/work/agentic-worktrees/* would make QA diffs exact.
- T-1803 c18623 + T-1703 c18874: name the rule that refused the 3 fix commits in mo-be-1803 (about 01:20-01:35Z) and the mo-qa-1611 probe commit (about 03:25Z); allow the shape or fix the false positive. Reading the deny list myself was refused by the rule-file guard.
- D-88 text missing from this workspace's DECISIONS.md copy (ends at D-87).

## NEEDS A HUMAN
- none (no production or uat action pending).

## NEXT
1. Next free slot (harness cap: 3 sub-agents): builder T-1826 (390 matrix labels: cellRoom by column width) or T-1809 (race test first, D-81) after T-1591 merges; T-1801; T-602. WIP far over 5 from the D-88 hand-over: finish before new builds. Then T-1803 commit + `npm run ci` Job once the coordinator answers c18623; then QA of other sessions' builds. Brief rule: quote the whole job-run command (mo-qa-1593 near miss, T-1703).
2. Then: T-1007 (ai-worker, after T-1162 lands), T-1591 QA Job, T-1593 backend suite Job, T-1012 branch question.
3. When a non-lineage QA exists: T-1574, T-1103, T-553, T-1802 (819bf775) QA and gate asks.
3. After T-1574's QA and merge: gate asks T-1352 f92828f, T-1416 65d952d, T-1435 f424b1c; then the v14 bump commits (compute catalog.py, backend metocean-catalog.ts), backend migrations check, stg-deploy backend then compute, cf-logs check.
4. Need QA on head: T-1591 (billing, Job + blind review stands), T-1593 (backend suite Job, plugin sha), T-1012 (which branch is the fix: 4f9d95a on ticket/T-1012-r2-pull vs stg; merge-base denied in the pod).
5. Satria's: T-1017 gaps, T-1089 (screen check blocked), T-1021/T-1022 after merge: stg v2 JSON check; T-367, T-603; T-1182 backend and compute parts; T-1542 (QA login quota).
6. Hourly closed-count report on T-1703 (next ~17:05Z).
