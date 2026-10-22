---
name: escalation
description: Use when you are about to ask a person anything - a question, an approval, a credential, a decision, a device check - or feel stuck waiting for one, and whenever a step touches production, uat, secrets and permissions, billing, legal matters or destructive data. Gives the required-versus-avoidable test, the default-and-write rule, the one owner checklist per program, and the single message to send when asking is required.
---

# Escalation

Human touch is a scored term in two classes that are never mixed. A **required** escalation is never penalised, and skipping one (acting without the person) voids the unit. An **avoidable** question (it had a written default, or the answer would have been "decide yourself" or "the default is fine") counts against the unit. Nobody answers in real time: an autonomous chat that waits for an answer is idle.

## 1. Who it goes to (D-62: the owner's only standing action is PRODUCTION)

**Needs a human, and only these two:**

| Class | Examples |
| --- | --- |
| Production | any change, deploy, data read, credential or published text that reaches production |
| UAT | any change, deploy, data read or credential that reaches uat, unless the owner asked for that uat step in so many words: then the crew does it (D-79, below). A migration on a database stg shares with uat is not this class (D-92, see below). |

**UAT on the owner's request (D-79):** when the owner asks for a uat promotion or deploy (a message or a ticket comment naming uat), it is the crew's work, not a question: dry run with a go/no-go per repo on the ticket, migrations on a shared database forward-only with their dry run (D-77, D-92), then the promotion through the normal path (promotion PRs, the uat pipelines), then smoke checks, evidence for each step. uat secrets by name only. Production stays a human step.

**Shared-database migrations (D-92):** an additive migration (new objects, nullable or defaulted columns, seed rows by `INSERT OR IGNORE ... VALUES`) is applied by the app's stg-deploy with migrate_approval=<ticket> after QA PASS and the dry run in the same run; no person. Anything else is split expand/contract, and the contract part goes with the next uat promotion. This never reaches uat itself.

**For the coordinator, never a person** (the coordinator decides or lands it, D-60/D-62; write it under `FOR THE COORDINATOR:` on the ticket, that exact phrase, and the coordinator's watch reads it within minutes):

| Class | Examples |
| --- | --- |
| Secrets and permissions | a new secret or token (by name, never the value), rotating one through a system the program already holds, a permission, an allow or deny line, a hook, folder trust, RBAC |
| Rule files and walls | `.claude/settings*.json`, `.mcp.json`, an allow-list checker, the charter's safety rules, gates and scoring: tightenings land at once, loosenings after one blind reviewer's PASS on the ticket |
| Infra | the cluster, images, pools, runners, deploys, a workspace restart, a door script |
| Billing | spend inside the set budgets; anything beyond them stays undone (the default), and the coordinator says so |
| Legal | drafts; publishing in production is the Production class |
| Destructive data | outside production and uat (stg, dev, scratch): with a backup and an undo, decided by the coordinator |

Never tag a ticket `owner-*`, `waits-owner` or `needs-person`, never mark it blocked on the owner, and never write "a person's step" for anything in the second table: that parks work for hours (2026-10-16: about 14 tickets sat blocked this way). Approving a deploy or a merge that a person must approve, and getting around a deny rule, a gate or an approval, stay forbidden for every agent: write it for the coordinator instead.

A reassignment, a restart, a continuation, a mode change or a move is not an escalation: the platform step is yours (`ticket_adopt` for the tickets of an ended session) and goes as one line on the status ticket. A ticket whose session ended is never a reason to ask the owner.

Everything else is **avoidable**: product choices, naming, UI text, test strategy, ordering, a stg question with a documented default, a library choice, a refactor's shape.

## 2. Avoidable: decide by the default and write it

1. Find the default: a standing decision, the PRD's recommended default, the project's standards, the brief (`decisions` skill).
2. None written: take the safer and more reversible option.
3. Record it on the ticket before acting (options, default, reason), then act.
4. If the owner should know, add one line to the status file's DECISIONS section. Do not ask.

Do not use the interactive question tool in an autonomous chat. Do not open a needs-a-person ticket for a question with a default. Do not send the owner a message that says "let me know if you prefer otherwise".

## 3. Required: one checklist per program

Each program keeps **one** owner checklist ticket (assigned to a person) for the two human classes only: production and uat (Konfersi: T-93). Production-only questions are one line on it, never a new ticket. Optional checks (a real phone, a real browser on the owner's machine, polish, "please confirm it feels right") never go on it: they are the agents' work, verified in a harness or a scratch browser, and any limit ("not verified on a real device") is stated on the ticket, not turned into a task for the owner.

1. Search for the checklist (`ticket_list`, assignee `user`, a query such as "checklist"). Add your item as a comment (`ticket_comment`). Create a ticket assigned to a person (`ticket_create`, assignee `user`, type `approval` or `question`) only when the item cannot wait for the checklist's next read, or when the program has no checklist yet: then create the checklist itself.
2. The orchestrator also lists it under NEEDS A HUMAN in its status file, with exact steps.
3. Then **take the next ticket**. Never wait idle for the answer.

## 4. How to ask (one message, complete)

When a person must decide, give them everything in one message; never a trickle of questions.

```
Needs: <the decision or action, one line>
Class: <production | uat>   (anything else: write the same block under FOR THE COORDINATOR: on the ticket)
Why: <the evidence, links>
Options: A) ...  B) ...
Recommendation: <A or B, and why>
Default if no answer: <what stays true meanwhile: usually "nothing happens; X stays as it is">
Meanwhile: <what you do instead; which ticket you take next>
Steps for the person: <exact, short, numbered; where to click or what to run>
```

- The default for a required class is always the safe one: nothing is done. Never "I will proceed on <date> unless you object".
- Never put a secret in the message: name where it lives.
- Never ask the owner to comment less or answer faster; never word a question so the easy answer is the one you want.

## 5. Signals that you are about to over-ask

- You are asking for confirmation of something a standing decision already says.
- You are asking which of two reasonable options to take, and neither is in a required class.
- You are asking because the task is hard, long or unclear: that is a re-estimate, a smaller slice, or a decision you record.
- You opened a second ticket for a person in the same hour: merge it into the checklist.
- You are waiting: anything that makes you stop working while a person reads is wrong unless the whole backlog is blocked, and then say exactly that in the status file.

## 6. Signals that you are about to under-ask (worse)

- The step uses a credential that belongs to a person, or uses one for more than its job.
- A deny rule, branch protection, an approval environment or a gate refuses you, and you are looking for another path. Stop: that refusal is the escalation.
- The command deletes or overwrites data you did not create in a scratch place.
- The step reaches uat or production, even "read only".

## Self-check

- Every question I sent to a person is in a required class and is on the program's one checklist.
- Every avoidable choice has a decision comment instead of a question.
- My message had the options, the recommendation, the safe default, what I do meanwhile, and the steps.
- I took the next ticket instead of waiting.
