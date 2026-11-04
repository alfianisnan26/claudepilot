# cp-cloud status (2026-11-04, session d4abf769-ab27-4364-8320-8336e28215fc)

Epic PILOT-1131 (T-3680): ClaudePilot core to Cloudflare (KohiLabs), repo to KohiLabs Gitea. Integration branch `cf/integration` (from integration 6150655e5).

## DONE
- Decisions D1-D7 + hard limits recorded on PILOT-1131 (comment 57923). Phase tickets PILOT-1132..1156.
- PILOT-1140 gap analysis merged 9be55e4b4 (job 008f03b7), closed; gaps PILOT-1157..1164.
- PILOT-1139 origin/CSRF merged c20382436..33d6d6ffb (job 65e012f1 5194, review PASS 58245), closed.
- PILOT-1143 Worker skeleton merged 51de2b63c..42f0e097c (job 11fe24f4 16), closed.
- PILOT-1141 manifests merged bbfedf992..a294e9fb6 + PRD fix ad076bef7 (job bf0d2e6d, review PASS 58258), closed.
- PILOT-1162 multi-namespace bridge merged 882c8a494..9aa8816a4 (job 1a6d3781 107, review PASS 58261), closed.
- PILOT-1144 BridgeDO + /bridge merged b213464ff..21f9ae716 (job d8ebfaf4 61, review PASS 58260), closed. Minors -> PILOT-1172.
- PILOT-1138 rate limits merged as squash d2c92d8ae (= reviewed head 3da7888ee, job 99b742cf 158, review PASS 58332), closed.
- PILOT-1159 G6 spike merged 9072225a6..3bcca9b37 (job 3a3aee9c 41; skipped e66ef7047, a stale PRD copy), closed. Follow-ups PILOT-1169/1170/1171.
- PILOT-1172 bridge hardening merged af872f583..929d2ba74 (job 98ef1e94 158, review PASS 58743), closed.
- PILOT-1132 (CF token) and PILOT-1135 (zone kohi-labs.com, host pilot-next.kohi-labs.com) closed: the operator delivered the `cp-next` pool.

## IN FLIGHT
- cf-worker (worker 6562167d, opus): PILOT-1145 BLOCKED. The permission classifier refused the real deploy as a "DNS / Domain / Cert change"; nothing was created. Branch ticket/T-3703-stg-deploy 27102ae67 (script deploy-stg.mjs; read-only plan job 142e4726 rc 0). Back on 1169 (WIP ed1b410fe), then 1170.
- cf-bridge (worker 5bc808ae, opus): idle (pacing).
  - PILOT-1142: the script was merged as 2dfb4d129 and 1d41f3ccd (job 038cad7d, 12 pass, it SKIPs without a rig). The ticket stays open: the rig namespace and rights are FOR THE COORDINATOR (T-3700, comments 58722 and 58730).
- cf-review (worker 68d76aeb, opus, auto): idle; next review asks PILOT-1168 and 1170 (HIGH).
- cf-sec (worker e28ec1b4, opus): building PILOT-1168, the go-live blocker (comment 58355 on PILOT-1131).
- PILOT-1136 (lead): blocked; the D-112 row waits on the coordinator.

## DECISIONS
- 08:50 No "2026-10-30 security sweep" exists; PILOT-1137 tracks the exposure tickets (+1138, 1139, 1168).
- 08:50 Phase-2 API proxy targets a scratch portal, never the live one (hard limit).
- 08:55 DECISIONS.md is a rule file (guard, D-60): the D-112 row goes to the coordinator on PILOT-1136.
- Workers on Opus: backend/infra/security per owner routing 2026-10-25. Reviewer in mode auto (dontAsk refused git).
- 11:45 Operator pacing (one account): at most 2 builders at once; cf-review takes review asks only. Only cf-migration tickets.
- Session limits on two.claude: ~09:20-11:30 and ~12:30-16:40 UTC. Resume everyone right after each reset; note the reset here.
- 12:00 Builders put all trailers in one final block (`%(trailers)` reads only the last paragraph).
- 12:20 PILOT-1168: key the route limiters on visitorAddress (default b). Rejected: the tunnel hop as a key; no limit until the CF binding.
- 16:45 Operator: 1145 and 1142 first. 1172 and 1169/1170 are parked as pushed WIP. Access goes in front before any route (D3).
- 16:45 PILOT-1168 must land before pilot-next serves any data path; the skeleton serves only /healthz behind Access.

## FOR THE COORDINATOR
- PILOT-1133: Gitea token `CP_GITEA_MIRROR_TOKEN` + owner org (blocks 1134 mirror and 1146 origin switch).
- PILOT-1136: land D-112 in DECISIONS.md.
- PILOT-1141: admission allow for Job claudepilot-build-bridge, Namespace isnan-cp-bridge, Secret cp-bridge-enroll, empty identity Secret per served namespace.
- PILOT-1145 (T-3703): allow the one staging deploy command, which the classifier refused as a DNS change (exact command on the ticket); and a path that stores the `cp-next-healthcheck` service-token secret without an agent seeing it.
- PILOT-1142: a dev-rig namespace if the account still cannot make one (exact ask on T-3700).
- PILOT-1139: PORTAL_ALLOWED_ORIGINS=https://<public host> before the portal sits behind the Worker host.
- PILOT-1144: BRIDGE_CLUSTERS secret on cp-next-core; bridge bearer token in the Secrets pool.
- PILOT-1146/1147: Argo repoURL, AppProject, npm tokens (phase 2 entry).

## NEEDS A HUMAN
- none (production cutover and the final hostname come at phase 6, operator + owner).

## NEXT
1. Review + close PILOT-1145; report the pilot-next URL to the operator once /healthz answers behind Access.
2. PILOT-1168 (cf-sec) at the next free slot.
3. cf-worker: 1169/1170, then 1171, then PILOT-1148 SPA assets, 1150 pipeline (reuses the 1145 deploy script), 1149 proxy.
4. cf-bridge (when a builder slot frees): gaps 1160, 1158, 1161, 1163, 1164, 1157, 1167.
5. Phase 2 after the Gitea token: 1134 mirror -> 1146 origin switch -> 1147 packages; 1151 UI QA last.
