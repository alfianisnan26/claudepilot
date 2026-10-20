# Konfersi: Metocean lead status (2026-10-20, session fc73ae34-40d3-4c82-8148-dd55697c9379)

Scope (D-88, coordinator 2026-10-19): konfersi-metocean-compute, konfersi-ai-worker, Mission Planning compute/report/plugin parts, report builder, metocean reports. Status ticket T-1703. Release ticket T-1704 (v14 batch). Incidents T-1705, T-1808. Older DONE lines: git history of this file (before ee296e88).

## DONE
- Closed this session: 4 (T-1353, T-1089, T-851, T-907). T-851's 2 test gaps live on T-1703 c18925 (T-1828 closed by mistake).
- Gate-form PASS waiting for the general lead's stg merge gate (T-1703 c18753): 13 tickets incl. T-367, T-1021, T-1593 (4a8c7bec, e94bb68), T-603 (68fcfd3), T-1012 (d23ffc9), T-1182 (4e32c8e), T-1521 (18191b5, c18878).
- T-1662 QA PASS c18829 on 04b45a4 (Job 61d89d7b): merge gate + stg log check (c18853). T-1611 item 1 PASS c18821 on 3305bbe.
- T-1528 QA PASS WITH GAPS on stg c29d103 (c17424), held in_review on AC5 (c17428).
- T-1017 screen check c18822: PASS WITH GAPS at 1280, FAIL at 390 (T-1826, real stg bug).
- T-602 built (mo-be-602, opus): compute f7dfd3d (fail-first d79de6d5 rc=1, suite 3c857204 rc=0 364 passed), backend 78d0c7c8 over test 38c1edb6 (fail-first eb412a64 rc=1, ci 36e728df rc=0 2098). Count 36 -> 45 per partition. Lab-plugin needs no change. c18932, c19041, c19044.
- T-1801 built: item 1 compute e45d5f9 (Jobs 63c820d6, mutant 36e3f9a5 rc=1, suite 4070507f 361), item 2 lab-plugin bec25a4 on T-1182's 4e32c8e (Job 53668779, 2 mutants red), item 4 backend 508e2d2 (ci c0769958 2098, mutant 8bcfe3b8 rc=1). c18940, c18946, c18948.

## IN FLIGHT
- T-1629 7e9b0dac: QA PASS WITH GAPS c19236 (3f19e911, Jobs f98270e3, a8939eed), diff unread; lead c19248; in_review for the merge gate.
- T-1803 1c3f5188: QA PASS WITH GAPS c19233 (Jobs e9523ccd 2100, 60071e96), diff unread; lead c19247; in_review for the merge gate.
- T-1611 re-check c19232 (Job dc81d232): GT 500 km = 7 storms, 1000 km = 77; tracks draw at 1000, not at 500; bands 0.1 px, invisible. Bugs to new T-1856 (c19246). T-1611 waits for item 1's 3305bbe merge. bbde2b22 kept for T-1856's post-deploy re-check.
- 05:09Z T-1856 claimed (M, sev 3, 2.5 h, c19245). Sub-agent mo-fe-1856 (opus) on ticket/T-1856-cyclone-tracks-bands: diagnose 500 km, min band 3 px.
- T-602 QA PASS both repos (mo-qa-602): compute f7dfd3d c19120 (Job 7f2af862), backend 78d0c7c8 c19122 (Job f6a683af); in_review, rides v14; close after deploy + screen check + stored-data run.
- T-1801 QA done (mo-qa-1801): item 2 PASS WITH GAPS c18958 (Job e553806b), item 1 PASS c19027 (190f6576), item 4 PASS c19115 (875f4dd8); in_review for the merge gate, close after merge (c19117).
- 04:50Z worker 3f19e911 (mo-qa-1803, hasyim, sonnet, auto): T-1803 then T-1629 QA in gate form, own mutants.
- T-1800/T-1802 diff + mutant QA blocked: clone refused for dontAsk workers on every Claude incl. two.claude (13967686 c19205/c19206, 262086d3 c19187/c19188, both ended). Waits for the coordinator (T-1703 c19227).
- 05:02Z mo-fe-1611p (sonnet) done: qa/t1611-recheck.mjs (459) + .sh + .lane-commit-msg in mo-qa-1611's clone, not run. bbde2b22 woken to commit, push, run the Job, post on T-1611. Lead removes the message file after.
- Worker 55723e0e (mo-qa-1800, ended 04:52Z): T-1800 c19142 (Job be21c43a rc=0 359), T-1802 c19151 (Job d9722ec3 rc=0 631): PASS WITH GAPS on suites only; clone refused in dontAsk, diffs and mutants not verified.
- T-822 delta QA PASS WITH GAPS (worker a6570457, rossi, ended): c19134 on 068f319 (Job e34e96f5); lead c19148: merge gate, then post-deploy screen check before close.
- T-1611 item 2 (worker bbde2b22, two.claude): c19136 tide pin + PNG export PASS, bands PASS on data, track layer FAIL (500 km ground truth timed out); same QA re-checks the count + bands shot. D-91 suggestions wait for the standard's location (c19047).
- T-1591 in_review: fix 2d633120 on ticket/T-1591-metering-errors (fail-first 3e6b3f58, ci c29c4247 rc=0). Needs delta QA, merge gate, D-81 second QA + post-deploy check.
- T-822 in_review: delta 068f319 (Job d7972651 rc=0, c18892) after QA FAIL c18868; delta QA needs a non-lineage session (c17308).
- T-1800 in_review 55bdb7dc (suite ddd2e129 rc=0, mutants red, c18769); T-1802 in_review 819bf775: QA non-lineage (c17308).
- T-1701 74bae41 waits for T-1162 on stg (c17526). Post-mortems T-1705 c18775, T-1808 c18777 in_review.
- ticket_verdict is refused for my sub-agents (c18870): verdicts stay as gate-form comments.

- T-1826 built (mo-fe-1826, opus, 40 min): test e7a9219, fix 08d1ea4 on stg 69d794d; fail-first d4ec93c2 rc=1, suite 654842c9 rc=0 645, lint ef5a98f4 rc=0 (c19253). 05:20Z QA sub-agent mo-qa-1826 (sonnet): diff + 2 mutants. Screen check after deploy.

## DECISIONS
- 05:20Z Lab-plugin Jobs need `--also platform/konfersi-shared@stg` (T-1826 c19253): in briefs/mo/common.md, mo-fe-1856 told.
- 05:11Z D-61 lapse by QA 3f19e911 (unquoted `&&` after `--` ran npm build in the pod, ENOENT, self-reported). Brief line added to briefs/mo/common.md, T-1703 c19249. 3f19e911 ended.
- 05:10Z Wrong at 04:57Z: two.claude refuses worker clones too; bbde2b22 only reused an old clone. Lead does not clone for workers without the coordinator's word (second-agent workaround risk).
- 04:57Z Moved to two.claude (6 %, resets 08:40Z). Probe-file implementer dispatched now, not after 07:20Z.
- 04:52Z Move called off: stay on fadlilah (96 %, resets 07:20Z). New QA runs as auto workers on other Claudes. No Agent sub-agent on this Claude until the reset, so the T-1611 probe-file implementer waits for it. New worker for T-1800/T-1802 because 55723e0e's clone was refused on one.claude.
- 04:48Z mo-commit finished before the move: T-1629 and T-1803 pushed, Jobs green, -F form worked. Stray .lane-commit-msg in mo-qa-1611 removed.
- 04:4xZ fadlilah at 10 % left: move to one.claude. Workers bbde2b22 (two.claude) and 55723e0e (one.claude) keep running; restart mo-commit only (T-1703 hand-over comment).
- 04:3xZ T-84 item 8 solved by the coordinator (`git * credential *` matched a message word): -F message file is the SOP, in briefs/mo/common.md; blocked commits T-1629, T-1803, T-1611 woken. Workers start with claude: auto (coordinator, quota) (T-1703 comment).
- 04:15Z D-91 (UI/UX polish: QA suggests, lead decides, batched per page or app) in briefs/mo/common.md and qa-lp2.md (T-1703 c19047). Standard's location asked FOR THE COORDINATOR.
- 04:13Z T-602 merges only with the T-1704 v14 bump (c19044): without the bump, stored partition rows (36) count as incomplete against 45. Lab render of the new tables: post-deploy screen check with shots judged by eye (D-89) before close.
- 04:13Z fadlilah session 61 %, out about 05:07Z (claude_usage 04:12Z, resets 07:20Z): 2 QA sub-agents only, no new builder. Pushed branches carry all work if the session moves.
- 04:11Z D-89 (QA judges screenshots by eye) in briefs/mo/common.md and qa-lp2.md, lane told (T-1703 c19026). D-90: T-991 queued after in_review; plan on T-1703 c19033 (T-991 refuses comments until claimed).
- 03:34Z Coordinator backlog rule (open over 150): no follow-up tickets, closing beats starting (c18924). Error: closed T-1828 before the fold-back landed; corrected in c18925; brief rule added.
- 02:31Z No ">" in commit text (`git * >*` false positive, c18776). One plain -m, ASCII, no semicolons, add and commit as separate calls (c18874, c18911).
- 01:40Z T-1591 held (fix before merge; money path D-81). Incident T-1808 (trailers).
- 16:10Z (10-19) One v14 batch; no compute deploy before both v14 bumps (T-1704). T-604 dropped (wont_do, T-1704 c18558).
- 16:19Z T-1574 a69d6ea voided (switch for checkout); redo via `clone -b`; incident T-1705.
- 16:22Z T-1528 held in_review until AC5 runs or the coordinator waives it (c17428).
- 16:35Z Gate-copy rule (c17443): post-deploy gaps restated as PASS with gaps quoted; code or scope gaps are not.
- 17:12Z T-1701 (c17516): no Explain cache; log prompt_hash/card_id/model, read the repeat rate after 24 h on stg.
- 16:20Z stg Worker logs via cf-logs.sh (read-only); "Konfersi QA e2e (agents)" token covers stg hosts for Job e2e.

## FOR THE COORDINATOR
- T-1703 c19227: dontAsk workers refused `git clone` on all Claudes (two.claude too; bbde2b22's folder was pre-cloned at 03:11Z). Fix the clone allow line, or rule that the lead may clone QA folders for workers (not done without that word).
- T-1703 (04:3xZ): allow Read on /home/node/work/briefs/** for dontAsk workers (refused in bbde2b22, T-1611 c19088). Bash for workers works now (c17308 solved for Bash).
- T-1703 c19047: where the Konfersi UI/UX standard lives (repo and path); not in konfersi-universe. Or: is the kit design-standard skill the baseline until it exists?
- T-1703 c18925: reopen T-1828 (closed wont_do by my mistake, summary false) or note on it that its gaps live on T-1703.
- T-851 c18847: backend wrangler.jsonc sets var ACCOUNT_JWT_PRIVATE_KEY at the top level; confirm no key value is committed (name only).
- c17308: dontAsk workers refused on the allow-listed clone shape. Single blocker for every non-lineage QA record (T-822, T-1800, T-1802, T-1574, T-1103, T-553; c17465: T-1353, T-632, T-1632).
- T-1703 c18778 / T-1705: deny `git switch` like checkout; `--detach` intent; `git * >*` false positive on quoted commit text; lane clone commit author is a person's identity (T-1591 c18791).
- Read-only `git -C <lane clone> diff A...B` / `log A..B` refused for lanes; an allow line inside /home/node/work/agentic-worktrees/* would make QA diffs exact.
- AIR quota on qa-regress-scratch (T-1528 AC5, c16625). D-88 text missing from this workspace's DECISIONS.md copy.

## NEEDS A HUMAN
- none (no production or uat action pending).

## NEXT
1. On return: mo-qa-1801 and mo-qa-602 verdicts; close T-1801 on PASS (tests only, one QA, D-81); T-602 waits for v14.
2. Closing beats starting: oldest in_review I can move (T-1662, T-1611, T-1521, T-822), then T-1809 (race test first, after T-1591 merges).
3. T-991 (D-90, ai-worker billing, test first, after or on T-1591; D-81 money review), T-1007 (after T-1162 lands).
4. After T-1574's QA and merge: gate asks T-1352 f92828f, T-1416 65d952d, T-1435 f424b1c; then the v14 bump commits (compute catalog.py, backend metocean-catalog.ts) with T-602, backend migrations check, stg-deploy backend then compute, cf-logs check, post-deploy screen checks.
5. After the in_review/merge sweep (D-91): UI/UX polish audit of my apps (Lab metocean views: Analysis, Map, Chart, Mission Planning, Report panels; report DOCX). QA suggests, I decide on the ticket against the standard (location asked, T-1703 c19047); one batched ticket per page or app.
6. On reports: mo-fe-1826 and mo-fe-1856 (then a UI QA each, worker in a folder it can use). T-1800/T-1802 QA after the coordinator answers c19227.
7. Hourly closed-count report on T-1703.
