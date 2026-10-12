# status-cx1 (T1 control plane and registry), FINAL 2026-10-12 ~07:10Z

RESUME HERE: nothing left to build. Only: (1) read the last typecheck (scratchpad/cx1-tsc2.out), (2) cleanup of /tmp/cx1-* (test temp dirs older than 20 min, scratch scripts, logs) and the scratchpad cx1-*.out files, (3) the final report.

Built: connect/{seams,store,events,settings,registry,enrollment,hub,admin,routes,publicRoutes,runtimes,authz,validate,tokens,agentText,config,bundle,installPort,index,testkit}.ts, connect/tunnel/** (frame, mux, stream, lines, records, auth, ws, open, memory, conformance, index), connect/qa/stubAgent.ts; migrations 130+131; config.connect; live topic 'connect'; cpen_ redactor patterns; app.ts mount; index.ts wiring (createConnect, wireConnect before resume, attach before attachShell); contract: CONNECT_REMOVE_QUERY + CONNECT_API.removeTarget (query is `onWorkspaces`), actor comment.
Tests: 224 in 17 files, all green (tunnel/conformance/fuzz/perf, enrollment, registry, hub, hub.attacks, routes, security, runtimes, integration with the REAL agent, stub agent, redactors). Full server suite: 2142 tests, 2119 pass, 2 fail outside Connect (agent limits.test.ts hung 8 min, passes alone 7/7; platform.test.ts "triggers already registered"), 21 skipped. Typecheck: only others' errors (checked before the last edits; re-check pending).
Verified on a real scratch portal (clean env): enroll/connect/rotate/revoke/restart/Locked store/kill switch, and the real agent in Docker mode with a real workspace container: 428 -> onWorkspaces=remove (container+volume gone) and keep (container stays). cx1 containers/volumes removed.
PRD: C1 row Built + §14 schema + §22.1 D19-D23 + FR9/§15 query name. README row and the PRD's top status line left to T6/coordinator.
Decisions: see the PRD §22.1 D19-D23 and the C1 note; multi-user light touch via authz seam; clean env rule; heavy commands under flock.
Blockers: none.
