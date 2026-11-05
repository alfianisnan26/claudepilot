# cp-cloud status (2026-11-05, session d4abf769-ab27-4364-8320-8336e28215fc)

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
- PILOT-1168 route limiter keys merged 7e4b34d01..103716ada (job 4e2cda31 222, review PASS 58772), closed. Follow-up PILOT-1179 (go-live blocker).
- PILOT-1145 DONE by the operator as coordinator (job 5afb4f9e on 27102ae): https://pilot-next.kohi-labs.com serves cp-next-core behind Access (anon 403, service token 200), closed by the operator. Script merged 599c96411..0022bff07 (review PASS on 27102ae67f10, in cf-review's report; ticket closed). Minors -> PILOT-1180.
- PILOT-1158 (G5 app ports on enrolled kube) + PILOT-1160 (G7 big stdin / long exec) merged 2c033546f..2fa3b2e53 (job 05ad0b6b 35), closed (NORMAL, self-test).
- INCIDENT PILOT-1183: the 1172 merge (e7a3df776) turned agent.e2e's kube case red on cf/integration (bisect in comment 59420). Test-only fix 86a54acf0, closed.
- Merged 86a54acf0..92c02662b: 1183, 1179 (82a7ed112..ba8674e60, review PASS 59397), 1169 (ac6e7e9d3..4e5c3cb3a), 1170 (6e4eae6b4..ea72d35fa, review PASS 59409), 1181 (92c02662b). Merged-tree check: job a8c65a26 typecheck clean, pack fresh, core-worker 68 pass; job 141c483f server connect/auth/appports/limiter 553 pass 0 fail. All five closed.
- PILOT-1180 deploy safe re-run (d08e42831..46edd7284, review PASS 59423+59478) and PILOT-1184 go-live checks (edf1ac0d4..edc23a891, review PASS 59480) merged. Merged-tree job 66ccda39: typecheck, pack fresh, core-worker 68 + scripts 7, server qa/auth 261, 0 fail. Both closed.
- PILOT-1163 resize allowlist + RBAC (5abd1f455..5440c3d89, review PASS 60004) and PILOT-1161 built-in ids (61c7d041c, review PASS 60007) merged; pack d73c10de1. Merged-tree jobs 2293db23 (typecheck, pack) + c89c2515 (server connect/workspaces 670 pass 0 fail, web targets 9, core-worker 68+7). Both closed; minors -> PILOT-1186.
- Merged a67f318c4..ec9cf77f1 (merged-tree job be235d94 on fc7a0af: core-worker 91 + scripts 10 + router 4, server 361, 0 fail; job 42c2ba41 on ec9cf77: typecheck, pack; ec9cf77 is a prettier-only fix):
  - PILOT-1148 SPA assets (edf473a1a..4232195e0, review PASS 59965 + 60023). Left in_review: the staging deploy is FOR THE COORDINATOR (comment 60128).
  - PILOT-1185 slice 1 (2fd100a5d..607f3ffe4, PASS 60025).
  - PILOT-1171 slice 1 (6aabfcaa6..df3f775b3, PASS 60124).
  - The last two stay open with their builders for slice 2.
- PILOT-1132 (CF token) and PILOT-1135 (zone kohi-labs.com, host pilot-next.kohi-labs.com) closed: the operator delivered the `cp-next` pool.

## IN FLIGHT
- cf-review (worker 68d76aeb, opus, auto): idle, waits for slice-2 review asks (1185, 1171).
- cf-sec (worker e28ec1b4, opus, builder 1 of 2): PILOT-1185 slice 2 (strong generator, long codes end to end, sign-in field, ux-check on a scratch portal), branch ticket/T-3854-signin-code-r2. After it merges, FOR THE COORDINATOR: rotate PORTAL_SERVER_CODE (Secret claudepilot-server) to >=26 chars, then PORTAL_SIGNIN_CODE_STRICT=true.
- cf-bridge (worker 5bc808ae, opus): idle (builder cap 2 full). Next: PILOT-1186 (minors of 1163/1161), then gaps 1164, 1157, 1167.
- cf-worker (worker 6562167d, opus, builder 2 of 2): PILOT-1171 slice 2 (exec v5/v4, resize ch 4, relay to caller WS), branch ticket/T-3737-worker-kube-exec from the slice-1 head. 1148 replay and 1171 slice 1 done, in review.
- PILOT-1142 rig: refused again; ws-isnan-jobs cannot create namespaces (comment 59344). Script merged (2dfb4d129, 1d41f3ccd); ticket open.
- PILOT-1136 (lead): blocked; the D-112 row waits on the coordinator.

## DECISIONS
- 08:50 No "2026-10-30 security sweep" exists; PILOT-1137 tracks the exposure tickets (+1138, 1139, 1168).
- 08:50 Phase-2 API proxy targets a scratch portal, never the live one (hard limit).
- 08:55 DECISIONS.md is a rule file (guard, D-60): the D-112 row goes to the coordinator on PILOT-1136.
- Workers on Opus: backend/infra/security per owner routing 2026-10-25. Reviewer in mode auto (dontAsk refused git).
- 11:45 Operator pacing (one account): at most 2 builders at once; cf-review takes review asks only. Only cf-migration tickets.
- 21:45 Operator: resume after the 21:40 reset; 1145 deploy + 1142 rig first, then phase 2 (1146-1148); 2 workers. cf-worker retries the exact 1145 command once on that instruction; a second refusal stops it (no other path).
- Session limits on two.claude: ~09:20-11:30, ~12:30-16:40 and ~17:30-21:40 and ~23:00-02:40 and ~03:35-07:50 UTC (2026-11-05; crew resumed 02:53Z and 07:54Z). Resume everyone right after each reset; note the reset here.
- 22:35 After incident PILOT-1183: before every cf/integration push, the lead runs ONE job on the merged tree: typecheck, context pack, core-worker tests and the server test directories the merged branches touch.
- 03:25 Merged-tree job runners: server AND web tests are node --test (not vitest); only core-worker uses vitest (npm test). Two false reds came from the wrong runner.
- 08:10 Prettier on apps/server/src/{config,index,portal}.ts already fails at the base: not reformatted (a large unrelated diff). Changed files must pass prettier --check; builders run it in their first job.
- 12:00 Builders put all trailers in one final block (`%(trailers)` reads only the last paragraph).
- 12:20 PILOT-1168: key the route limiters on visitorAddress (default b). Rejected: the tunnel hop as a key; no limit until the CF binding.
- 16:45 Operator: 1145 and 1142 first. 1172 and 1169/1170 are parked as pushed WIP. Access goes in front before any route (D3).
- 16:45 PILOT-1168 must land before pilot-next serves any data path; the skeleton serves only /healthz behind Access.

## FOR THE COORDINATOR
- PILOT-1133: Gitea token `CP_GITEA_MIRROR_TOKEN` + owner org (blocks 1134 mirror and 1146 origin switch).
- PILOT-1136: land D-112 in DECISIONS.md.
- PILOT-1141: admission allow for Job claudepilot-build-bridge, Namespace isnan-cp-bridge, Secret cp-bridge-enroll, empty identity Secret per served namespace.
- Standing (operator, 21:50): crew runs in auto mode, so the classifier refuses DNS/domain changes. Any later deploy that needs one goes here as the exact command.
- PILOT-1142: service account isnan-claudepilot:ws-isnan-jobs needs create/list/delete on `dev-rig-*` namespaces + the rights in comment 58722 (refused again, comment 59344).
- PILOT-1145: the cp-next-healthcheck service-token secret is stored nowhere; a path into the cp-next pool without an agent seeing it.
- PILOT-1184 (comment 59468): a separate Traefik entrypoint for the tunnel that drops CF-Connecting-IP elsewhere; confirm the server sign-in code is random (or code sign-in off on the public host).
- PILOT-1179: a stable address range for cloudflared, then narrow PORTAL_CLOUDFLARE_HOPS (deploy/k3s/portal.yaml, now 10.42.0.0/16). PILOT-1182: a NetworkPolicy so only Traefik reaches the portal's public port.
- PILOT-1139: PORTAL_ALLOWED_ORIGINS=https://<public host> before the portal sits behind the Worker host.
- PILOT-1144: BRIDGE_CLUSTERS secret on cp-next-core; bridge bearer token in the Secrets pool.
- PILOT-1148 (comment 60128): the staging deploy that ships the SPA. job-run.sh --ref ec9cf77f1705 --pool-env CP_NEXT_CF_API_TOKEN/ACCOUNT_ID/ZONE/HOST -- deploy-stg.mjs --plan, then without --plan.
- PILOT-1146/1147: Argo repoURL, AppProject, npm tokens (phase 2 entry).

## NEEDS A HUMAN
- none (production cutover and the final hostname come at phase 6, operator + owner).

## NEXT
1. PILOT-1142 rig run when the coordinator grants the rights.
2. Go-live: a boot check that refuses a weak server sign-in code (review 59480: lifts the PILOT-1182 blocker), at the next free builder slot. PILOT-1182 (HIGH, filed by cf-sec; review: not a blocker if the server code is long): workspaces reach the portal Service directly and can forge X-Forwarded-For; a NetworkPolicy and an internal port (needs the coordinator).
3. cf-worker: 1169/1170, then 1171, then PILOT-1148 SPA assets, 1150 pipeline (reuses the 1145 deploy script), 1149 proxy.
4. cf-bridge (at a free builder slot): gaps 1161, 1163, 1164, 1157, 1167.
5. Phase 2 after the Gitea token: 1134 mirror -> 1146 origin switch -> 1147 packages; 1151 UI QA last.
