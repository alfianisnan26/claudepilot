# `.claude/settings.json`: why each rule exists

The permission baseline of the operating kit. **Deny rules hold even in Bypass mode**, and a deny rule wins over
an allow rule. They are guard rails against a mistake or an injected instruction, not a security boundary: a shell
in the workspace can do anything its credentials allow. So the rule that matters most is the charter's: a deny is
never worked around (another script, `sh -c`, another tool, another flag order). A blocked need goes under NEEDS A
HUMAN. Deny rules are a person's to change (the charter's walls); agents propose changes by ticket.

Slots: `{{DEFAULT_BRANCH}}` is the protected release branch, `{{INTEGRATION_BRANCH}}` the working branch,
`{{APP_NAMESPACE}}`, `{{WORKSPACE_NAMESPACE}}` and `{{GITOPS_NAMESPACE}}` the namespaces that run the product,
the agents' own workspaces and the GitOps controller. A project with no cluster still fills them with names that
exist nowhere (`none-app`, `none-ws`, `none-gitops`): the rules then never match and the file stays valid.

Rules marked **kit** are stricter additions of the kit; every other deny rule is carried over unchanged from the
platform's own repository.

## Allow (fewer prompts for routine, read-only or gated work)

| Rule | Why |
| --- | --- |
| `Bash({{INSTALL}})` | Installing dependencies is routine and changes only the checkout. |
| `Bash({{TEST_QUICK}}:*)` | The quick gate runs before every integration push. |
| `Bash({{TEST_FULL}}:*)` | The full gate runs before every deploy. |
| `Bash(scripts/gate-job.sh:*)` | The full gate as a cluster Job: heavy work leaves the workspace. |
| `Bash(scripts/gate-job-stop.sh:*)` | The narrow door that stops only gate Jobs and their Secrets. |
| `Bash(scripts/job-run.sh:*)` | Heavy commands as cluster Jobs, with caps. |
| `Bash(scripts/dev-rig.sh:*)` | The only door to create and delete a test namespace (`dev-rig-<name>`). |
| `Bash(git status/diff/log/show/branch/rev-parse/merge-base:*)` | Reading the repository. |
| `Bash(git fetch/pull/add/commit/switch/stash:*)` | Everyday local work. |
| `Bash(git worktree add:*)`, `Bash(git worktree list:*)` | One worktree per unit of work is how sub-agents run in parallel. `remove` is left to ask: `remove --force` discards uncommitted work, like `git reset --hard`. |
| `Bash(git push:*)` | Pushing a branch is how work is shared and gated; the deny list below narrows it. |
| `Bash(gh pr/run/repo/issue view and list:*)`, `Bash(gh auth status)` | Reading a GitHub host; nothing changes. |
| `Bash(kubectl get/describe/logs/top/events/rollout status/auth can-i/version/api-resources:*)` | Reading the cluster freely. |
| `Bash(shellcheck:*)` | Linting scripts. |

The source repository also allows `kubectl apply`, `create`, `patch`, `delete`, `scale`, `exec`, `annotate`,
`label` and `rollout restart/undo` for its own operations. The kit leaves them out: a new project asks for each
one, or adds it by a reviewed change.

## Deny: history and remote branches

| Rule | Why |
| --- | --- |
| `Bash(git push --force:*)` | A force push rewrites shared history and can destroy someone's work (charter: hazardous action). |
| `Bash(git push -f:*)` | The short form of the same. |
| `Bash(git push --force-with-lease:*)` | Still a rewrite of pushed history. |
| `Bash(git push * --force*)` | A force flag after the remote or refspec. |
| `Bash(git push * -f)` | `-f` as the last word. |
| `Bash(git push * -f *)` | `-f` in the middle. |
| `Bash(git push * +*)` | A `+refspec` forces that one ref. |
| `Bash(git push +*)` | A `+refspec` right after `push`. |
| `Bash(git push --atomic:*)` | An atomic push names several refs at once, a way to slip the release branch past the per-branch rules; push one branch at a time. |
| `Bash(git push --mirror:*)` | Overwrites and deletes every ref on the remote. |
| `Bash(git push --delete:*)` | Deletes a remote branch: lost work, broken links from tickets and runs. |
| `Bash(git push origin --delete:*)` | The same with the remote named. |
| `Bash(git push * --delete*)` | The same with the flag later. |
| `Bash(git push origin :*)` | Meant for an empty-source refspec (`origin :branch`), which deletes a branch. [unverified: whether the matcher reads it so; it does not block ordinary pushes to `origin`] |
| `Bash(git push --no-verify*)` (**kit**) | Skipping hooks skips the trailer and secret checks. |
| `Bash(git push * --no-verify*)` (**kit**) | The same with the flag later. |
| `Bash(git commit --no-verify*)` (**kit**) | A commit that skips its hooks can carry a secret or no trailers. |
| `Bash(git commit * --no-verify*)` (**kit**) | The same with the flag later. |

## Deny: the protected branch

`{{DEFAULT_BRANCH}}` changes only through the deploy pipeline's release job, after a person's approval. A push by
hand is a deploy without that approval.

| Rule | Why |
| --- | --- |
| `Bash(git push origin {{DEFAULT_BRANCH}}:*)` | Pushing the release branch by name. |
| `Bash(git push origin HEAD:{{DEFAULT_BRANCH}}:*)` | Pushing the current commit onto it. |
| `Bash(git push origin HEAD:refs/heads/{{DEFAULT_BRANCH}}:*)` | The same with the full ref name. |
| `Bash(git push origin {{INTEGRATION_BRANCH}}:{{DEFAULT_BRANCH}}:*)` | Promoting the working branch by hand. |
| `Bash(git push * {{DEFAULT_BRANCH}}:*)` | Any remote, by name. |
| `Bash(git push * HEAD:{{DEFAULT_BRANCH}}:*)` | Any remote, the current commit. |
| `Bash(git push * HEAD:refs/heads/{{DEFAULT_BRANCH}}:*)` | Any remote, full ref name. |
| `Bash(git push * {{INTEGRATION_BRANCH}}:{{DEFAULT_BRANCH}}:*)` | Any remote, promoting the working branch. |
| `Bash(git push * *:{{DEFAULT_BRANCH}}:*)` | Any source ref onto it. |
| `Bash(git push * *:refs/heads/{{DEFAULT_BRANCH}}:*)` | Any source ref onto it, full ref name. |

## Deny: destructive local git

| Rule | Why |
| --- | --- |
| `Bash(git reset --hard:*)` | Throws away uncommitted work, often another agent's in a shared folder. |
| `Bash(git clean:*)` | Deletes untracked files for good. |

## Deny: printing the environment

Sessions carry tokens in their environment (the session's Portal MCP token, registry and package tokens). One
printed environment puts them in a transcript.

| Rule | Why |
| --- | --- |
| `Bash(env)` | Prints every variable. |
| `Bash(printenv)` | The same. |
| `Bash(set)` | Prints variables and functions. |
| `Bash(env \| *)` | A filter after it still prints what the filter misses. |
| `Bash(printenv \| *)` | The same. |
| `Bash(set \| *)` | The same. |
| `Bash(* /proc/*/environ*)` | Another process's environment, read with any tool. |
| `Bash(cat /proc/*/environ*)` | The same with `cat`. |

## Deny: credential files

| Rule | Why |
| --- | --- |
| `Read(~/.kube/**)` | The kubeconfig holds a cluster token. |
| `Read(~/.config/gh/**)` | The GitHub CLI's token. |
| `Read(~/.git-credentials)` | Plain-text git host tokens. |
| `Read(~/.ssh/**)` | Private keys. |
| `Read(~/.cloudflared/**)` | Tunnel credentials. |
| `Read(~/.docker/config.json)` (**kit**) | Registry logins. |
| `Read(~/.npmrc)` (**kit**) | Package registry tokens. |
| `Read(./.env)` | The project's local secrets. |
| `Read(./.env.*)` | The same, per environment. |
| `Bash(gh auth token:*)` | Prints the GitHub token. Scripts that need it pipe it straight into a Secret. |
| `Bash(gh auth login:*)` | Changes whose identity the workspace acts as. |
| `Bash(gh auth refresh:*)` | Changes the token's scopes. |

## Deny: the cluster outside the narrow doors

Read freely; change only a rig namespace through `scripts/dev-rig.sh`. These rules match `kubectl -n <ns>` written
first; the charter forbids reaching the same change with another flag order.

| Rule | Why |
| --- | --- |
| `Bash(kubectl get secret:*)` | Secret values are base64, not hidden. |
| `Bash(kubectl get secrets:*)` | The same, plural. |
| `Bash(kubectl describe secret:*)` | Shows keys and sizes of Secrets. |
| `Bash(kubectl * get secret*)` (**kit**) | The same with flags such as `-n` first. |
| `Bash(kubectl * describe secret*)` (**kit**) | The same with flags first. |
| `Bash(kubectl delete namespace:*)` | Deletes everything in it; rigs go through `scripts/dev-rig.sh`. |
| `Bash(kubectl delete ns:*)` | The short form. |
| `Bash(kubectl * delete namespace*)` (**kit**) | The same with flags first. |
| `Bash(kubectl * delete ns*)` (**kit**) | The same, short form, flags first. |
| `Bash(kubectl delete clusterrolebinding:*)` | Removes cluster-wide access, possibly the workspace's own. |
| `Bash(kubectl -n {{APP_NAMESPACE}} delete/scale/rollout/patch/apply/edit/replace/annotate/label:*)` (nine rules) | The running product: it changes only through the deploy pipeline. |
| `Bash(kubectl -n {{WORKSPACE_NAMESPACE}} delete/scale/rollout/patch/apply/edit/replace/annotate/label:*)` (nine rules) | The agents' own workspaces: a change can kill the session that made it, and every other one. |
| `Bash(kubectl -n {{GITOPS_NAMESPACE}} delete/scale/rollout/patch/apply/edit/replace/annotate/label:*)` (nine rules) | The GitOps controller: a change there deploys, or stops deploys, outside the pipeline. |
