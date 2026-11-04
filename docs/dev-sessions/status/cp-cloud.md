# cp-cloud status (2026-11-04, session d4abf769-ab27-4364-8320-8336e28215fc)

Epic PILOT-1131 (T-3680): ClaudePilot core to Cloudflare (KohiLabs), repo to KohiLabs Gitea. Integration branch `cf/integration` (from integration 6150655e5).

## DONE
- Decisions D1-D7 + hard limits recorded on PILOT-1131 (comment 57923).
- Phase tickets PILOT-1132..1156 (tags cf-migration + phase-n).
- `cf/integration` created on origin and pilot.

## IN FLIGHT
- cf-bridge (worker 5bc808ae, opus, two.claude): PILOT-1140 gap analysis, then PILOT-1141 manifests.
- cf-worker (worker 6562167d, opus, two.claude): PILOT-1143 Worker skeleton, then PILOT-1144 BridgeDO.
- cf-sec (worker e28ec1b4, opus, two.claude): PILOT-1138 rate limits, then PILOT-1139 origin/CSRF.
- PILOT-1136 (lead): this status file; the D-112 row waits on the coordinator.

## DECISIONS
- 08:50 No "2026-10-30 security sweep" exists; PILOT-1137 tracks the open exposure tickets + new gaps (PILOT-1138, 1139).
- 08:50 Phase-2 API proxy targets a scratch portal, never the live one (hard limit).
- 08:55 DECISIONS.md is a rule file (guard, D-60): the D-112 row goes to the coordinator on PILOT-1136.
- Workers on Opus: backend/infra/security per owner routing 2026-10-25.

## FOR THE COORDINATOR
- PILOT-1132: KohiLabs Cloudflare token `CP_NEXT_CF_API_TOKEN` (scopes on ticket) + Workers Paid status.
- PILOT-1133: Gitea token `CP_GITEA_MIRROR_TOKEN` + owner org.
- PILOT-1136: land D-112 in DECISIONS.md.
- PILOT-1146/1147: Argo repoURL, AppProject, npm tokens (phase 2 entry, later).

## NEEDS A HUMAN
- none (production cutover and the final hostname come at phase 6, operator + owner).

## NEXT
1. PILOT-1134 mirror (after PILOT-1133), PILOT-1135 zones (after PILOT-1132).
2. Gap follow-ups from PILOT-1140, then PILOT-1142 rig e2e.
3. PILOT-1145 staging deploy (after 1132 + 1135).
4. Phase 2: PILOT-1146, 1147, 1148, 1149, 1150, 1151.
