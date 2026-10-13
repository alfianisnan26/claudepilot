---
description: Build an image in the cluster (kaniko) and push it to registry.int.isnan.me
argument-hint: portal|workspace|workspace-dev <tag> [commit]
allowed-tools: Bash(scripts/k3s-build.sh:*), Bash(git log:*), Bash(git rev-parse:*)
---
Run `scripts/k3s-build.sh $ARGUMENTS`. The commit must be on `origin/integration` (push first). For `portal` the script makes a temporary Secret with the GitHub Packages token,
deletes it on exit and searches the log for the token: say what it reported. Tags: portal `YYYY.MM.DD-n`, workspace `<claude version>-YYYY.MM.DD-n`, workspace-dev `<claude version>-dev-YYYY.MM.DD-n`.
Pushing from outside the cluster does not work (slow uplink, a 60 s request cut): never try `docker push` to the registry from here.
