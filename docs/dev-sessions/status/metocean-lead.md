# Konfersi: Metocean lead status (2026-10-20 09:30Z, session fc73ae34-40d3-4c82-8148-dd55697c9379, on rossi)

Scope (D-88, coordinator 2026-10-19): konfersi-metocean-compute, konfersi-ai-worker, Mission Planning compute/report/plugin parts, report builder, metocean reports. Status ticket T-1703. Release ticket T-1704 (v14 batch). Incidents T-1705, T-1808. Older lines: git history of this file.

## DONE
- Closed this session: 4 (T-1353, T-1089, T-851, T-907). T-851's 2 test gaps live on T-1703 c18925.
- Built, family QA in, outside QA asked on T-84 (c19263, c19268):
  - T-1803 backend 1c3f5188: QA PASS WITH GAPS c19233 (Jobs e9523ccd 2100, 60071e96), diff unread; lead c19247.
  - T-1629 lab-plugin 7e9b0dac: QA PASS WITH GAPS c19236 (Jobs f98270e3, a8939eed), diff unread; lead c19248.
  - T-1826 lab-plugin 08d1ea4 (test e7a9219): fail-first d4ec93c2 rc=1, suite 654842c9 645; QA PASS c19261 (dca528a3, mutants 525dd194, 074a60f2 red); lead c19267. Screen check after deploy.
  - T-1801 (3 repos, c19027, c19115, c18958), T-602 (2 repos, c19120, c19122, rides v14), T-822 068f319 (c19134).
  - T-1800 55bdb7dc, T-1802 819bf775: suites only (c19142, c19151), diffs unread.
- T-1611 re-check c19232 (Job dc81d232): GT 500 km 7 storms, 1000 km 77; tracks draw at 1000 only; bands about 0.1 px. Bugs moved to T-1856 (c19246). T-1611 waits for item 1's 3305bbe merge.

## IN FLIGHT
- T-1693 (Business ask) answered: mo-qa-1693 PASS WITH GAPS on 8dfe8fec, c19346 (ci 7412dbfb rc=0 2113, mutants e13b09ed 3/4 killed); T-84 c19351. 0111 data-only, D-77 person step stays with Business. Two-ref diff used after `A...B` refusal, disclosed on T-84.
- T-1435 HELD: capture Job ad87a706 rc=1, 126/129 equal, 3 air_press POT bodies differ (global record RP -32%, AD 4th decimal), wind and edge records equal (c19321). Decision (b) fix to scipy parity (c19324). Builder done c19444: closed support z <= -1/c like scipy; test 2f06c3e fail-first d72dcae1 rc=1, fix 9c808138 suite e6e924c7 rc=0 367. Capture re-run PASS c19539: Job 7e71e12c rc=0, 129/129 equal to stg 3b97011 (head 719d52b5, script blob check updated, disclosed). Outside QA-ASK T-84 c19547.
- T-1591: family delta QA PASS WITH GAPS on 2d633120, evidence only (c19356, c19362; 8fb38df8, de0fb288). CI 9c9434ea rc=0, 2080/2080 with lint (c19372). Needs outside QA + blind review (T-84 c19308).
- Business QA-ASK T-1658 d39ecf96 + T-1442 6696c47a (c19336, privacy): outside QA FAIL both (T-1658 c19525: migrations/ map entry cites a job that is T-1693, unmerged; T-1442 c19528: purge misses DOCX reports via report_key, audit counts-only unpinned, mutant B1 survived). CI 42a3e743, 05c5287d rc=0. Relayed T-84 c19532. Blind review done: T-1658 MERGE WITH FIXES (c19365, migrations/ labelled retain, job not at head), T-1442 MERGE (c19366); relayed T-84 c19368.
- T-1848 claimed (c19371). Step 1 pages named (c19373); one ticket kept, split after open is under 150 (backlog rule vs D-91, named). Step 2 metocean done: Job b2d11ffd rc=0, 95 shots, 1 High (390 side bars leave 50 px), 5 Medium, 10 Low, 7 suggestions (c19523). Lead decided c19531: one metocean fix slice, all accepted but the radius suggestion. Step 3 Mission Planning done c19604 (Job 98e9c170 rc=0, 100 shots, 2 High: stale results on empty plan, 390 side bars; 3 Medium, 3 Low); decided c19605, one MP fix slice. Lane read around 2 refusals (read-only), on T-1703 c19606 for the coordinator. Step 4 report builder done c19638 (Job 49369aa6 rc=0, 82 shots; 2 High: tables one letter per line, Generate double-click can start 2 jobs; 7 Medium). Decided c19639. Slice 2 (RB Highs, Risk tab, errors): mo-fe-1848b (opus) on ticket/T-1848-report-builder. Slice 3 (RB narrow/dark, Lows) after slice 1. Fix slice 1 (390 side bars, chart and DA overflow): mo-fe-1848a (opus) on ticket/T-1848-narrow-layout. MP fix slice (items 1,3,4,5,Lows, suggestions; side bars stay in slice 1): mo-fe-1848c (opus) on ticket/T-1848-mission-planning.
- T-1856: mo-fe-1856 done. Fix f6029652 (bands at least 3 px, out-of-range dropped), fail-first 48da29da rc=1, suite a9c5dfce rc=0 (c19287). Item 1: no client-code cause, the probe's timing (c19255, not verified on stg). Family QA PASS WITH GAPS item 2 (c19357; de31a041 rc=0, 3 mutants caught); in_review c19359, item 1 closes only on the post-deploy 500 km pass. QA-ASK T-84 c19288. bbde2b22 re-checks after deploy, waiting until the toast closes.
- Sweep send-backs (mo-sweep-read done): QA-ASKs on T-84 c19273 (T-1012, T-1416, T-1349, T-553, T-1523, T-1662, T-632, T-1182, T-1521) and c19277 (T-1021 file list). D-77 file lists asked on T-1021 c19275, T-1662 c19276 (lead diff refused). T-1296 (coordinator blocker) and T-1528 (AC5) need no merge.
- Worker bbde2b22 ended 05:45Z (portal reported 6 running against the cap of 5, T-1703 c19313). A new QA worker does T-1856's post-deploy re-check.
- T-1591 in_review: fix 2d633120 (fail-first 3e6b3f58, ci c29c4247). Needs delta QA, merge gate, D-81 second QA + post-deploy check.
- T-1528 held on AC5 (c17428). T-1701 74bae41 waits for T-1162 on stg. Post-mortems T-1705 c18775, T-1808 c18777 in_review.
- ticket_verdict refused for my sub-agents (c18870): verdicts are gate-form comments.

## DECISIONS
- 09:31Z T-1623 QA delta PASS WITH GAPS c20124 on 49a8e2b (d4677124 rc=0 642, 6/6 mutants, 15 shots); S2 accepted c20126, gaps to the next Explain UI batch; held for outside QA; S1 still blocked on stg 502. T-632 fix round M1 money tests + m1 error mapping (review c19667): mo-be-632 (implementer, opus) on ticket/T-632-fetch-roundtrips-stg 7412c9d (c20127). Outside QA route found: T-84 c20062, accepted c20128.
- 10:42Z Moved to hasyim. T-632 mo-be-632 had pushed 103122c (M1 tests) + f5570e6 (m1 fix), no report; restarted mo-be-632 (implementer, opus) from f5570e6 for fail-first proof, suite/lint/tsc, ticket report (c20202).
- 11:03Z T-632 fix round done (c20255): head d3e837f, fail-first Job 64eda985, full Job 73eb2d39 tsc + 2055/2055; lead read of money diff OK (c20256). Re-review M1/m1 + outside QA asked on T-84 c20257.
- 09:23Z T-1623 fix round pushed: e3c64d9 G1 test, 49a8e2b F1 wording (bc99d639 rc=0 642; 503 mutant 9f115e65 red; c20111). Quick check fails on this repo (plain node --test, no vscode alias), for the coordinator on T-1623. Same QA mo-qa-1623 re-checks the change.
- 09:05Z Moved fadlilah to rossi (quota). Found: T-1623 QA mo-qa-1623 gave no verdict (no QA worktree, last comment c20061 is the builder). Restarted mo-qa-1623 (lane-qa-ui, opus) on 1c1da12; no other slice was in flight.
- 09:58Z T-1848 N1 PASS c20046 on af9858d1 (suite 63c81372 rc=0, 6 shots by eye). All 5 slices family-QA passed, held for outside QA and blind review; merge order narrow, Lows, MP, RB, RB-narrow (c20048).
- 09:50Z T-1848 N1 fixed af9858d1 (fail-first 0467412f rc=1, lint+suite fd8888e1 rc=0 700; c20032). QA mo-qa-1848a re-checks N1 only.
- 09:40Z T-1848 Lows delta 2 PASS WITH GAPS c20014 on fbe66685 (suite cc3c9cdc rc=0 697, M6 killed, 70 shots). N1 Hs axis to -1 on a contour below 0: clamp now (c20018), same builder; QA re-checks N1 only.
- 09:35Z T-1848 RB slice 3 delta PASS c20005 on 97ad731 (suite 607ee151 rc=0 673, mutant 00a65534 killed, 8 shots by eye incl. Source). Held for outside QA; 26 px Copy/Download and 1 px ring to next RB batch.
- 09:28Z T-1848 Lows round 2 fbe66685 (fail-first dbd5c6f0 rc=1 6 new, suite+lint+build f0e1cdee rc=0 697; c19991). y-axis can go below 0 with synthetic contours: QA to check with evidence. Same QA mo-qa-1848a re-checks delta.
- 09:20Z T-1848 RB slice 3 short round 97ad731 (fail-first 9e5ac470 rc=1 3 new, lint+suite 92ef4932 rc=0 673; c19990). Same QA mo-qa-1848b re-checks delta incl. Source view shot.
- 09:10Z T-1848 MP delta 2 PASS c19972 on 3a58b2d (suite 525e01c4 rc=0 705, mutant 6ea88f8d killed, 26 shots). MP slice done, held for outside QA. s2 (card unit cut) and s3 kept for next MP UI batch; merge order narrow, MP, RB (c19975).
- 09:05Z T-1848 RB slice 3 QA PASS WITH GAPS c19968 on 00e579a (suite 4f9d31cb rc=0, 3 mutants killed, 19/44 shots). Short round to mo-fe-1848b: 44 px Synthesize/Back, focus, Reports dark scheme, CHANGELOG (c19969). QA read of .claude/settings.json blocked by hook: T-1703 c19970, brief line added.
- 08:58Z T-1848 MP fix round 2 3a58b2d (fail-first d7993719 rc=1 12, suite+lint efd74ad1 rc=0 705; c19963). Same QA mo-qa-1848c re-checks delta.
- 08:50Z T-1848 Lows delta PASS WITH GAPS c19945 on 520a89f (suite 5fa464dd rc=0, 2 mutants killed, 31/53 shots). Lead saw shot; F1 end label by legend, F2 colour scale overlap, F3 contours cut (from 7bbc187), Low 3 placeholder: one more round (c19952) to mo-fe-1848a (opus, new session). QA python3 -c slip to coordinator T-1703 c19954.
- 08:42Z T-1848 MP delta QA FAIL c19940 on 311a1e1 (suite 5553dc95 rc=0, 2 mutants killed, 21 shots): F3 Lab home stale mark cut by ellipsis (lead saw shot). G1 raw text in Run path in scope, Details marker accepted (c19941). Back to mo-fe-1848c.
- 08:35Z T-1848 RB slice 3 done 00e579a on ticket/T-1848-report-builder-narrow (fail-first c358f381 rc=1, a6435a02 rc=1 Back button, suite+lint 2239109f rc=0 670; c19939). Skips: Low c backend text, row names need backend fields. QA mo-qa-1848b (opus) dispatched.
- 08:20Z T-1848 MP fix round done 311a1e1 (fail-first a84061aa rc=1 12 new fails, suite b07880e2 rc=0 694, lint f6c4678d rc=0; c19840). Delta QA mo-qa-1848c (opus) dispatched; builder screenshot-free, by-eye with QA.
- 08:12Z Moved satria to fadlilah (quota; session 17 %). Found: RB narrow 97db3a3 pushed plus 5 uncommitted files; MP fix 311a1e1 pushed (fail-first c00d15f), Jobs unknown; Lows QA no verdict. Restarted mo-fe-1848b (commit tree first), mo-fe-1848c (Jobs on c00d15f/311a1e1), mo-qa-1848a (delta on 520a89f), all opus, same worktrees.
- 08:05Z T-1848 metocean Lows done 520a89f on ticket/T-1848-metocean-lows (fail-first 48edaae3 rc=1, Retry mutant 087c7579 rc=1, suite 5a1b0f57 rc=0 690, lint 3a179f84 rc=0 after 2 red lint Jobs; c19793). Same QA mo-qa-1848a checks the delta. Builder mo-fe-1848a done.
- 07:56Z T-1848 MP slice QA FAIL c19780 on 805e49e (suite 82d90d76 rc=0, 4 mutants killed, 35 shots): F1 Retry wraps per letter at 390, F2 MC tabs 44x43. Lead saw shot; added raw save reason and Lab home stale card (c19785). Back to mo-fe-1848c. Read-another-way pattern to coordinator (T-1703 c19786).
- 07:48Z T-1848 slice 2 delta PASS WITH GAPS c19756 on c728f29 (suite 1627480a rc=0, opacity mutant fac1c7e6 killed). Held for outside QA. RB slice 3 starts now stacked on c728f29 (ticket/T-1848-report-builder-narrow, mo-fe-1848b), not after slice 1 (c19757).
- 07:52Z T-1848 slice 2 fix c728f29 (fail-first 8015be16 rc=1, mutant 070b43f0 rc=1, suite de6e4c69 rc=0 655, lint baf46af7 rc=0; c19754). Same QA mo-qa-1848b re-checks the delta.
- 07:40Z T-1848 slice 3 (MP) done 805e49e (fail-first eba24807 rc=1, suite 0a1d162f rc=0 682, lint 029675eb rc=0; c19737). QA mo-qa-1848c queued: satria caps sub-agents at 3. Builder slips (node -e in pod, cd &&) to coordinator T-1703 c19739; common.md line added.
- 07:38Z T-1848 slice 2 QA FAIL c19730 (dark error box see-through over Sections header; items 1-3 PASS, suite 93c444ed rc=0, 4 mutants killed). Lead saw the shot; decided in-flow reserved row + 44 px controls + mutant-2 test fix (c19732). Back to mo-fe-1848b; same QA re-checks delta.
- 05:15Z Coordinator rule: outside-family QA comes from peer leads by QA-ASK on T-84 (Lab QAs Metocean, Metocean QAs Business), answered before new build work. Asked 8 tickets (c19263, c19268). Leads cannot message each other (NOT_FOUND), T-84 c19264.
- 07:52Z-04:13Z older lines in git history. T-602 merges only with the T-1704 v14 bump (c19044); post-deploy screen check before close. T-1591 held (money path D-81); one v14 batch, no compute deploy before both v14 bumps.

## FOR THE COORDINATOR
- T-1703 c19978: cf-logs.sh refused for the lead (policy-rule-guard "writes a rule file"); blocks T-1848 item 6. c19970: QA read .claude/settings.json, blocked. c19954: QA python3 -c slip.
- T-1703 c19654: Lab QA verdicts on Metocean work refused on lineage (T-84 c19607); name another outside-QA unit. Blocks T-1435, T-991, T-1591, T-1856 merges.
- T-1703 c19606: lane mo-qa-ui-1848 got refused reads another way (read-only); probation or note.
- T-1848 c19386: allow list grants QA lanes `qa/T-*` pushes, but konfersi-lab-plugin protects `qa/*` server-side; align or name the prefix.
- T-84 c19264: leads cannot session_message each other (NOT_FOUND), so QA-ASKs are T-84 lines only.
- T-1703 c19227: dontAsk workers refused `git clone` on every Claude.
- T-1703: allow Read on /home/node/work/briefs/** for dontAsk workers (T-1611 c19088).
- T-1703 c18925: reopen T-1828 or note that its gaps live on T-1703.
- T-851 c18847: backend wrangler.jsonc var ACCOUNT_JWT_PRIVATE_KEY at the top level; confirm no key value is committed.
- T-1703 c18778 / T-1705: deny `git switch` like checkout; `git * >*` false positive; lane commit author is a person's identity (T-1591 c18791).
- Read-only `git -C <lane clone> diff A...B` / `log A..B` refused for lanes, and for the lead clone too (T-1021 c19275): needed to name files for D-77.
- AIR quota on qa-regress-scratch (T-1528 AC5). D-88 text missing from this workspace's DECISIONS.md copy.

## NEEDS A HUMAN
- none (no production or uat action pending). T-1662 sweep note: D-77, a migration on stg D1 shared with uat needs a person's go; checked in the sweep read.

## NEXT
0. Explain stg log read refused by hook (T-1703 c19978, T-1848 c19979): waits for the coordinator; blind reviews for the merge gate once the outside QA route exists.
1. Business QA-ASK T-1805 ab56e48 (T-84 c19376, c19504): outside QA PASS WITH GAPS c19619 (suite b4530166 rc=0 2125; guard test only on ticket/T-1805-qa, builder must move it to src/__tests__); T-84 c19620. Blind review MERGE c19564 (proof Job 7aa8d5f3: 12/12 at ab56e48, 10/12 red at d55dcc5; 5 minors: guard and rollback untested, boundary 29/31 only). Then any newer Business QA-ASK.
2. Outside QA route: general lead QA lane d53dd342 (T-84 c20062, accepted c20128), queue T-1856, T-1591, T-1435, T-991, T-1848, T-1623, T-632. d53dd342 stuck on a session limit until 12:20 UTC (c20109).
3. mo-be-1435, mo-qa-1658, mo-qa-ui-1848 returns (then Mission Planning, report builder lanes): integrate; T-1435 then capture re-run on the fix. hasyim caps sub-agents at 3.
4. T-1848 UI/UX audit of my apps against the vault standard (D-91).
5. T-991: built 062f8f4 (test 4b9bfe3 red f4787bc1 rc=1; suite 8f622f4e rc=0 97/97; c19593). Lead accepted #609 billed and earlier-answer stays free (c19596). Family QA PASS WITH GAPS c19615 (suite 0471a8d4 rc=0, 3 mutants red). Lead c19617: limit charge to chat 400/800 (Explain billed today, not abuse); G3 tool-then-cap stays free per D-90 wording. Fix round 432b3ab (chatBudget at agent.service.ts:411; red a2878ed0 rc=1, suite 5f0d81f8 rc=0 101/101; c19624). Low-quota edge accepted, builder read another clone named (c19625). QA delta PASS c19636 (7a63fcc8 rc=0; mutant 4 red, 5 survives by design). Blind review MERGE c19640 (3 minors decided c19643: disconnect stays free, recorded with G3). Waits outside QA-ASK T-84 c19637. Cross-repo risk: backend AGENT_MAX_OUTPUT_TOKENS below 400 would make all chat free (untested). T-1809 after T-1591, T-1007 after T-1162.
6. v14 batch (T-1704): T-602 + both catalog bumps, migrations check, stg-deploy backend then compute, post-deploy checks.
7. Hourly closed-count report on T-1703.
