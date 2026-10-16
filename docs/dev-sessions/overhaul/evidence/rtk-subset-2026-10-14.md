# RTK step 2: a safe subset (T-306 items 1 and 2), 2026-10-14

Status: **prepared, NOT installed.** Nothing in `.claude/settings.json` or any policy changed. Delivery (item 4) needs the owner's approval;
the proposed diff is at the end. The saving is not measured here (item 3, the lab A/B): byte ratios below are output sizes, not tokens per thread.

Binary: rtk v1.0.0, the same verified asset as step 1 (`rtk-offline-2026-10-14.md`): `tools/qa/rtk-classes.sh` downloads it in the Job and
checks sha256 `b0b69fbe…0926` before the first run. rtk is not installed in the dev pod; every number comes from cluster Jobs.

Source of every number: Job **claudepilot-job-5f80192c** (commit 41453b7, node k3s-master), command
`scripts/job-run.sh --ref dev/t-306-1 --artifacts job-out -- 'bash tools/qa/rtk-classes.sh job-out; node tools/qa/rtk-deny-parity.mjs .claude/settings.json --hook tools/rtk/hook.mjs --json; … rtkHook.test.ts; tsc'`.
Its files (not committed, in the worktree's `job-run-artifacts/run4/job-out/`): `cases.tsv` (bytes, exits, the rtk form), `fidelity.tsv`
(per case), `classes.tsv` (per class), `<case>.{plain,rtk}.txt`, `<case>.fid.json` (every missing fact), `parity-hook.json`, `test.txt`, `tsc.txt`.
The earlier Job claudepilot-job-e55138c8 (5383b1c) gave the same verdicts.

## Method (item 1)

`tools/qa/rtk-classes.sh` runs each command plain and in the form `rtk rewrite` proposes, in one clean environment (env -i, empty HOME, no
token, telemetry off), on the repo with 10 scratch commits (subject, body line, `Ticket:` trailer) and a dirty tree (30 modified, 1 staged
delete, 1 staged add, untracked). `tools/qa/rtk-fidelity.mjs --class <class>` parses the facts from the PLAIN output in its known format and
looks each up in the rtk output whatever its layout: git status path+state (staged/worktree/untracked) and branch; git log 7-char hash,
subject, author name, every message line, stat lines; diff --stat "path | N" and the totals; paths; path:line and the matched text; names and
folder-ness for ls. Not scored on purpose: ls owner, group, date and exact size (rtk rounds), git log date and e-mail. A class is KEPT when
every case of it is at 95 percent or more.

## Fidelity per class (`classes.tsv`, `fidelity.tsv`, `cases.tsv` of Job claudepilot-job-5f80192c)

| class | cases (min parity) | facts / missing | bytes plain → rtk per case | verdict | on the allowlist |
| --- | --- | --- | --- | --- | --- |
| git-status | `git status` 100, `-s` 100, `--short --branch` 100 | 108 / 0 | 2142→1504, 1472→1471, 1492→1491 | KEEP | `git status [--] [paths]`, no other flag (T-341: 13 more cases) |
| git-log | `--oneline -20` 100, `-5` 100, `--stat -3` 100 | 61 / 0 | 602→602, 1432→833, 1097→1097 | **DROP (T-341: scratch bodies were 3 lines; real ones lose trailers, 62.5 percent)** | no (was `git log [-N \| --max-count=N] [refs/paths]`) |
| git-diff-stat | `--stat HEAD~10`, `--stat`, `--cached --stat`: 100 | 82 / 0 | byte-identical (2512, 1716, 166) | KEEP | no: no saving |
| git-diff-names | `--name-only`, `--name-status`: 100 | 84 / 0 | byte-identical (1673, 1757) | KEEP | no: no saving |
| grep-list | `grep -rl` ×2, `rg -l` ×2: 100 | 411 / 0 | 1609→933, 4772→3975, 1609→933, 4655→3873 | KEEP | `grep -rl` (letters r R i l), `rg -l` / `--files-with-matches` |
| grep-count | `grep -rc` 100, `rg --count` 100 | 154 / 0 | byte-identical (4366, 1702) | KEEP | no: no saving |
| ls | `ls` 93.8, `-la` 100, `-la chat/` 59.5, `-1` 100, `-lh` 100, `-la docs/coord` 22.2 | 430 / 210 | 158→245 … 12507→1221 | **DROP** | no |
| find | `-name` 86.2, `-type f` 11.9, `-type d` 97 | 511 / 379 | 2324→945, 11531→819, 913→264 | **DROP** | no |
| grep-lines | `grep -rn` 72.7, small 100, one file 100, `rg -n` 72.7 | 719 / 194 | 25785→20568 (large), others identical | **DROP** | no |
| tree | not installed in the image (plain exit 127) | – | – | NOT SCORED | no |
| npm-ls | rtk does not rewrite it (`rtk rewrite` exit 1) | – | – | NOT APPLICABLE | no |

Why the drops: `rtk ls` lists 50 entries then `... (175 more)` and `rtk recall <hash>`; plain `rtk ls` also leaves out `node_modules`.
`rtk find` prints a few folders and hides the rest (`+365 more`, `rtk recall`). `rtk grep -n` cuts long lines (`...son(` prefix) and leaves
out matches (97 of 355 facts on a 207-match search; the missing ones are in `grep.rn.fid.json`). A command whose class is KEPT but rtk prints
byte for byte is left off the allowlist: rewriting it would only add rtk's start-up (about 30 ms, step 1).

Never rewritten, whatever the numbers: test runners, builds, typecheck, kubectl, cat/sed/head of files, git push and every other write, and
any command a deny rule names (unit tests in `apps/server/src/qa/rtkHook.test.ts` cover each).

## The hook (item 2): `tools/rtk/hook.mjs`

PreToolUse on Bash. Rewrites to `rtk <command>` only when, in order: rtk is on PATH; the command has no shell syntax at all (`; & | `` ` `` $ ( ) < > \ { } # !`
or a line break, even inside quotes); no Bash deny rule matches it (rules read at run time from the project's `.claude/settings.json`,
required, plus `settings.local.json`, `~/.claude/settings.json`, `/etc/claude-code/managed-settings.json`; a missing project file or any
broken file means no rewrite at all); it is on the allowlist above with only the measured flags; and the rewritten form matches no deny rule
either. It never sets a permission decision. Any error: no output, the command runs as typed.

Compound commands (`&&`, `;`, `|`, subshells) are **simply untouched, even when every part is allowlisted**: rewriting one part of a pipe
changes what the next part parses (`git status | grep modified` would read rtk's short form), and a shell parser inside a hook is exactly
where a deny bypass hides. Untouched is always safe; it only costs bytes.

## Deny parity against the hook (`parity-hook.json`)

`node tools/qa/rtk-deny-parity.mjs .claude/settings.json --hook tools/rtk/hook.mjs`: 77 rules, 70 Bash rules, 7 Read rules (a Bash hook never
touches the Read tool). 90 samples: one per Bash rule, plus, for wildcard rules, the sample with an allowlisted command in front where it
still matches (e.g. `git status /proc/x/environx`, `grep -rl x /proc/x/environx`). The probe (`git status`, named by no rule) was rewritten to
`rtk git status`, so the hook was live. Result: **unchanged 90, rewritten 0, bypassed 0, hook errors 0, sanity failures 0.** Step 1's blanket
rewrite bypassed 28 of 70.

Tests: `apps/server/src/qa/rtkHook.test.ts`, 12 of 12 pass (`test.txt`); `npx tsc --noEmit -p apps/server` clean (`tsc.txt`), same Job.

## T-341: the fidelity gaps (A to D), 2026-10-15

Script: `tools/qa/rtk-history.sh` (same method and the same checksummed rtk v1.0.0). Source of every number below: Job
**claudepilot-job-e9baa000** (commit 63119f0b94e0, rc 0, 12 s run; files `cases.tsv`, `fidelity.tsv`, `classes.tsv`, `<case>.fid.json`,
`history.txt`, `busy-count.txt` in the worktree's `job-out/t341/job-out/`, not committed). **This supersedes the git log and git status
rows of the table above.**

**A. Sample.** Busy worktree: done. The real repository tree with 205 changed paths (`git ls-files -m -d -o` counts 205, `git status -s` shows 161
lines; built by the script: 60 modified, 40 staged, 15 deleted, 3 renamed, 40 untracked in nested folders, a folder with a space in its name). `git status` ×13 cases (long, `-s`, `-sb`,
paths: one folder, two folders, a file, `--` form, a new folder, `.env`, a missing folder): 747 facts, 1 missing, min 99.4 percent: KEEP.
The one miss is cosmetic: rtk prints `?? "rtkh-new/with space/"` (quoted), the path is there. Bytes plain→rtk: `git status` 7685→6242 (19
percent), `-s` 6215→6214, a folder 3650→3462, `docs` 836→632, `--` form 407→353, a file 63→62. **Real history: NOT done.** The Job's clone
is depth 1 and has no `origin` (`fatal: 'origin' does not appear to be a git repository`), so `git log` ran on one real commit (a 7-line
body with trailers); merges, many authors and long histories are not sampled (a bundle would have to be shipped into the Job). It did not
change the answer: see git log below.

**B. Dates and e-mail.** Scored now (classes `git-log-meta`, `ls-meta`). git log (15 cases of class `git-log-meta`): e-mail and `Date:` line 0 percent in
8 cases (2 facts each, both missing), 100 percent in 1 (`--stat`, 2 facts found), and **no facts to score in 6** (`--oneline`, `--max-count=N --oneline`,
refs, `--merges`: the plain output has no date or e-mail). Class totals: 18 facts, 16 missing. Where rtk prints the commit it gives `(20 minutes ago)` and
`<name>`, no e-mail, no absolute date. ls (`-la`, `-lh`, folders; class `ls-meta`, 3 cases, 136 facts, 130 missing): owner+group, exact size and
date 25.0, 0 and 0 percent per case (rtk prints mode, name, a rounded size). The 25.0 is the root listing (24 facts, 18 missing) and depends on
what the clone holds; an earlier rerun (QA, claudepilot-job-4d747bcd) gave 26.1. Source of these figures: Job **claudepilot-job-640d3a6f**
(commit e428431, rc 0, `classes.tsv`, `fidelity.tsv`). Verdict: **not dropped silently, dropped on purpose and stated**: an agent
that needs who wrote a commit or when (blame, "what changed since Tuesday", release notes) needs them; rtk loses them. The git log
class is therefore removed from the allowlist (next paragraph). ls is already off the allowlist, so its meta loss costs nothing.

**C. Allowlist narrowed to the measured forms** (hook and tests changed, not the settings). `git log` in EVERY form is now off the allowlist:
`git log -5`, `--max-count=10`, `-5 -- <path>`, `<path>/`, `--no-merges`, `--since` all scored 62.5 percent (8 facts, 3 missing: rtk keeps three
body lines and prints `[+2 lines omitted]`, so the trailers `Ticket:`, `Pilot-Session:` go); `--oneline` and `--stat` are byte for byte
(no saving). The earlier 100 percent was an artefact of scratch commits whose bodies had three lines. A ref operand (`HEAD~50`) failed in
both arms (shallow clone), so refs were not measured. `git status` is allowed as exactly: no flag, one optional `--`, then operands
(measured). `git status -s/-sb` and any other flag: untouched. grep-list was measured earlier (4 cases, not extended here).

**Operands are not checked.** `git status .env` is rewritten to `rtk git status .env` (measured: output 62 bytes, branch line only). This is
not a bypass: `git status <path>` prints names and states, never file contents; the deny rules still run on the original and the rewritten
command inside the hook (a rule naming the operand wins: `git status /proc/x/environ` is untouched), and the rewritten command goes through
Claude Code's own permission check again (see D, not verified).

**D. Does Claude Code apply `updatedInput` and still check allow/deny on the rewritten command? NOT VERIFIED.** It needs a real Claude Code
session against the model API (a credential), which a Job must not hold. Probe for a person or the coordinator, in a scratch session
(`scripts/scratch-portal.sh`, a throwaway project, never this repository): 1. register the hook (the settings diff below) in that project and put
`Bash(rtk git status)` in `allow` and `Bash(rtk git status .env)` in `deny`; 2. ask the model to run `git status`: expect the transcript
to show `rtk git status` run with no prompt; 3. ask for `git status .env`: expect a refusal naming the DENY rule (proves the deny check runs on
the rewritten command; an executed command means it does not); 4. remove the allow rule and run `git status` under dontAsk: expect a refusal
(proves the allow check runs on the rewritten command); 5. with `RTK_HOOK_DEBUG=1` read the hook's stderr line to see the decision.

Tests: `apps/server/src/qa/rtkHook.test.ts` (13 tests) in a Job; result in the ticket comment.

## Open before delivery (item 4, the owner decides)

1. Installing the rtk binary on PATH lets an agent TYPE `rtk git push --force …` and get past the anchored deny rules (step 1: 28 rules,
   3 not refused by rtk itself). The hook does not cause this, but delivery must close it: either mirror the dangerous deny rules as
   `Bash(rtk <rule>)`, or extend the hook to deny a typed `rtk <cmd>` whose `<cmd>` a deny rule names (a permission decision: needs approval).
2. (T-341 D, probe steps above, not verified) Confirm in a scratch session that Claude Code applies `updatedInput` without a permission decision and still checks the rewritten command
   against allow and deny rules.
3. Item 3: the lab A/B (arm rtk-subset against control). On these outputs the saving is small: only `git status` and `grep -rl` / `rg -l` listings shrink
   (bytes: 19 percent for `git status` on the busy tree, 17 to 42 for the grep listings; `git log` is refused by the hook and no longer counts); the honest
   outcome may be "not worth it".

## Proposed settings diff (NOT applied)

```diff
--- a/.claude/settings.json
+++ b/.claude/settings.json
@@ "permissions": { "allow": [
       "Bash(git log:*)",
+      "Bash(rtk git status)",
+      "Bash(rtk git status:*)",
@@ (top level, after "permissions")
+  "hooks": {
+    "PreToolUse": [
+      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/tools/rtk/hook.mjs", "timeout": 5 } ] }
+    ]
+  }
```

No allow rule for `rtk grep` / `rtk rg`: plain grep and rg are not on the allow list either, so they keep asking (refused in dontAsk) as today.
Plus whatever closes open item 1, and rtk v1.0.0 (verified checksum) on the workspace image's PATH with `RTK_TELEMETRY_DISABLED=1`.
