# Example: one slice, start to finish

An example with placeholder values. Your project's base branch, remotes and labels are in its own docs (CLAUDE.md, the dev-sessions README). `<worktrees>` is the folder beside the repository named `<repository>.worktrees`.

## Commands

```sh
# start
git fetch origin
git worktree add <worktrees>/t42-export -b ticket/T-42-export-csv origin/integration
cd <worktrees>/t42-export
# install dependencies under the project's heavy-job rule

# work, then commit (trailers as their own last paragraph)
git add src/export/csv.ts src/export/csv.test.ts
git commit -m "Export the run list as CSV" \
  -m "People asked to open run history in a spreadsheet. Adds a CSV writer with quoting for commas, quotes and newlines; the export button calls it. Checked: typecheck and src/export tests." \
  -m "Ticket: T-42
Pilot-Session: <session id>
Pilot-Agent: t42-export
Co-Authored-By: <the line your harness gives>"

# push early, keep pushing
git push -u origin ticket/T-42-export-csv

# heavy checks on the cluster see only what is pushed
git push origin HEAD:wip/t42-export

# base moved on and the branch is already pushed: merge, do not rebase
git fetch origin
git merge origin/integration
git push

# after the integrator merged it
cd -
git worktree remove <worktrees>/t42-export
git branch -d ticket/T-42-export-csv
```

## A good commit message

```
Export the run list as CSV

People asked to open run history in a spreadsheet. Adds a CSV writer
with quoting for commas, quotes and newlines; the export button calls
it. Checked: typecheck and the export tests (12 pass).

Ticket: T-42
Pilot-Session: <session id>
Pilot-Agent: t42-export
Co-Authored-By: <the line your harness gives>
```

## Notes from the first program that used this flow

- Commits there are unsigned in the workspace (`git -c commit.gpgsign=false commit ...`), because the workspace has no signing key.
- Older branches in that repository are named `dev/<name>` and `wip/<name>`. New units use `ticket/T-<n>-<slug>`; `wip/<name>` stays for refs pushed only so a remote Job can clone them.
- The project's `.claude/settings.json` denies every force-push form, `--atomic`, `--mirror`, `--delete`, any push to `main`, `git reset --hard` and `git clean`, even in Bypass. The deny list is the floor, not the whole rule: what it does not list is not thereby allowed.
