# Example: one project's deny rules and narrow doors

The first program that used this kit. Your project's rules are in its own `.claude/settings.json` and docs; read them, they may be stricter.

## Deny rules there, and why

| Denied | Why |
| --- | --- |
| Every force-push form (`--force`, `-f`, `--force-with-lease`, `+` refspecs), `--mirror`, `--atomic`, `--delete`, pushing to `:branch` | Pushed history is never rewritten or removed |
| Any push to `main` | Pushing `main` deploys (GitOps follows it); only the release pipeline does it after approval |
| `git reset --hard`, `git clean` | They destroy uncommitted work, often someone else's |
| `kubectl delete namespace`, `delete clusterrolebinding` | Cluster-wide damage, and revoking the workspace's own access |
| Changes (`apply`, `patch`, `edit`, `replace`, `delete`, `scale`, `rollout`, `annotate`, `label`) in the portal, workspaces and GitOps namespaces | The workspace pod hosts the sessions; the portal and GitOps are production |
| `kubectl get secret(s)`, `describe secret` | Dumps credentials |
| `gh auth token`, `gh auth login`, `gh auth refresh` | Prints or changes the owner's git host login |
| Reading the kubeconfig folder, the git host CLI login folder, the git credential store, the private key folder, the tunnel credentials folder, `.env` and `.env.*` | Credential stores |
| `env`, `printenv`, `set` (alone or piped), anything reading `/proc/*/environ` | The environment carries tokens; the owner's sign-in code must never be read |

## Narrow doors there

| Door | Does | Refuses |
| --- | --- | --- |
| `scripts/dev-rig.sh create dev-rig-<name>` (also `delete`, `list`) | Creates a namespace labelled as a rig with baseline pod security; deletes it | Any other name; deleting a namespace that carries neither the rig label nor the platform's managed label |
| `scripts/job-run.sh ... -- <command>` | Runs a command as a labelled, capped Job on another node from a pushed ref; its token lives in a Secret the Job owns, deleted on exit, masked in the log | Paths outside the repository for artifacts, timeouts outside 60 to 5,400 s |
| `scripts/gate-job.sh <commit> [steps]` | Runs the full gate as a Job on a pushed commit | Unknown steps, test files outside the server sources |
| `scripts/gate-job-stop.sh` | Stops gate Jobs and their Secrets | |

A workspace's CPU and memory there are changed by a person in the portal (the workspace sheet, or an admin-only tool); an older script for it was retired.

## Things that are true there and matter

- The workspace has a cluster-admin kubeconfig and the owner's git host token in its shell. The deny rules and the pipeline's approval guard the sanctioned path; they do not make the shell harmless. That is exactly why the rules are followed by choice, not by force.
- A throwaway portal started without a clean environment inherits that kubeconfig and token. The project's scratch-portal script starts it from an empty environment; use it.
