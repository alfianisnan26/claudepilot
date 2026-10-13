---
description: One screen of cluster health for the portal: Argo CD, pods, node load, warnings, portal log
allowed-tools: Bash(scripts/k3s-status.sh:*), Bash(kubectl get:*), Bash(kubectl describe:*), Bash(kubectl logs:*), Bash(kubectl top:*)
---
Run `scripts/k3s-status.sh` and summarise: is the Argo CD app Synced and Healthy, is the portal pod Ready and on which image, are workspace pods Pending
(and why: `kubectl -n isnan-claudepilot-workspaces describe pod <name>`), which node is short of CPU requests or memory, and anything in the warnings that matters.
Say what you would do next; do not change anything.
