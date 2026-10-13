# The operating kit

The owner's way of working, packaged as parts of pilot itself: personas, skills, contexts and MCP sets in the
portal's pools, plus a project scaffold for new repositories. A workspace that carries the kit gives every agent the
same charter, decisions discipline, ticket flow, git flow, gates, deploy path and escalation rules, without a brief
having to repeat them. A project started from scratch begins with it on day one.

Decided in D-26 (`docs/dev-sessions/DECISIONS.md`); specified in `_specs/T-132.md` (the kit), `_specs/T-133.md`
(new project onboarding) and `_specs/T-134.md` (multi-module projects). Version: `VERSION`.

## The parts

| Folder | What it holds | Becomes | Index |
| --- | --- | --- | --- |
| `persona/` | `pilot-way.json`: the managed instructions for the orchestrator chat and the role sub-agents (implementer, qa-verifier, reviewer, scribe, release-coordinator, incident-analyst, explorer, ux-checker, perf-tester). | One **Persona** pool entry, `pilot-way` | `persona/README.md` |
| `skills/` | One folder per skill (`SKILL.md`, optional `references/`): charter, decisions, ticket-flow, escalation, incident, orchestration, qa-verification, peer-review, efficiency, portal-mcp, git-flow, ci-cd, safety, knowledge, browser-testing, and the `design-standard` slot. Text only. | One **Skillset** pool entry, `pilot-way` (prefix `pilot`) | `skills/INDEX.md` |
| `contexts/` | One Markdown file per context: charter-essentials, safety-rules, work-rhythm, project-standards (a template), program-overlay (empty by default), new-project-bootstrap. | One **Context** pool entry each | `contexts/INDEX.md` |
| `mcp/` | Draft MCP catalog entries (Gitea, three Outline hosts, an optional GitHub, browser references), **three program sets** (`isnan`, `konfersi`, `kohi-labs`: that program's Gitea and Outline each), the review dossier, the recommended tool rules. | Catalog **drafts**, then one **MCP set** pool per program, only after a person approved its entries | `mcp/README.md`, `mcp/REVIEW.md` |
| `scaffold/` | The files a new repository starts with, the placeholder list, the first tickets and the bootstrap procedure. | Not a pool: copied into the repository (by hand, or by the portal's template when available) | `scaffold/bootstrap.md` |
| `_specs/` | The ticket texts the kit was built from (read only). | Nothing | |
| `publish.mjs` | The publisher (next section). | | |

## Publishing to the portal

`publish.mjs` creates or updates the pools from these folders. It signs in as the admin, so **the owner runs it**
(it needs `PORTAL` and the portal's server code in the environment; an agent never holds that code).

- **Dry by default.** Without `--apply` it reads the portal and prints what it would create or revise.
  `--only=contexts,persona,skills,mcp` limits the run (the default is all four; `--only=mcp` runs the MCP part alone).
- **Idempotent.** A pool that exists by name gets a new revision, never a second pool.
- **Contexts** first: one Context pool per file (at most 20 KB each). The **persona** is created next and linked to
  the always-delivered contexts (charter-essentials, work-rhythm, safety-rules).
- **Skills**: the folder is imported; a version is approved only when the scan finds no script, hook or network use
  and no finding that needs a person's acknowledgement; then the skillset `pilot-way` is created or revised.
- **MCP** (`mcp/README.md`): the entries marked `publish` in `mcp/manifest.json` go into the catalog as **drafts**; a program
  set is created only when every entry of it has an approved version, otherwise the run prints
  `set <slug>: waiting for the owner's approval of <entries>`. The optional GitHub draft is not touched.
- **What it never does**: approve an MCP entry (a person reviews third-party servers), create a Secrets pool,
  assign anything to a workspace (a separate step the owner confirms), or print a credential.
- It writes `published.json` (pool and catalog ids only, no secrets) for the next run; a run that skips a part keeps that part's ids.

## Applying the kit to a new project

Follow `scaffold/bootstrap.md`: create the repository, apply the scaffold with `scaffold/PLACEHOLDERS.md`, create
the workspace with the `pilot-way` persona, the kit's contexts, the skillset and the reviewed MCP sets, create the
Secrets pool entries by name, create the CI remote, create the tickets of `scaffold/first-tickets.json`, start the
orchestrator chat (Bypass acknowledged by the owner, Keep going when available) with the first prompt. Record the
measurements it lists: minutes to the first green gate, tokens, human touches, what the agent still asked.

## Versions and updates

- `VERSION` is the kit's version. Each publish writes it into every revision note (`operating kit <version>`), so
  each pool revision says which kit it came from.
- **Update path**: change the kit by a reviewed commit; run the publisher dry and read what it would revise; run it
  with `--apply`; in the portal, review each pool's diff between revisions; then apply the new revision to the
  workspaces you choose (the pool framework's revisions and rollouts; no second mechanism). A workspace keeps the
  revision it has until then.
- **The scaffold is not updated in place.** A repository owns its copy once created. To take a later scaffold
  change, diff `scaffold/` against the repository and apply it by a ticket and the gate. Deny rules and the charter
  change only by a person.
- Proposals for the kit (from a retro, a playbook, an incident) arrive as tickets. A change that touches the
  charter's walls needs the owner's review.

## What is not in the kit

ClaudePilot-specific, kept in this repository only: the product's code map, commands and migration blocks; its
cluster, namespaces, registry, image builds and GitOps application; its throwaway-portal and browser harnesses; the
path-to-area map of its quick gate; its design standard (`docs/design`, T-120); its standing decisions beyond the
four every project inherits (`scaffold/docs/dev-sessions/DECISIONS.md.tmpl`, D-1 to D-4); the work packages and
briefs of its own tracks; the external supervisor script (replaced by the portal's Keep going).

**Konfersi keeps its own**: its program overlay (its rules go in the `program-overlay` context of its workspaces),
its design standard (in its own docs, not in this kit; the `design-standard` skill is a slot it fills), its git host
and its environment rules. The kit is the generic base under that overlay, not a replacement.

## Where the scaffold came from

| Scaffold file | Distilled from (this repository) |
| --- | --- |
| `CLAUDE.md.tmpl` | `CLAUDE.md` (rules), `docs/dev-session.md` (commands) |
| `docs/dev-sessions/README.md.tmpl` | `docs/dev-sessions/README.md` |
| `docs/dev-sessions/orchestrator.md.tmpl` | `docs/dev-sessions/orchestrator.md` |
| `docs/dev-sessions/CHARTER.md` | `docs/dev-sessions/CHARTER.md`, the same rules with project names and ticket numbers removed |
| `docs/dev-sessions/DECISIONS.md.tmpl` | D-1, D-15, D-5 with D-11, D-10 of `docs/dev-sessions/DECISIONS.md` |
| `docs/dev-sessions/status/_template.md` | `docs/dev-sessions/status/orchestrator.md`, the README's status section |
| `docs/prd/_template.md` | the house style of `docs/prd/*.md` |
| `docs/design/README.md.tmpl` | `docs/coord/QA-STANDARDS.md` (A1-A9), `_specs/T-120.md` |
| `.claude/settings.json` (+ `.md`) | `.claude/settings.json`: every deny rule kept, project names as slots, ten stricter deny rules added, fewer allow rules (no cluster changes, `git worktree` only `add` and `list`) |
| `.pilot/gate.yml.tmpl`, `deploy.yml.tmpl` | `.pilot/deploy.yml`, `.pilot/scripts/*.sh`, `docs/prd/local-git-ci.md` §9 |
| `scripts/README.md` | `scripts/gate*.sh`, `scripts/job-run.sh`, `scripts/dev-rig.sh` |

## Safety model

- **Kit pools are admin-owned and read-only to agents.** Agent text never edits a persona, a skill or a context;
  an agent proposes a change on a ticket, and a person reviews it.
- **The charter's walls hold.** No loop or agent changes safety rules, deny rules, authorization, the Bypass gates,
  the gates, the standards check's thresholds, the scoring or the zero-tolerance list.
- **No secret in any kit text.** Credentials reach a workspace only through the Secrets pool, referred to by name.
  Third-party MCP servers wait for a person's review before any set can use them.
- **The scaffold's deny rules are guard rails, not a boundary.** A shell in a workspace can do what its credentials
  allow; the charter forbids working around a deny rule, a gate or an approval. A protected deploy is approved only
  by a person in the portal (or, once built, by an environment rule a person turned on; never by an agent).
- **Applying the kit** (planned with the template, `_specs/T-132.md` item 8) will need the right to operate the
  workspace and every pool it names; a denial looks like "not found"; apply, update and detach are audited.
