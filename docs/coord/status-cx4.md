Spawn: model=opus effort=medium - Tier A: installer scripts (sh and PowerShell) run on users' machines and handle enrollment tokens, checksums and uninstall: security-relevant, big spec, verified by script tests; escalate to fable/high if the token or checksum handling proves ambiguous
# status-cx4 (T4 installers and their endpoints), 2026-10-12: DONE for W1 (C4 Partly built)

RESUME HERE (W2): when T2 lands agent.generated.ts + `enroll --token-stdin` and T1 mounts createInstallRoutes, run install.sh
from a rig host against a scratch portal (port 3214) for docker, container and host (A1/A4/A5 shape); replace the fake bundle check.
Built: apps/server/src/connect/install/{routes,plan,manifest,commands,fetcher,testkit}.ts, scripts/install.{sh,ps1},
installers.generated.ts, ../node-manifest.json, scripts/gen-connect-{installers,node}.ts, package.json gen scripts, tests
(plan, manifest, commands, fetcher, routes, scripts, ps). 48/48 green with CLAUDEPILOT_DOCKER_TESTS=1; typecheck clean for my files.
Full server suite (once): 2008 pass, 2 fail outside my area (browser/cpbview.test.ts, a chat attachment test), 21 skipped.
Decisions: PILOT_RESULT also `removed`/`ok`; pty from registry tarballs + integrity, no npm; k8s Namespace is the first doc
(dropped when it exists); `run` output on fd 3; PS fetcher via env var (5.1 quoting); host kind refuses root unless PILOT_ALLOW_ROOT=1;
missing workspace image: pull, then build from the served context (PILOT_BUILD_IMAGE=1 forces, 0 forbids).
Cleanup: no cx4 containers/volumes/tmp left; pwsh and kubeconform images removed; koalaman/shellcheck kept (shared, small).
