# COMMIT AND DEPLOY CYCLE (standing instruction from the owner, 2026-10-12, translated; the COORDINATOR is the orchestrator: agents NEVER commit or deploy)

## 1. Hard rules
- NEVER force-push, rewrite history, `--no-verify`, or amend a commit that was already pushed. NEVER touch .data, .env, deploy/.env, references/. NEVER print a secret.
- Commits are UNSIGNED (no GPG secret key in this container): `git commit --no-gpg-sign`; say so in the report. End every commit message with the trailer the system gives: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- NO token-shaped literal may enter the repo (GitHub push protection): fixtures build tokens at runtime (e.g. 'glpat' + '-...').
- Not the owner's: root Dockerfile, .dockerignore, deploy/ (the deployment files are the owner's; I only RUN the deploy, I do not edit them without being asked).

## 2. Checkpoint commits (branch `integration`; main only through releases)
- Trigger: every ~45 minutes (a recurring cron job wakes me) OR when an agent reports done. SKIP when nothing changed, or when the owning agent of an area is still mid-edit (files of the area modified in the last 3 minutes, or its status says mid-change).
- Procedure: (1) inspect `git status`, the agents' status/RESUME HERE files (COORD/status-*.md) and recently modified files; (2) GATE: root `npm run typecheck` clean (run with `nice`, `NODE_OPTIONS=--max-old-space-size=2048`, output to a file, never two at once) and the targeted tests of the committed areas pass (node --test per module glob); if it fails, DO NOT commit: write the failure to the owning agent's inbox (COORD/inbox-<id>.md) and retry next cycle; (3) stage PER OWNERSHIP PATH (explicit path lists, NEVER `git add -A` or `git add .`; skip junk, logs, generated scratch); (4) scan the staged diff for secrets with COORD/diff-scan.mts (uses chat/redact.ts; prints file:line only): any finding blocks the commit; (5) commit message: area + one-line summary + a short body of what is in it; (6) push to `origin integration` (a normal push; never force).
- Commit groups (in this order; shared files such as apps/server/src/{index,app,config,live}.ts, store/migrations.ts, packages/contracts/src/index.ts go with the LATEST group that needs them, or in a final "wiring" commit): docs (PRDs and plans), contracts, server modules by directory, web features by directory, images and scripts, wiring. A checkpoint is a SNAPSHOT: intermediate commits of one checkpoint need not typecheck alone; the gate applies to the checkpoint's final state.
- Ledger: append one line per checkpoint to COORD/commit-ledger.md (time, commit shas, areas, gate results, anything skipped and why).

## 3. Release gate (on a CLEAN COPY of the commit, not the working tree)
- Run in a quiet window (no agent building, testing or measuring): `git archive <sha>` into /tmp/release-<sha>, `npm ci` (NODE_AUTH_TOKEN from `gh auth token`, never printed), root `npm run typecheck`, the full server suite, `npm run build -w @portal/web`, the boot test (apps/server/src/qa/boot.test.ts), the migration tests against old databases (apps/server/src/qa/migrations.test.ts and the old-main frozen-DB checks), the related security tests. ALL green.
- No agent may be editing migrations or have unfinished changes in the release. 
- A release that changes auth/login (the multi-user release), rewrites data in the schema, or REMOVES a feature REQUIRES the owner's EXPLICIT APPROVAL before deploy: never deploy the first multi-user release unless the owner holds the setup token and has said go. The FIRST deploy of any kind also waits for approval.

## 4. Deploy (only from a TAGGED release commit, only after the gate)
- Build the image from a clean checkout (`docker --context host build ...` as the earlier deploy: deploy/compose.yaml, `NODE_AUTH_TOKEN=$(gh auth token)` never printed); tag by sha and keep the tag `previous` (the running image).
- BEFORE deploying: back up the portal DATA VOLUME; rehearse the migration on a COPY of that backup (never the real DB); abort if it fails.
- Deploy through `docker --context host` and compose; wait for healthy; READ-ONLY smoke test (login page 200, /healthz, a small flow that changes no data). On failure: automatic rollback to `previous`; if a migration already ran, restore from the backup. Report.
- Record every deploy in COORD/deploy-ledger.md (commit, image, time, result, how to roll back).

## 5. Schedule and limits
- Checkpoints are automatic. Deploys are automatic AT MOST once a day and only when the gate is green; the first deploy and every risky release wait for the owner. A gate that fails repeatedly: STOP and escalate to the owner; no unbounded retries.

## 6. Per-cycle report (Indonesian, short): what was committed per area, the gate results, the deploy state and the rollback method, and what needs the owner's decision.

## 7. Load note: run the gate commands under `flock COORD/heavy.lock nice -n 10` too (the same lock the agents use) so a checkpoint never competes with itself.

## 8. Case-insensitive filesystem check (the repo lives on a macOS mount; U2 found two files differing only by case made tsc resolve the wrong one): at EVERY checkpoint, before staging, run `git ls-files -c -o --exclude-standard | tr 'A-Z' 'a-z' | sort | uniq -d` (tracked + untracked, lower-cased): any output BLOCKS the commit (tell the owning agent which two names clash). Also never commit two paths that differ only by case.

## 9. TOOLS FOR THE CHECKPOINT CYCLE (added 2026-10-12 after checkpoint #1; use these, they encode sections 2 and 7 and 8)
- `COORD/gate.sh` = the typecheck gate (root `npm run typecheck` under heavy.lock, nice, 2 GB heap); result in `COORD/gate-typecheck.log` (first line `gate finished at ..: exit=N`, then `errors: N` and counts per file); the full output is in `gate-typecheck.full`. Run it in the background and wait for it (about 25 s when the tsc cache is warm, 4+ min cold). Gate red = do not commit; tell the owning agents (SendMessage) and retry.
- `COORD/commit-cycle.sh [--dry]` = stage per ownership group (explicit paths, never `git add -A`), skip every file modified in the last 3 minutes (owner mid-edit), run the secret scan on each staged group, HOLD BACK only the flagged files (listed in `COORD/held-back.txt`; the owners are told to build such fixtures at runtime), commit unsigned with the Co-Authored-By trailer, retry on a transient index.lock. Then `git push origin integration` (normal push). Afterwards append the ledger line to commit-ledger.md.
- `COORD/scan-show.mts FILE...` prints flagged lines redacted (first 5 chars + length of the matched span) so an owner can fix them without the value being echoed; `COORD/split-literals.py FILE...` splits provider-shaped literals with `' + '` mechanically (the runtime value stays identical) for files whose owner is finished; always run the file's tests afterwards.
- New files that belong to no group in commit-cycle.sh stay unstaged and are listed at the end of the run ("unstaged leftovers"): add a group for them (do not widen an existing one blindly).
- Checkpoint #1 (2026-10-12 06:55Z): 23 commits on origin/integration; the glance web files rode along in the `web/usage` commit because of an index.lock race (labels only; no rewrite).
