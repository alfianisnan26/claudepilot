# Placeholders of the project scaffold

Every `{{NAME}}` the scaffold uses, with its meaning and an example. Fill all of them before you copy the scaffold
(`bootstrap.md`, step 2). This file, `bootstrap.md` and `first-tickets.json` stay in the kit.

## How to substitute

- Replace only `{{` + an upper-case name + `}}`. Leave `${{ ... }}` alone: it is a pipeline expression in
  `.pilot/*.yml`. `{{secret-file:NAME}}` in an MCP set is the portal's own syntax, not a placeholder.
- Values are inserted as they are. In `.claude/settings.json` and `first-tickets.json` a value must not contain
  `"` or `\`. In a settings rule, a command placeholder must be a plain command prefix (no `&&`, `|` or `;`), or the
  rule never matches.
- In `.pilot/*.yml` the commands sit inside `run: |` blocks, so any shell line works there. In `.pilot/gate.yml`
  `{{TEST_QUICK}}`, `{{TEST_FULL}}` and `{{BUILD_CHECK}}` are the Job's command, inside single quotes: no `'` in them.
- After substituting: `grep -rnE '\{\{[A-Z_]+\}\}' .` prints nothing.
- `<angle brackets>` in `docs/prd/_template.md` and `docs/dev-sessions/status/_template.md` are filled each time
  those templates are used, not now.

## The list

| Placeholder | Meaning | Example | Used in |
| --- | --- | --- | --- |
| `{{PROJECT}}` | The project's short name: lower case, digits and `-` (it is part of a concurrency group and a folder). | `acme-shop` | CLAUDE.md, docs/README, dev-sessions README, orchestrator, design README, .pilot/gate, .pilot/deploy, first-tickets, bootstrap |
| `{{PROJECT_SUMMARY}}` | What the project is and for whom, two or three sentences. | `A small web shop for Acme's spare parts. Customers search, order and pay; staff ship from a phone.` | CLAUDE.md, first-tickets |
| `{{STACK}}` | Languages, frameworks, database, where it runs. | `TypeScript on Node 22, Hono, SQLite; React and Vite on the web` | CLAUDE.md, first-tickets |
| `{{OWNER}}` | The person who owns the decisions and the approvals. | `Dana Owner` | CLAUDE.md, first-tickets |
| `{{DATE}}` | The date the project is created, `YYYY-MM-DD`. | `2026-10-14` | DECISIONS |
| `{{DEFAULT_BRANCH}}` | The protected release branch: it changes only through the deploy pipeline. | `main` | CLAUDE.md, dev-sessions README, orchestrator, settings.json, bootstrap |
| `{{INTEGRATION_BRANCH}}` | The branch where work is integrated; the orchestrator alone pushes it. | `integration` | CLAUDE.md, dev-sessions README, orchestrator, settings.json, .pilot/gate, .pilot/README, first-tickets, bootstrap |
| `{{PROJECT_DIR}}` | The project folder in the workspace; worktrees go in the sibling `<folder>.worktrees/`. | `~/work/acme-shop` | dev-sessions README, bootstrap |
| `{{MAP_ROWS}}` | Markdown table rows for the folder map, one per folder, in the same two-column shape as the rows under the slot in `CLAUDE.md.tmpl`. At least one. | a row for `apps/api`: "the HTTP server" | CLAUDE.md |
| `{{INSTALL}}` | The command that installs dependencies. | `npm ci` | CLAUDE.md, settings.json |
| `{{TEST_QUICK}}` | The quick gate: the checks for what changed, in minutes, before every push of the integration branch. | `scripts/gate-quick.sh` | CLAUDE.md, dev-sessions README, orchestrator, settings.json, .pilot/gate, .pilot/README, first-tickets |
| `{{TEST_FULL}}` | The full gate on a clean copy of a commit, before every deploy. | `scripts/gate.sh` | CLAUDE.md, dev-sessions README, settings.json, .pilot/gate, .pilot/deploy, .pilot/README, first-tickets |
| `{{JOB_RUN}}` | The job-run command with its repository: the gate's lanes run as cluster Jobs through it (T-491). The repository name is one job-run accepts (`claudepilot`, `event`, `konfersi:<org>/<repo>`); a new one is a change to `scripts/job-run.sh` by a ticket. | `~/work/claudepilot/scripts/job-run.sh --repo event` | .pilot/gate |
| `{{BUILD_CHECK}}` | The production build the full gate runs after `{{TEST_FULL}}`, inside the same Job (`true` when `{{TEST_FULL}}` builds already). | `npm run build` | .pilot/gate |
| `{{APP_NAMESPACE}}` | The cluster namespace that runs the product. No cluster: a name that exists nowhere. | `acme-shop` (or `none-app`) | settings.json |
| `{{WORKSPACE_NAMESPACE}}` | The namespace of the agents' own workspaces. | `pilot-workspaces` (or `none-ws`) | settings.json |
| `{{GITOPS_NAMESPACE}}` | The namespace of the GitOps controller that deploys. | `argocd` (or `none-gitops`) | settings.json |
| `{{CI_REMOTE}}` | The CI remote's name in the portal (CI > Remotes). | `acme-shop` | .pilot/deploy, bootstrap |
| `{{DEPLOY_ENV}}` | The environment the deploy pipeline releases to (lower case, digits, `.`, `_`, `-`; at most 40). Start with stg. | `stg` | .pilot/deploy |
| `{{IMAGES}}` | The default of the deploy pipeline's `images` input: what to build, comma separated, or `none`. | `app` | .pilot/deploy |
| `{{BUILD_CMD}}` | The build job's command; leaves `.pilot/out/build.env`. | `bash .pilot/scripts/build.sh` | .pilot/deploy |
| `{{RELEASE_CMD}}` | The release job's command; leaves `.pilot/out/release.env`. | `bash .pilot/scripts/release.sh` | .pilot/deploy |
| `{{VERIFY_CMD}}` | The verify job's command. | `bash .pilot/scripts/verify.sh` | .pilot/deploy |
| `{{ROLLBACK_CMD}}` | The rollback job's command. | `bash .pilot/scripts/rollback.sh` | .pilot/deploy |
| `{{DESIGN_STANDARD}}` | Where the design standard lives, or `No user interface`. | `docs/design/DESIGN-STANDARD.md (to be written)` | design README |
| `{{FIRST_SLICE}}` | The first product slice, a few words (the summary must stay under 140 characters). | `a visitor searches parts by name` | first-tickets, bootstrap |
