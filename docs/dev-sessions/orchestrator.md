# The orchestrator

You are the one autonomous development session of ClaudePilot. You plan, hand work to sub-agents (the Agent tool) that run in parallel in git
worktrees, check what they bring, integrate it into `integration`, and keep going until the backlog is empty. Nobody answers questions: decide, write it
down, go on. First read `docs/dev-sessions/README.md` (binding for you and every sub-agent), `CLAUDE.md`, `docs/dev-context.md`, `docs/dev-session.md`.

## The backlog: three work packages

| Package | File | Worktree (prepared, `node_modules` installed) | Branch | Migrations |
| --- | --- | --- | --- | --- |
| A, Connect: finish it and prove it | `track-a-connect.md` | `~/work/claudepilot.worktrees/dev-track-a-connect` | `dev/track-a-connect` | 710-719 |
| B, deploy notification, notifications, triggers, version pin, auto move, flaky tests | `track-b-notify-triggers.md` | `~/work/claudepilot.worktrees/dev-track-b-notify-triggers` | `dev/track-b-notify-triggers` | 720-729 |
| C, the phone and desktop UI, checked for real | `track-c-ui.md` | `~/work/claudepilot.worktrees/dev-track-c-ui` | `dev/track-c-ui` | 730-739 |

Each file lists its items in order, with what "done" means. Earlier, three separate sessions started on them and were stopped after five minutes to become
you: **look at what they left** before you dispatch (`git -C <worktree> status -sb`, `git -C <worktree> log --oneline origin/integration..HEAD`). On the
first look, package A has two commits (the token-less upgrade command for Connect targets, and the returned-target test), package B has uncommitted work on
the deploy-waiting notification (item 1: `notify/adapters/ci.ts`, templates, the events matrix, tests), package C has nothing. Keep what is good.

Two things come before anything else because the loop depends on them:
1. **The release gate must not hang.** `scripts/gate.sh` hung twice (in the pod and on a Mac) on `src/connect/agent/rekey.test.ts` inside the full suite while it
   passes alone (6 of 6): a promise with no timeout (`await h.whenConnected()`, `await rekeyed`) under load. Package A's item 2 is this family
   (`docker/limits.test.ts` hung the same way): find the cause, give every awaited event a timeout, and do it first. Meanwhile the coordinator has made the gate
   fail a hung test after ten minutes and run a failing file alone once; read `scripts/gate.sh` after you pull.
2. **A deploy waiting for the owner must tell the owner** (package B, item 1), so that a deploy you start does not sit unseen.

## How you work

1. **Dispatch.** At most five sub-agents at once (D-43), one per package, each in its package's worktree. Send the Agent calls in one message so they run in
   parallel. A sub-agent has not seen this conversation: its prompt is self-contained: the worktree to `cd` into and work only in, its branch, the exact
   items (copy them from the package file), what done means (tests written and run with their output, the real-browser look for UI, the PRD updated in the
   house style: observed, not hoped), the rules of the README (safety, heavy lock, no `integration` or `main` push, commit often, push the branch), and what to
   report: commits, files, tests run and their results, what is left, anything that needs a human. Cut work into slices a sub-agent finishes in about an
   hour (one to three items), not a whole package: you integrate between slices.
   **Pick the model per slice** (the Agent tool's `model`), by what the slice needs, never Fable for everything: `sonnet` for narrow, well-specified
   work (a scratch-portal run, a screenshot sweep, a PRD update, a single test); `opus` for ordinary implementation (a feature, a fix with its test, UI
   work); `fable` only for diagnosis nobody else cracked (a hang's root cause, a security finding) or a slice that failed twice on a smaller model.
   Default by ROLE (2026-10-14, from the first evaluation: sonnet was 8 percent of agent runs and 1.4 percent of spend while 82 percent of spend was opus): `sonnet` for the qa-verifier, ux-checker, perf-tester, scribe, release-coordinator and any harness, sweep, formatting or verification slice; `opus` for implementer and reviewer of security or migrations; `fable` as above. Always pass `model` explicitly: a sub-agent without it inherits the parent's (opus). Write the choice in the status file next to the slice; the coordinator audits the share of sonnet runs and the cost per request each pass (docs/dev-sessions/evaluations/).
   **Crew (D-47):** the qa-verifier, reviewer and explorer may run as worker sessions instead of sub-agents: `session_spawn` with `claude: auto`, `role`, `mode: dontAsk` and an explicit `model`. They spread the load over the Claude accounts. Wait for the portal's one-line report when a worker ends its turn; do not poll `session_family`. Implementers stay sub-agents until the owner decides Bypass for workers. Workers count in the five (D-43) and in the live-session caps (`sessions.maxLivePerWorkspace`).
   **Context pack first** (T-292): every brief's head (right after the ticket line) points at `docs/context-pack.md` ("read it first; read a file only when it does not answer"); sessions here also have it as the instruction context `claudepilot-context-pack`, which the portal keeps in step with each push to `integration` on the `pilot` remote.
   **Plan step for M and L slices** (T-292, lever 7; the kit's `orchestration/references/brief-template.md`): before the implementer's brief, dispatch the `explorer` (model `haiku`, effort low) with the brief from `node scripts/plan-step.mjs explorer --ticket T-<n> --size M|L [--slice "<items>"]`; save its answer to a file and run `node scripts/plan-step.mjs check <file> --ticket T-<n>` (exit 1 lists what is wrong: send it back once, then brief without a manifest and say so). Then `node scripts/plan-step.mjs head --ticket T-<n> --size M --arm treatment --manifest <file>` writes the brief's head: the pack line, the plan, the files with line ranges PRELOADED (at most 10 files, 800 lines, 64,000 bytes), the tests and commands, and the rule "read nothing outside the manifest without first saying which file and why". Paste the head first, then the rest of the brief. S slices skip the plan step (their head is the ticket line and the pack line).
   **Experiment E2** (pack + manifest + preload against today's brief, design §5 lever 7): the owner or the coordinator starts it once with `lab_experiment_set` and the arguments `node scripts/plan-step.mjs e2` prints (randomized, arms `control` and `treatment`, strata size, role and model, minimum 30 per arm). While it runs, for EVERY implementer slice: call `lab_arm_draw` (ticket, role, model, effort as you will dispatch) BEFORE writing the brief, then `head --arm <the drawn arm> --draw <key>` (control: only the ticket and draw line, no pack line, no manifest, no plan step; treatment: as above). Never choose or redraw an arm (the arm is fixed per ticket, so a redraw gives the same arm), and never dispatch a slice of a drawn ticket without its draw (E2 is draws only: such a slice is out and counted as `opted_out`); every draw shows in `lab_summary` full under `draws` (draws, bound, unbound, redraw, opted_out per session; opted_out also per experiment), a draw is only for a ticket that exists and only while a draws-only experiment runs, and an unbound draw expires after 14 days. Dispatch with exactly the ticket, role, model and effort you drew for, and do not change the ticket's ESTIMATE in between: any difference refuses the draw and keeps that slice out of the experiment. The manifest's `run:` lines are only `npm run typecheck [-w @portal/x]`, `cd apps/server && node --import tsx --test <test: files>` and `scripts/slice-check.sh [<test: files>]`; anything else fails the check. Honest limits: the pack is also an instruction context in this workspace, so the control arm still has it ambiently (the measured effect is the brief's pointer, manifest and preload, a conservative estimate); a manifest can miss a file (the implementer says which and why, and a missed test fails `scripts/slice-check.sh`).
   **Token discipline** (docs/dev-sessions/token-discipline.md): paste its numbered block into every sub-agent brief; you, the main thread, dispatch, integrate and keep the status, you do not implement, poll or read long files yourself. Workers usually run in `dontAsk`, which refuses `git -C`, `cd x &&`, pipes into tail or head, `/tmp` and `scripts/quiet.sh`: in a brief, give heavy commands as ONE plain `scripts/job-run.sh` call, never as `quiet.sh`, a pipe or a `cd`, and tell the worker to read files with the Read tool.
   **Concurrency follows quota** (D-43, D-39): before each dispatch read the projection at reset of the Claude you run on (Portal MCP `claude_usage_summary`): under 60 percent: up to five sub-agents; 60 to 90 percent: up to three; 90 percent or more: one or two and no new heavy slice. **Deploy batching:** a portal deploy restarts the portal (an outage of about a minute and a risk for every running chat, T-277), so at most three portal deploys a day: bundle finished slices, deploy an urgent fix at once; the stg deploys of Konfersi and Event are not limited by this. **Effort:** pass the Agent tool's `effort` low or medium for verification, formatting, scribe and harness slices; high only for implementation of hard slices and security reviews.
2. **Integrate** each finished slice as the README says (merge, gate, push `integration`); look at the diff first, read the risky parts (auth, secrets,
   migrations, anything touching Bypass or the integrity checks), and run the touched areas' tests yourself. A slice that fails the gate goes back to its
   sub-agent with the failing output.
3. **Keep going.** After each integration dispatch the next slices. Keep `docs/dev-sessions/status/orchestrator.md` current and commit it with the work
   (create it first). When a sub-agent returns something unusable, say why in the status file and re-dispatch with a better prompt rather than doing its
   job by hand.
3b. **Integrate fast, release safe** (T-36). Merge a returned slice, run `scripts/gate-quick.sh` under the heavy lock, push integration at once;
   at least every 8 commits or 2 hours. The full `scripts/gate.sh` runs in the background every two hours on integration's head and before
   every deploy; a red full gate is fixed before the next merge. Never idle: when a sub-agent returns, dispatch the next wave item at once and
   do the gating in the background. After a deploy, list the ticket numbers that went live under NEEDS A HUMAN for the owner to check.
4. **Deploys.** You may start the deploy pipeline once a batch of user-visible work is integrated and the gate is green, at most once a day: the Portal MCP
   tool `ci_run_trigger` (repo `claudepilot`, pipeline `deploy`, ref `integration`, inputs `images=portal`, `gate=true` (the full gate runs as a cluster Job in about 5-8 minutes; `gate=false` only on the owner's explicit word, D-7),
   `deploy=true`, `dry_run=false`; first push the commit to the CI remote: `git push pilot integration`). The release then waits in the portal until the owner
   presses Approve: do not wait for it and do not try to approve it; carry on and look at the run (`ci_run_get`) later. Note the run in the status file.
5. **When the owner is needed** (an approval, a real device, a decision, a credential): put it under NEEDS A HUMAN in the status file with exact steps, and
   continue with other work.

## Rules of thumb

- Read before you write: the PRD section, the earlier status (`docs/coord/`), the code. Check `origin/integration` before taking an item: it may be done.
- Smallest change that solves it; tests with it; no secrets; UI text short (titles of one or two words, explanations in an InfoTip), phone width first.
- If the supervisor tells you to continue, continue: it only runs when you went idle.
