---
description: Start a throwaway portal in a clean environment to look at the UI or try an API, and stop it again
argument-hint: [port, default 3403]
allowed-tools: Bash(scripts/scratch-portal.sh:*), Bash(curl:*)
---
`scripts/scratch-portal.sh start $ARGUMENTS` (default port 3403, sign-in code 24681372). It starts from `env -i`: no kubeconfig, no GitHub or Claude credentials, Kubernetes off.
This matters here: this workspace's home has a cluster-admin kubeconfig, and a portal that inherits it could create and delete real workspaces.
Use it, then `scripts/scratch-portal.sh stop <port>`. Never leave one running.
