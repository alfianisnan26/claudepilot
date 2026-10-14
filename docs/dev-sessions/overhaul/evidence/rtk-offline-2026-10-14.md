# RTK offline evaluation (T-286 step 1 and step 2 preparation), 2026-10-14

Binary: github.com/rtk-ai/rtk release **v1.0.0** (published 2026-10-13), asset `rtk-x86_64-unknown-linux-musl.tar.gz`, sha256
`b0b69fbed72f55d8eae18587c0b6bc140a8a8b39d5b7c6e6df33795249940926`: equals the release's `checksums.txt` and the GitHub asset digest; checked
before the first run. Its LICENSE is Apache-2.0 (plus LICENSE-ENGINE; an `rtk-oss` edition also exists, its checksum matched too, not measured).
Telemetry: `RTK_TELEMETRY_DISABLED=1` in every run plus `rtk telemetry disable`; no hook installed; no token in its environment (`env -i`, empty
HOME, both arms identical). Machine: light commands on the dev pod (x86_64), heavy ones in cluster Jobs (`scripts/job-run.sh`, node k3s-master):
Job claudepilot-job-a3e118f7 (first run, my failing-test paths were wrong, not used for fail rows) and claudepilot-job-5f80a2d6 (the table below).
Wall times: median of 3 runs; rtk adds about 30 ms of start-up on light commands.
Scripts: `tools/qa/rtk-measure.sh`, `tools/qa/rtk-fidelity.mjs`, `tools/qa/rtk-deny-parity.mjs`. Raw outputs: `/home/node/.local/rtk-v1.0.0/out/` (not committed).
Not done: `kubectl get` (rtk kubectl would read ~/.kube/config, which this task may not touch), `npm ci` (needs the npm token that rtk must not see; the Job's own
plain `npm ci` took 17 s), vitest (both apps use `node --test`). konfersi-universe is a 3-commit shell meta-repo with no node project: light commands only.

## Table (bytes = stdout and stderr together; ratio = rtk / plain)

| class | label | bytes plain | bytes rtk | ratio | exit plain / rtk | ms plain / rtk |
| --- | --- | --- | --- | --- | --- | --- |
| git-status | claudepilot | 870 | 396 | 0.455 | 0 / 0 | 10 / 42 |
| git-log | claudepilot | 1987 | 1725 | 0.868 | 0 / 0 | 5 / 30 |
| git-diff-stat | claudepilot | 1769 | 1769 | 1.000 | 0 / 0 | 15 / 40 |
| ls | claudepilot | 1418 | 474 | 0.334 | 0 / 0 | 5 / 37 |
| ls-deep | claudepilot | 4728 | 1320 | 0.279 | 0 / 0 | 5 / 57 |
| grep | claudepilot | 22755 | 22755 | 1.000 | 0 / 0 | 23 / 67 |
| grep-native | claudepilot | 22755 | 47 | 0.002 | 0 / 2 | 26 / 35 |
| git-status | konfersi-universe | 100 | 49 | 0.490 | 0 / 0 | 6 / 47 |
| git-log | konfersi-universe | 220 | 220 | 1.000 | 0 / 0 | 5 / 30 |
| git-diff-stat | konfersi-universe | 118 | 118 | 1.000 | 0 / 0 | 5 / 56 |
| ls | konfersi-universe | 600 | 214 | 0.357 | 0 / 0 | 5 / 49 |
| ls-deep | konfersi-universe | 600 | 214 | 0.357 | 0 / 0 | 5 / 38 |
| grep | konfersi-universe | 1218 | 411 | 0.337 | 0 / 0 | 13 / 51 |
| grep-native | konfersi-universe | 1218 | 33 | 0.027 | 0 / 2 | 11 / 36 |
| node-test | pass | 6516 | 103 | 0.016 | 0 / 0 | 3112 / 3247 |
| web-node-test | pass | 2984 | 102 | 0.034 | 0 / 0 | 285 / 274 |
| tsc | server-pass | 0 | 28 | 0.000 | 0 / 0 | 27841 / 27978 |
| node-test | fail | 8019 | 141 | 0.018 | 1 / 1 | 2610 / 2700 |
| node-test | fail-err | 8022 | 2833 | 0.353 | 1 / 1 | 2547 / 2567 |
| node-test | fail-spec | 5324 | 412 | 0.077 | 1 / 1 | 2640 / 2389 |
| web-node-test | fail | 2764 | 141 | 0.051 | 1 / 1 | 306 / 320 |
| web-node-test | fail-err | 2765 | 1382 | 0.500 | 1 / 1 | 260 / 266 |
| web-node-test | fail-spec | 2138 | 174 | 0.081 | 1 / 1 | 266 / 307 |
| tsc | server-fail | 484 | 565 | 1.167 | 2 / 2 | 31653 / 26879 |

## Fidelity (sets of failing test names, error messages, file:line in plain must be in rtk)

| command | items | missing | parity |
| --- | --- | --- | --- |
| node-test.fail | 11 | 11 | 0% |
| node-test.fail-err | 11 | 6 | 45.5% |
| node-test.fail-spec | 13 | 13 | 0% |
| web-node-test.fail | 5 | 5 | 0% |
| web-node-test.fail-err | 5 | 3 | 40% |
| web-node-test.fail-spec | 7 | 7 | 0% |
| tsc.server-fail | 9 | 0 | 100% |

Rows: rtk forms are `rtk git ...`, `rtk ls -la`, `rtk grep -rn` (grep), `rtk grep <sym> <dir>` (grep-native), `rtk test node --test ...` (default),
`rtk err ...` (fail-err), `rtk test ... --test-reporter=spec` (fail-spec), `rtk npx tsc ...`. `fail` rows hold deliberate failures generated inside the Job (never committed).

Reading: `rtk test node --test` (TAP or spec) keeps only the last 5 lines and a `rtk recall <hash>` pointer: every failing test name and file:line is gone from
what the agent sees (0 percent parity); the agent must call `rtk recall` to see them. `rtk err` keeps part of it (40 to 45 percent). `rtk npx tsc` keeps 100 percent
of errors (and adds a summary: 1.17x on a small error set). Passing runs shrink 97 percent, which is harmless. Exit codes were identical in every row but
`grep-native` (`rtk grep <sym> <dir>` without -r: rtk exit 2, plain `grep -rn` exit 0: not a like-for-like row). `rtk grep -rn` on this repo was byte-identical to
plain (output above rtk's passthrough size); on konfersi-universe it shortened lines.

## Step 2 preparation: deny-rule parity (`tools/qa/rtk-deny-parity.mjs`; it runs only `rtk rewrite`, which executes nothing)

Verdict: UNSAFE as is. 28 of 70 Bash deny rules (every `git push` rule, `kubectl get secret(s)`, `kubectl describe secret`, `cat /proc/*/environ*`) are bypassed
by the rewritten form (`rtk git push ...`, `rtk kubectl get secret`, `rtk read /proc/...`) because the patterns are anchored on the first word. rtk reads the same
rules itself and answers exit 2 (defer to deny) for 25 of the 28, but not for 3 (`git push * *:main`, `git push * *:refs/heads/main`, `git push +*`: exit 0, it may
auto-allow). 42 rules are unchanged by rtk (`env`, `printenv`, `set`, every `kubectl -n <ns> patch/apply/...`, `git reset --hard`, `git clean`, gh auth). The 7 `Read(...)`
rules guard the Read tool, which a Bash hook does not rewrite. A hook is allowed only after a mirrored `Bash(rtk ...)` deny set exists, this test passes, and Claude
Code's permission check on the hook's updatedInput is confirmed in a scratch session.
