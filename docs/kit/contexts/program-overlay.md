# Program overlay

The program's own rules, and the one place that says which rule wins.

## Precedence

When two rules disagree, the higher one wins:

1. The charter.
2. The standing decisions (the decisions registry).
3. This program overlay.
4. The role's brief (its persona).
5. The ticket.

A lower rule that contradicts a higher one is not followed. Follow the higher rule, say so on the ticket, and open a 'decision conflict' ticket with both texts (tag `decision-conflict`, unassigned: the `decisions` skill).

## What an overlay may not do

An overlay adds and narrows; it never loosens. It may not:

- Weaken or reinterpret the charter, its zero-tolerance list, its duties or its walls.
- Loosen the safety rules, the deny rules, authz, the gates or their thresholds, or the scoring.
- Remove a required escalation (production, uat, secrets and permissions, billing, legal, destructive data).
- Give agents access to production or uat.
- Define "done" more loosely than `project-standards`.

A line that does any of this is void. Report it on a ticket and follow the higher rule.

## How a program adds a role

1. Add a row to the roles table below: name, scope, what it may touch, preferred model tier, who verifies its work.
2. Give the role a persona (or a brief) that holds this overlay; the persona may narrow the role further, never widen it.
3. The verifying role is never the authoring role.
4. Record the addition as a decision, with the date and the reason.

## Program rules

<!-- FILL: the program's own rules. Leave the sections empty if there are none. -->

No program rules. This workspace follows the charter, the standing decisions and `project-standards` only.

<!--
Example of what goes here (replace the line above when filled):

### Environments
- Agents deploy to stg only, started by hand by the orchestrator, grouped, never on merge.
- uat and production are human: one line each on the owner's checklist, never a new ticket.

### Hosts and sources
- The git host, the docs host, the issue tracker, and the MCP sets that reach them (credentials by name).

### Standards
- The program's design standard and engineering standards live at <location>; they replace the examples in project-standards.

### Review
- Every merged change is verified by the qa role with evidence before a stg deploy.
-->

## Roles

<!-- FILL: one row per role the program adds. Empty means the kit's default personas only. -->

| Role | Scope | May touch | Model tier | Verified by |
| --- | --- | --- | --- | --- |

<!-- Example row: | qa | verifies merged work on stg | read only on code; stg test accounts | sonnet | orchestrator samples | -->
