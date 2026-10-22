---
description: Run the release gate on a clean copy of a commit (typecheck, web build, web tests, server suite) and report
argument-hint: [commit, default HEAD]
allowed-tools: Bash(scripts/gate.sh:*), Bash(git log:*), Read
---
Run `scripts/gate.sh $ARGUMENTS` (the default is HEAD). It takes several minutes; wait for it.
Report one line per step (npm-ci, typecheck, web-build, web-tests, server-suite with its counts) and, for every `not ok`, the test name and its error
(read `/tmp/gate-<sha>.logs/server-suite.log` around the failure). Before you call a failure a flake, run that test file alone three times
(`cd apps/server && node --import tsx --test <file>`); a test that depends on the date or the load is a bug to fix, not to ignore.
Never call the gate green with a failure in it.
