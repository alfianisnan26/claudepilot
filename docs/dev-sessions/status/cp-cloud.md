# cp-cloud status (2026-11-04, session d4abf769-ab27-4364-8320-8336e28215fc)

Epic PILOT-1131 (T-3680): ClaudePilot core to Cloudflare (KohiLabs), repo to KohiLabs Gitea. Integration branch `cf/integration` (from integration 6150655e5).

## DONE
- Decisions D1-D7 + hard limits recorded on PILOT-1131 (comment 57923).
- Phase tickets PILOT-1132..1156 (tags cf-migration + phase-n).
- `cf/integration` created on origin and pilot.
- PILOT-1140 gap analysis (docs/prd/cf-bridge.md) merged 9be55e4b4 (job 008f03b7), closed; gaps filed as PILOT-1157..1164.
- PILOT-1139 origin/CSRF merged c20382436..33d6d6ffb (job 65e012f1 5194, review PASS 58245), closed.
- PILOT-1143 Worker skeleton merged 51de2b63c..42f0e097c (job 11fe24f4 16), closed.

## IN FLIGHT
- cf-bridge (worker 5bc808ae, opus): PILOT-1141 fix fcc046c06 (job bf0d2e6d 7/7) and PILOT-1162 6496bf149 (job 1a6d3781 107) in review; idle (pacing). Filed PILOT-1167.
- cf-review (worker 68d76aeb, opus, auto): queue 1141 delta, 1144, 1162.
- cf-worker (worker 6562167d, opus): PILOT-1144 c4387aea9 (job d8ebfaf4 61) in review; building PILOT-1159 G6 spike.
- cf-sec (worker e28ec1b4, opus): fixing PILOT-1138 review FAIL 58244 (shared tunnel key, Retry-After, admin sign-in).
- PILOT-1136 (lead): blocked; the D-112 row waits on the coordinator.

## DECISIONS
- 08:50 No "2026-10-30 security sweep" exists; PILOT-1137 tracks the open exposure tickets + new gaps (PILOT-1138, 1139).
- 08:50 Phase-2 API proxy targets a scratch portal, never the live one (hard limit).
- 08:55 DECISIONS.md is a rule file (guard, D-60): the D-112 row goes to the coordinator on PILOT-1136.
- Workers on Opus: backend/infra/security per owner routing 2026-10-25.
- Reviewer runs in mode auto: dontAsk refused Bash (git diff), so the first reviewer 7ee2ad61 was ended.
- 09:14 PILOT-1141 review FAIL (comment 58011: unbounded `secrets: create`); fix (a) went back to cf-bridge.
- ~09:20-11:30 all three builders hit the two.claude session limit; resumed 11:45 after the reset. Next session window resets 16:40 UTC: on a limit, note the reset here and wake every worker right after it.
- 12:00 Review trailer finding on 1138 is a false positive (trailers in a block above Co-Authored-By); builders now use one final block.
- 11:45 Operator pacing (one account): at most 2 workers building at once; cf-review takes review asks only. Order: 1143/1144 and 1141 first, then cf-sec 1138/1139 (paused). Only cf-migration tickets.

## FOR THE COORDINATOR
- PILOT-1132: KohiLabs Cloudflare token `CP_NEXT_CF_API_TOKEN` (scopes on ticket) + Workers Paid status.
- PILOT-1133: Gitea token `CP_GITEA_MIRROR_TOKEN` + owner org.
- PILOT-1136: land D-112 in DECISIONS.md.
- PILOT-1141: admission policy for Job claudepilot-build-bridge, a rig namespace, Namespace isnan-cp-bridge, Secret cp-bridge-enroll.
- PILOT-1139: PORTAL_ALLOWED_ORIGINS=https://<public host> before the portal sits behind the Worker host.
- PILOT-1144: BRIDGE_CLUSTERS secret on cp-next-core; bridge bearer token in the Secrets pool.
- PILOT-1146/1147: Argo repoURL, AppProject, npm tokens (phase 2 entry, later).

## NEEDS A HUMAN
- none (production cutover and the final hostname come at phase 6, operator + owner).

## NEXT
1. Merge on review PASS: 1141 (+ fix docs/prd/cf-bridge.md:81 'create'), 1144, 1162, 1138.
2. Gaps: PILOT-1160, 1158, 1161, 1159 (spike), 1163, 1164, 1157; then PILOT-1142 rig e2e.
3. PILOT-1134 mirror (after 1133), PILOT-1135 zones (after 1132), PILOT-1145 staging deploy (after 1132 + 1135).
4. Phase 2: PILOT-1146, 1147, 1148, 1149, 1150, 1151.
