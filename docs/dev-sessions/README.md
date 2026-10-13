# Autonomous development sessions

Claude Code sessions in the cluster's development workspace (`kubernetes/kohi-event`, folder `~/work/claudepilot`) that keep building
ClaudePilot **without a person in the loop**. The coordinator (a session on the owner's Mac) starts them in Bypass mode, merges nothing for
them and watches. The owner approves deploys only. Read `CLAUDE.md`, `docs/dev-context.md` and `docs/dev-session.md` first; this file is how
you work, your track file is what you work on.

## Ground rules

1. **No questions.** Nobody answers in real time. Take the PRD's recommended default, write the decision in your status file, go on. A thing that
   needs a real device, a credential or an owner decision goes under NEEDS A HUMAN in your status file; skip to the next item.
2. **Your own worktree.** The portal made one for you on its own branch (`git branch --show-current`, `pwd`). Work only there. Do not edit the main
   folder `~/work/claudepilot` or another session's worktree.
3. **Safety, whatever Bypass lets you do.**
   - Never print, log, commit or paste a credential. No token-shaped literal anywhere in the repo (build fixtures at runtime). Do not read
     `~/.config/gh`, `~/.git-credentials` or `~/.kube/config`, and do not dump Secrets.
   - `kubectl`: read freely. Change things only in a namespace you create for a rig (name starts with `dev-rig-`) and delete it when you are done.
     Never touch `isnan-claudepilot`, `isnan-claudepilot-workspaces` (this workspace hosts every session: stopping, deleting or restarting it, or
     restarting the portal, kills them all), Argo CD, the nodes or any other namespace.
   - Never push `main`. Never start, approve or work around the deploy pipeline: the coordinator and the owner do that. Never change the real
     portal's settings, tokens or Secrets. For anything that needs a portal, run a scratch one: `scripts/scratch-portal.sh` (clean environment).
   - Never force-push, rewrite pushed history, use `--no-verify` or amend a pushed commit.
4. **Heavy jobs one at a time, across all sessions** (the pod has 4 CPUs and 8 GiB): typecheck, the server suite, a production build, `gate.sh` and
   Chromium runs go through `flock /tmp/heavy.lock nice -n 10 <command>`. Targeted tests (one file) run directly. One scratch portal and one
   Chromium per session at most; stop them when you are done. A fresh worktree has no `node_modules`: run `flock /tmp/heavy.lock npm ci` once
   (`NODE_AUTH_TOKEN` is set in your shell; the private `@isnanme/ui` package needs it). Keep `/tmp` clean (`/tmp/gate-*`, `/tmp/cp-*`): a full `/tmp` makes CI tests fail.
5. **Do not loop.** The same command failing three times means change the approach or move to the next item and write down why.
6. **Quota.** The portal moves your chat to another Claude by itself when one runs out. If a turn fails with a limit error, wait a few minutes and carry on.

## The cycle

1. Read your track file, the PRD sections and the earlier status it names (`docs/coord/` holds the previous rounds' prompts, status and plans;
   COORD there means `docs/coord`). Check what is already on `origin/integration` before you start an item.
2. Take one small slice. Test first. Look at UI in a real browser (`tools/qa/*.mjs`, Chromium, 390 px first).
3. Commit after every verified slice: unsigned (`git -c commit.gpgsign=false`), a message that says what and why, ending with
   `Co-Authored-By: Claude <noreply@anthropic.com>`. Push your branch: `git push -u origin <branch>`.
4. **Integrate** when a slice is verified (not later than every few hours of work):
   ```sh
   git fetch origin && git rebase origin/integration          # resolve conflicts; never throw away somebody else's lines
   flock /tmp/heavy.lock nice -n 10 scripts/gate.sh           # clean-copy gate on HEAD; every step rc=0 and "# fail 0" in /tmp/gate-<sha>.logs
   git push origin HEAD:integration                           # fast-forward only
   ```
   If the push is refused, `git fetch`, rebase again and re-run the typecheck and the tests of what you touched (the whole gate again when the
   other change touched the same area). Then `rm -rf /tmp/gate-<sha>*`.
5. Update your status file (below) in the same commit.

## Migrations

Append only, by version number. Your block: track A 710-719, track B 720-729, track C 730-739. Never edit a released migration (everything
up to 610 is released or committed). Parked on the WIP branch and NOT to be merged: 400-401 (multi-user identity).

## Status and final report

`docs/dev-sessions/status/<track>.md`, at most 60 lines, overwritten, committed with your work: DONE (item and commit), DECISIONS, NEEDS A
HUMAN, NEXT (where to resume). Another session, or you after a restart, continues from it. When your track list is empty, make the last commit
and end with a report of at most 25 lines: what you built, what you verified and how, what is not done and why.

## The coordinator

Watches with the Portal MCP (sessions, usage) and `git log origin/integration`, runs the deploy pipeline when the owner approves, and
consolidates `docs/open-items.md`. Anything for the coordinator goes in your status file under NEEDS A HUMAN.
