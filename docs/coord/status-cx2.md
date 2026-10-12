# status-cx2 (T2, the agent), updated 07:55Z

RESUME HERE: C2 is built and green in the sandbox: agent module 150+ tests (node --test 'src/connect/agent/**/*.test.ts'): host (T-HOST 26 incl. 100 MB put 26-33 MB growth),
docker policy/proxy (23 policy + 10 recorded-DockerRuntime + 4 limits), kube (14, KubernetesRuntime over loopback), client/enroll/rekey with a crash at every step (12+6),
private CA + CONNECT proxy (3), protocol/refusals (5), doctor (7), canary (3), config/identity/main (21), bundle (6: sync, hygiene, symlink regression, process e2e, idle 58.6 MB),
T1's mux conformance over the agent's client (13), agent.e2e (docker A10 + real DockerRuntime + swarm + real KubernetesRuntime over the real tunnel). Opt-in (CLAUDEPILOT_DOCKER_TESTS=1), all run
and passing: real DinD policy (5), Container rig as root (1), the bundle on Node 22.13.0 in a container (1); Q4/Q5 + 117 store-free tests re-run on Node 22.13.0.
NEXT: (1) logger remote sink for caller loggers + 20/min test, (2) docker Mount Source = the workspace's own home volume, (3) kube body checks (hostPath, privileged, hostNetwork,
PVC volumeName/dataSource, Secret type) + PATCH deep scan, (4) log.ts unit tests, (5) PRD edits (Appendix A create query note) + the C2 status note, (6) heavy.lock typecheck + the
full server suite ONCE, (7) final report. Bundle build now fe6e424c3281 (regenerate after any change in connect/agent, tunnel, seams, hostexec, runtime, connect.ts).
Findings for others: server store needs Node >= 22.16 (node:sqlite backup), root package.json says >=22.13 (not the agent); T3: stop TunnelAgent sockets when the peer ENDs (idle FIN).
