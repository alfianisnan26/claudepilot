# Konfersi: Metocean lead status (2026-10-20 05:20Z, session fc73ae34-40d3-4c82-8148-dd55697c9379, on two.claude)

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
- T-1856 (M, sev 3, c19245): sub-agent mo-fe-1856 (opus) on ticket/T-1856-cyclone-tracks-bands: diagnose 500 km tracks, band min 3 px. Told about --also.
- mo-sweep-read (sonnet, read-only): send-back reasons of the 03:55Z sweep for 22 of my tickets (T-84 c18997). The DONE line "13 gate-form PASS waiting" was stale: the sweep sent them back.
- Worker bbde2b22 (two.claude, idle): kept for T-1856's post-deploy re-check.
- T-1591 in_review: fix 2d633120 (fail-first 3e6b3f58, ci c29c4247). Needs delta QA, merge gate, D-81 second QA + post-deploy check.
- T-1528 held on AC5 (c17428). T-1701 74bae41 waits for T-1162 on stg. Post-mortems T-1705 c18775, T-1808 c18777 in_review.
- ticket_verdict refused for my sub-agents (c18870): verdicts are gate-form comments.

## DECISIONS
- 05:15Z Coordinator rule: outside-family QA comes from peer leads by QA-ASK on T-84 (Lab QAs Metocean, Metocean QAs Business), answered before new build work. Asked 8 tickets (c19263, c19268). Leads cannot message each other (NOT_FOUND), T-84 c19264.
- 05:15Z UI/UX standard v0 is in the vault, "Konfersi/UI-UX standard.md" (T-84 c19101). My audit ticket is T-1848 (c19111), after the sweep fixes.
- 05:20Z Lab-plugin Jobs need `--also platform/konfersi-shared@stg` (T-1826 c19253), in briefs/mo/common.md.
- 05:11Z D-61 lapse by QA 3f19e911 (unquoted `&&` after `--` ran npm build in the pod, ENOENT, self-reported). Brief line: quote the Job command (T-1703 c19249).
- 05:10Z dontAsk workers cannot clone on any Claude (two.claude too). The lead does not clone for workers (second-agent workaround risk); QA for code goes to sub-agents (family) plus a peer QA-ASK.
- 04:57Z Moved to two.claude (6 %, resets 08:40Z).
- 04:3xZ -F message file is the commit SOP (T-84 item 8), in briefs/mo/common.md.
- 04:15Z D-91 (UI/UX: QA suggests, lead decides, batched per page or app). 04:11Z D-89 (QA judges shots by eye). D-90: T-991 after in_review.
- 04:13Z T-602 merges only with the T-1704 v14 bump (c19044); post-deploy screen check before close.
- 03:34Z Backlog rule (open over 150): no follow-up tickets, closing beats starting (c18924).
- 02:31Z No ">" in commit text; add and commit as separate calls (c18776, c18911).
- 01:40Z T-1591 held (money path D-81). 16:10Z (10-19) one v14 batch; no compute deploy before both v14 bumps.
- 16:35Z Gate-copy rule (c17443): post-deploy gaps restated as PASS with gaps quoted.
- 16:20Z stg Worker logs via cf-logs.sh (read-only).

## FOR THE COORDINATOR
- T-84 c19264: leads cannot session_message each other (NOT_FOUND), so QA-ASKs are T-84 lines only.
- T-1703 c19227: dontAsk workers refused `git clone` on every Claude.
- T-1703: allow Read on /home/node/work/briefs/** for dontAsk workers (T-1611 c19088).
- T-1703 c18925: reopen T-1828 or note that its gaps live on T-1703.
- T-851 c18847: backend wrangler.jsonc var ACCOUNT_JWT_PRIVATE_KEY at the top level; confirm no key value is committed.
- T-1703 c18778 / T-1705: deny `git switch` like checkout; `git * >*` false positive; lane commit author is a person's identity (T-1591 c18791).
- Read-only `git -C <lane clone> diff A...B` / `log A..B` refused for lanes.
- AIR quota on qa-regress-scratch (T-1528 AC5). D-88 text missing from this workspace's DECISIONS.md copy.

## NEEDS A HUMAN
- none (no production or uat action pending). T-1662 sweep note: D-77, a migration on stg D1 shared with uat needs a person's go; checked in the sweep read.

## NEXT
1. Answer any Business QA-ASK on T-84 first (Metocean QAs Business), with a qa-verifier sub-agent.
2. Fix the 03:55Z sweep send-backs from mo-sweep-read (format first, then rebase, then QA-ASK).
3. mo-fe-1856 return: family QA sub-agent, then QA-ASK on T-84.
4. T-1848 UI/UX audit of my apps against the vault standard (D-91).
5. T-991 (D-90, test first, D-81 money review), T-1809 after T-1591, T-1007 after T-1162.
6. v14 batch (T-1704): T-602 + both catalog bumps, migrations check, stg-deploy backend then compute, post-deploy checks.
7. Hourly closed-count report on T-1703.
