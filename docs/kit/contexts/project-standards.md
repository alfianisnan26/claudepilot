# Project standards

The project's own engineering rules: stack, commands, definition of done, quality bars and conventions.

This is a template. Each section has a `FILL` slot for the project. A line marked *Example* is not a rule until the project replaces it. While a section is unfilled, follow the charter and the standing decisions, and work the ticket that fills it before product work.

## Language and stack

<!-- FILL: languages and versions, frameworks, database, package manager, the runtime the project ships to. -->

*Example:* TypeScript on Node 22; HTTP server with a small framework; SQLite; React and Vite on the web; one package for shared wire types.

## Commands

<!-- FILL: the exact commands. Name which ones are heavy and where heavy jobs run. -->

| Job | Command |
| --- | --- |
| One test file | *Example:* `npm test -- path/to/file.test.ts` |
| Quick gate (before each merge to the integration branch) | *Example:* `scripts/gate-quick.sh`: typecheck plus the tests of the touched areas |
| Full gate (before every deploy, on the exact commit) | *Example:* `scripts/gate.sh`: typecheck, production build, the whole suite on a clean copy |
| Heavy job (suite, build, browser run) | *Example:* `scripts/job-run.sh -- <command>` as a cluster Job, or one at a time under `flock /tmp/heavy.lock nice -n 10` |

- A sub-agent runs only its own tests and typecheck; the gates are the orchestrator's.
- A test on the real clock never depends on a fixed date.

## Definition of done

<!-- FILL: adjust to the project; keep every line checkable. -->

A unit is done only when all of these hold, each with a link someone else can open:

- **Tests:** new behaviour has a test; a bug fix has the test that fails without it.
- **Gate:** the quick gate is green on the merged commit; the full gate is green before a deploy.
- **Docs:** the PRD section is updated for any behaviour change, written as observed, not hoped.
- **Review:** a different role verified the work with evidence; the author did not close its own ticket.
- **Evidence:** the ticket's closing summary links the gate result, the tests run with their output, and screenshots for UI.
- **Traceability:** the ticket, the commit trailers, and the decision on the record.

## UI quality bar

<!-- FILL: the design standard's location, or "no UI". Do not copy another project's standard. -->

The design standard lives at: *Example:* `docs/design/` (tokens, components, a living gallery).

*Example bar:* phone width (390 px) first, then desktop (1280 px); light and dark; 44 px touch targets; no horizontal scroll; keyboard and touch; titles of one or two words; every number shown has a source, and "unavailable" is a state, never a guess. Screenshots are looked at, not only taken.

## Performance budgets

<!-- FILL: budgets as numbers, and the test or check that enforces each. A budget without a check is a wish. -->

*Example:* API p95 under 40 ms on the seeded data set; response under 30 KB gzipped; no synchronous work that blocks the event loop over 50 ms; first page load under 2 s on a throttled phone profile.

## Security rules for this project

<!-- FILL: rules beyond the context safety-rules. -->

*Example:*
- Every route and tool goes through the authorization check; a denial looks the same as "not found".
- Outbound calls go through the SSRF guard.
- No token-shaped literal anywhere in the repository; test fixtures build such values at runtime.
- Logs, responses, audit rows and transcripts pass through the redactor.

## Naming and layout

<!-- FILL: folders, module boundaries, file and identifier naming, migrations, branch and worktree naming. -->

*Example:*
- `apps/<name>` for deployables, `packages/<name>` for shared code, `docs/prd/` one document per area, `scripts/` for every repeatable step.
- Database migrations are append only; a released migration is never edited; number blocks are reserved per area.
- Branches `ticket/T-n-slug`; worktrees in the sibling folder `<project>.worktrees/<slug>`.

## Where the status file lives

<!-- FILL: only if not docs/dev-sessions/status/<role>.md -->
