# G1 status (workspace git, server) - FINISHED 2026-10-12 ~05:50 UTC
## RESUME HERE
Nothing left to do. Final report sent. If asked: re-run COORD/g1-ro-scan.mts (needs RO_IMG with git+jq), or extend the host with a clone/init command (PRD Q4).
## Done (all verified, see docs/prd/workspace-git.md section 17)
- contract packages/contracts/src/repos.ts + live topic 'repos'; migration 120; host commands repo-find / repo-state / repo-track / repo-sync (chat/host.ts, additions only; images/workspace/cp-session regenerated)
- apps/server/src/repos/*: text, parse, tree, events, store, host, service, routes, portalTools, index (+ testkit); wired in index.ts, app.ts, config.ts, live.ts
- 71 tests in repos/*.test.ts (real git + real host script), 113 with the chat host and live tests: all pass; server typecheck clean; web typecheck and build pass; QA boot tests 52/52
- live: real portal + real Docker workspace: scan of 20 and of 42 repos in 1.2 and 1.8 s, timer round noticed a commit, worktree via API and via MCP, sync updated / refused, MCP tools over /mcp; hostile repo inert
- real pool (read-only, counts only): 18 repos = root + 17 nested, 2.8-4.5 s, 0 errors
## Decisions
see PRD section 19 (home folder default root, path-based ids, re-read known repos, sync refuses repos whose config runs programs, attribution by presence, Kubernetes never scanned)
## Cleanup
tmux gtportal, container + volume gt-ws, /tmp/gt-*, test temp dirs: removed. g1-ro-scan.mts stays in COORD for you.
