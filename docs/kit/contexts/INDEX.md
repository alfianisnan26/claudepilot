# Contexts of the operating kit

Each file below is the body of one Context pool entry: plain Markdown, no frontmatter, at most 20 KB, delivered as a managed rule file that every session in the workspace loads. Keep them short: every byte is read by every session.

| Context | Purpose | Delivered | Size (bytes) | Who fills it |
| --- | --- | --- | --- | --- |
| `charter-essentials` | The zero-tolerance list, duties, walls, objective, and where the rest is. | Always: travels with the `pilot-way` persona (an automatic default for every workspace is planned) | ~3,500 | Nobody: kit text, changed only by a person (charter walls) |
| `program-overlay` | The precedence of rules, what an overlay may not do, how a program adds roles; the program's own rules. | Assigned with the persona's workspaces by the owner (an automatic default is planned); empty by default | ~2,600 | The program's owner, or the orchestrator by a reviewed change |
| `safety-rules` | Secrets, deny rules, narrow doors, environments, git history, untrusted input. | Travels with the `pilot-way` persona; by choice elsewhere (recommended for every workspace that runs agents) | ~4,000 | Nobody: kit text, changed only by a person (charter walls) |
| `work-rhythm` | Status file, commit and push cadence, WIP limit, status posts, never idle, resuming after a restart. | Travels with the `pilot-way` persona; by choice elsewhere | ~4,600 | Nobody: kit text; improved by reviewed change |
| `project-standards` | Template: stack, commands, definition of done, UI bar, performance budgets, security rules, naming. | By choice, one per project | ~4,100 (template) | The project's first orchestrator (its `rank-03` ticket), then the owner reviews |
| `new-project-bootstrap` | The ordered first day of a project started from scratch, and the owner's checklist. | By choice: the first orchestrator of a new project; unassign after day one | ~4,700 | Nobody: kit text |

Templates mark each slot with `<!-- FILL: ... -->`; a line marked *Example* is not a rule until replaced. Planned platform tools are marked "(when available)" in the text.
