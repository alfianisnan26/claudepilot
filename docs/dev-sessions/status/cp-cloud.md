# cp-cloud status (2026-11-06, session d4abf769-ab27-4364-8320-8336e28215fc)

Epic PILOT-1131 (T-3680): ClaudePilot core to Cloudflare (KohiLabs), repo to KohiLabs Gitea. Integration branch `cf/integration` (from integration 6150655e5).

## DONE
- Decisions D1-D7 + hard limits recorded on PILOT-1131 (comment 57923). Phase tickets PILOT-1132..1156.
- Merged and closed, each with its job and review on the ticket (details in this file's git history): 1140, 1139, 1143, 1141, 1162, 1144, 1138, 1159, 1172, 1168.
- PILOT-1145 DONE by the operator as coordinator (job 5afb4f9e on 27102ae): https://pilot-next.kohi-labs.com serves cp-next-core behind Access (anon 403, service token 200), closed by the operator. Script merged 599c96411..0022bff07 (review PASS on 27102ae67f10, in cf-review's report; ticket closed). Minors -> PILOT-1180.
- Also merged and closed (git history of this file): 1158, 1160, 1183 (INCIDENT: the 1172 merge turned agent.e2e red; test fix 86a54acf0), 1179, 1169, 1170, 1181, 1180, 1184.
- Also merged and closed: 1163, 1161, 1171 (follow-ups 1187, 1188), 1185 slice 1. PILOT-1148 SPA assets is merged but stays in_review until the coordinator's staging deploy (comment 60128).
- PILOT-1185 slice 2 (c7e5fb84c..072b179c2 as 0c033b35f..b830ca8e0, PASS 60152) and PILOT-1187 (f417f3bee..49bf27b11 as 579fef0d1..1464c4530, PASS 60154; PRD conflict merged by hand) merged, pack 4857b597b.
  - Job 472e2d65 on 4857b59: typecheck, pack, prettier, core-worker 114+10+4, server 478 pass 0 fail, web 4.
  - Job 01e9fac0 on 37c231d: server 341, web 4. Its Prettier red is on AccessPage, ApprovalCard and LoginPage, which were unformatted at the base (job e6e9bc7c: a 187-line diff against 29 merged lines), so they are not reformatted.
  - 1185 can close. 1187 stays open for the image-wall fix.
- PILOT-1188 exec hardening + PILOT-1186 minors merged 4fb24736a..42cf151cc (self-test job 70b24d13 on f39a72518; NORMAL).
  - The connect.ts conflict was resolved to the built-in list; the agent bundle was regenerated on the merged tree (job ee234251).
  - Merged-tree job 3dfacd3c: typecheck, pack, prettier, core-worker 121+10+4, server 499 pass 0 fail, web targets 10.
  - Both closed.
- PILOT-1189 boot banner: merged fe9a2faf7 + 42521c82c (PASS 60273; job 9b47d193, server 346) and the minors 1cb65b139 (PASS 60289; job d6a5917a, 15 pass). Closed.
- PILOT-1187 Worker spec check: merged 579fef0d1..1464c4530 and the fix round 15c5cec45..3254fa74c (PASS 60279). Job 66ee067d on 4ac73a8: typecheck, pack, prettier, core-worker 122+10+4, server 509 pass 0 fail. Closed. Follow-ups are in PILOT-1190.
- PILOT-1190 SA token off + CP_KUBE_IMAGES: merged as 1dae9eb54 + 2c7362d32 (PASS 60389 on 256cc6cd4; the diff against it is empty).
  - Job 27ec29f2 on 385c723: typecheck, pack.
  - Job 9cfb3ec5: prettier on the clean files, core-worker 122+12+4, server 201, 0 fail.
  - The Prettier diffs on kubernetes.ts and kubeTargets.test.ts all predate the branch (none on the merged lines 471-473 and 141-142), so they are not reformatted.
  - Closed. The contract part is PILOT-1192.
- PILOT-1132 (CF token) and PILOT-1135 (zone kohi-labs.com, host pilot-next.kohi-labs.com) closed: the operator delivered the `cp-next` pool.

## IN FLIGHT
- Builders and cf-sec resumed at 04:28Z (2026-11-06), after the 04:10 reset.
- cf-review (worker 68d76aeb, opus, auto): idle. Review FAIL 60485/60486 on the gaps head 084d62c8a: major 1 (PILOT-1164), "root only in its exact shape" does not hold (implicit root image, nulling PATCH). 1157 PASS, 1167 PASS with a minor. Next: the re-check of the fix round. PILOT-648 and 114 are closed as superseded (60396).
- cf-sec (worker e28ec1b4, opus): PILOT-1191 (T-3890), the full /security:security-audit of cp-next-core + cp-bridge, read only; it excludes the files it wrote itself.
- cf-bridge (worker 5bc808ae, opus, builder 1 of 2): first, the fix round for FAIL 60485 on ticket/T-3722-gaps (the same builder, D-81); then the 1137 gate bundle PILOT-654 (cookie `__Host-` + Secure) + PILOT-186 (redaction), HIGH, on ticket/T-976-cookie-redact; it reuses the old branches T-976-merge and T-1065-redact.
- cf-worker (worker 6562167d, opus, builder 2 of 2): PILOT-1149 (T-3707, HIGH), the /api proxy to a SCRATCH portal over the bridge, stub-tested; branch ticket/T-3707-api-proxy.
- PILOT-1142 rig: refused again; ws-isnan-jobs cannot create namespaces (comment 59344). Script merged (2dfb4d129, 1d41f3ccd); ticket open.
- PILOT-1136 (lead): blocked; the D-112 row waits on the coordinator.

## DECISIONS
- 08:50 No "2026-10-30 security sweep" exists; PILOT-1137 tracks the exposure tickets (+1138, 1139, 1168).
- 08:50 Phase-2 API proxy targets a scratch portal, never the live one (hard limit).
- 08:55 DECISIONS.md is a rule file (guard, D-60): the D-112 row goes to the coordinator on PILOT-1136.
- Workers on Opus: backend/infra/security per owner routing 2026-10-25. Reviewer in mode auto (dontAsk refused git).
- 11:45 Operator pacing (one account): at most 2 builders at once; cf-review takes review asks only. Only cf-migration tickets.
- 21:45 Operator: resume after the 21:40 reset; 1145 deploy + 1142 rig first, then phase 2 (1146-1148); 2 workers. cf-worker retries the exact 1145 command once on that instruction; a second refusal stops it (no other path).
- Session limits on two.claude: ~09:20-11:30, ~12:30-16:40 and ~17:30-21:40 and ~23:00-02:40 and ~03:35-07:50 and ~08:40-12:50 and ~13:45-18:00 and ~18:35-23:00 and ~23:20-04:10 UTC (2026-11-05/06; crew resumed 02:53Z, 07:54Z, 13:05Z, 18:10Z and 23:12Z). Resume everyone right after each reset; note the reset here.
- 22:35 After incident PILOT-1183: before every cf/integration push, the lead runs ONE job on the merged tree: typecheck, context pack, core-worker tests and the server test directories the merged branches touch.
- 03:25 Merged-tree job runners: server AND web tests are node --test (not vitest); only core-worker uses vitest (npm test). Two false reds came from the wrong runner.
- 08:10 Prettier on apps/server/src/{config,index,portal}.ts already fails at the base: not reformatted (a large unrelated diff). Changed files must pass prettier --check; builders run it in their first job.
- 13:10 PILOT-1187 major 1 (a foreign image is not refused by the Worker): option (a), a Worker-side image allow list from Worker config, where empty means refuse, with a test, plus SA token mounts. Rejected: (b), amending done-when, because the threat is a replaced agent. Head 49bf27b11 merges first, since it only adds a wall. I couldn't comment on the ticket (worker-held), so cf-worker posts the decision.
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
- PILOT-1185 (after the slice 2 merge on cf/integration and its release by the operator): rotate PORTAL_SERVER_CODE (Secret claudepilot-server) to a random code of 26 or more characters, then set PORTAL_SIGNIN_CODE_STRICT=true. Until then the boot banner prints the code (PILOT-1189).
- PILOT-1190 (comment 60384): the stg deploy of cp-next-core from cf/integration 84c1a5796f27dbd5aa5aad6877f38eb344b15486 (holds 2c7362d32). Run `job-run.sh --ref <sha> --pool-env CP_NEXT_CF_API_TOKEN --pool-env CP_NEXT_CF_ACCOUNT_ID --pool-env CP_NEXT_ZONE --pool-env CP_NEXT_HOST -- 'node apps/core-worker/scripts/deploy-stg.mjs --plan; exit $?'`, then the same without --plan (exit 3 = deployed, token check skipped). The portal part (no SA token on new workspace pods) ships with the operator's next portal release.
- Cleanup: delete scratch branch wip/cf-worker-t3737-dbg1 (debug commit only; agents may not delete branches).
- PILOT-1146/1147: Argo repoURL, AppProject, npm tokens (phase 2 entry).

## NEEDS A HUMAN
- none (production cutover and the final hostname come at phase 6, operator + owner).

## NEXT
1. At the next free builder slot: PILOT-1192 (T-3891, HIGH), the contract part of 1190. It starts after the 1190 deploy and once the workspaces are recreated; before then, only its drift-test half.
2. The rest of the PILOT-1137 gate (audit 60391): 1123 (heartbeat id check, verify) and 113/530 (verify or finish), then the findings from PILOT-1191. PILOT-180 waits until 654 is live in production, plus one release.
3. cf-worker after 1149: 1150 pipeline (reuses the 1145 deploy script).
4. Phase 2 after the Gitea token: 1134 mirror -> 1146 origin switch -> 1147 packages; 1151 UI QA last.
5. PILOT-1142 rig run when the coordinator grants the rights.
