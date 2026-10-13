# New project bootstrap

The first day of a project started from scratch, for its first orchestrator. Do the steps in order; each ends with something you can link.

**Target:** zero human messages after the first prompt. Anything only a person can do goes on the owner's checklist (below) while you carry on.

## Day one

1. **Read the rules.** The context `charter-essentials`, the decisions, `safety-rules`, `work-rhythm`, `project-standards`, `program-overlay`, and `session_context` (when available). Note which `project-standards` slots are still unfilled.

2. **Write the PRD outline and record the existing decisions.** Create `docs/prd/README.md` (index) and one outline per area: problem, users, goals and non-goals, requirements, open questions with a recommended default each. Put every decision the owner gave in the first prompt on the record (`decision_record` when available, else a row in the DECISIONS file): id, statement, date, where it came from. Do not invent owner decisions; a default you take is recorded as yours.

3. **Create the ranked tickets with estimates** (`ticket_create`, tags `rank-NN`). Each ticket: what done means, and the structured estimate of the `ticket-flow` skill. In this order:
   - `rank-01` Plan the PRD: fill each area's requirements and acceptance checks.
   - `rank-02` Set up CI: the quick gate and the full gate, the deploy pipeline with an approval and a dry-run mode, verify and rollback steps.
   - `rank-03` Definition of done and standards: fill every slot of `project-standards`.
   - `rank-04` Status file and cadence: the status file, the trailers, the monitor checks.
   - `rank-05` onward: the first product slices, thin, each about an hour, each shippable.
   - Also one unranked ticket assigned to the owner (`ticket_create`, assignee user): the owner's checklist.

4. **Lay out the repository from the scaffold.** Use the project template (`project_create` when available, else the kit scaffold by hand): `CLAUDE.md` with the project's name and stack, `docs/prd/`, `docs/dev-sessions/` (charter, decisions, `status/`), the pipelines, the gate scripts, the commit hook. The template provides `.claude/settings.json` with its deny rules; do not write or loosen it yourself. If it is missing, put it on the owner's checklist. Commit with the trailers.

5. **Build the first slice in a worktree.** Claim the ticket when you start. Create a worktree (`worktree_create`, or `git worktree add <project>.worktrees/<slug> -b ticket/T-n-slug`). Write the code with its tests, run them, pass the quick gate, merge into the integration branch, push.

6. **Run the first full gate and a dry deploy.** Validate the pipelines (`ci_validate`). Trigger the full gate on the exact merged commit and the deploy pipeline in dry-run mode (`ci_run_trigger`). Read the result (`ci_run_get`, `ci_run_logs` on a failure). No real environment is touched on day one.

7. **Write the status file** in the `work-rhythm` format: DONE with links, IN FLIGHT, DECISIONS, NEEDS A HUMAN, NEXT. Commit and push it.

8. **Record the first decision and the first incident line.** Record one decision you took under a default, with the options and the reason. Write the incident line honestly in the status file and on the ticket: either "Incidents: none (checked: gates green, no deny-rule hit, no secret seen, no force push)" or the incident ticket's id.

At the end of day one, write on the PRD ticket: minutes from the first prompt to the first green gate, human messages after the first prompt, every question you would have asked and the default you took instead.

## The owner's checklist

One ticket, one line per item, with exact steps. Never a stream of questions, never a blocking ticket per item. Only these belong on it:

- **Production and uat:** any deploy, access, data or configuration there.
- **Secrets and permissions:** creating or rotating a secret, a pool entry that holds one, a token for the git host or a cloud, granting access.
- **Billing:** a spend cap, a paid service, an API-key budget.
- **Legal:** the licence, terms, privacy text, third-party terms.
- **Destructive data:** deleting or overwriting data, volumes, repositories.
- **Walls:** a change to the charter, safety rules, deny rules, authz, gates or scoring; the repository's `.claude/settings.json`.
- **Approvals:** a deploy approval where the pipeline requires a person; a Bypass lease; trusting a folder whose settings load hooks, MCP servers or environment.
Everything else: decide by the written default, record it, go on. Optional checks (a real device, polish, "does it feel right") are never on it: verify them in a harness or a scratch browser and state any limit ("not verified on a real device") on the ticket.
