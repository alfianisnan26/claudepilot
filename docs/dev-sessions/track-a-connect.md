# Track A: Connect, finish it and prove it

Connect is how a machine, cluster or Docker host enrolls from the web and then dials OUT to the portal (an install script and an agent). It is
switched on in both deployments, but its acceptance and abuse suite never ran: **treat its endpoints as exposed.** Do not change `PORTAL_CONNECT_*`
on the real portal, and do not make Connect reachable from anywhere new.

Read: `docs/prd/targets-connect.md` (the spec; acceptance A1-A14 is in its test section, each FR has test groups; section C4 has what the installers
verified), `packages/contracts/src/connect.ts`, `docs/open-items.md` section 3 (rows T1, T2, T4, T5), and the earlier work: `docs/coord/prompts/t1.md`
`t2.md` `t4.md` `t5.md` `t6.md`, `docs/coord/RESUME-BLOCKS.md` (the blocks status-cx1 to status-cx6), `docs/coord/TODO-coordinator.md` ("T5 SECOND PASS").
Code: `apps/server/src/connect/**` (the agent bundle `connect/agent.generated.ts` is generated: regenerate it after any agent change, the generator
scripts are in `apps/server/scripts/`), `apps/web/src/features/targets/**`.

## Items, in this order

1. **T1 leftovers.** A stub agent and the performance test (T-PERF); a test that a target that returns is Running at once (`workspaces.recheck`);
   the token-less upgrade endpoint (the Outdated chip must not make a new enrollment only to show an upgrade command); a run of the whole server
   side in a scratch portal started in a clean environment.
2. **T2 leftovers.** The remaining agent service tests. `docker/limits.test.ts` once hung for 8 minutes in a loaded full-suite run (it passes alone):
   reproduce with `--test-concurrency=3`, find the cause, fix it for good (a timeout that fails fast is the minimum, the cause is the goal).
3. **T6, acceptance and abuse, as far as this pod can.** There is no Docker daemon here, so the 23 Docker-only tests skip and a rig of Docker hosts is
   not possible. What you can do: a scratch portal (`scripts/scratch-portal.sh`) plus an agent as a Kubernetes target on a rig of your own, in a
   namespace `dev-rig-connect` (least-privilege RBAC for the agent, delete the namespace when done), and the host kind against a throwaway folder.
   Run acceptance A2 to A14 wherever they apply, then abuse and failure injection: forged, replayed, expired and revoked tokens, a hostile agent
   (oversized frames, bad lengths, a slow reader, a flood of enrollments from one address, a wrong `Origin`), a portal restart with agents connected
   (A8), the tunnel cut mid-create. Every finding is fixed with a test, or written down with its severity if it is not yours to fix.
   Put the result in the PRD's acceptance table in the house style (observed, not hoped) and say exactly what still needs real machines
   (Docker, macOS, Windows, a second cluster) under NEEDS A HUMAN.
4. **T5 second pass** (web, `TODO-coordinator.md`): dark mode; 390, 768, 1024, 1280 and 1920 px; offline, revoked and partial rows; the Kubernetes,
   Host, Windows and macOS wizard steps; Remove with its question and the 428 follow-up; Add node end to end; the command block's monospace font;
   options carried over on "Command" for an existing target; the 403 "No access" sheet; hostile data (very long names, many nodes). Look at real
   screenshots with Chromium (`tools/qa/`), fix what is wrong, add a check that keeps it fixed. Text diet: titles of one or two words, explanations
   in an InfoTip.

## Done when

Items 1 to 4 are merged on `integration` with the gate green, the PRD acceptance table says what was observed, and your status file lists what a
person must still do. Then stop: do not start other tracks' items.
