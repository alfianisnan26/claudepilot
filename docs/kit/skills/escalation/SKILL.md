---
name: escalation
description: Use when you are about to ask a person anything - a question, an approval, a credential, a decision, a device check - or feel stuck waiting for one, and whenever a step touches production, uat, secrets and permissions, billing, legal matters or destructive data. Gives the required-versus-avoidable test, the default-and-write rule, the one owner checklist per program, and the single message to send when asking is required.
---

# Escalation

Human touch is a scored term in two classes that are never mixed. A **required** escalation is never penalised, and skipping one (acting without the person) voids the unit. An **avoidable** question (it had a written default, or the answer would have been "decide yourself" or "the default is fine") counts against the unit. Nobody answers in real time: an autonomous chat that waits for an answer is idle.

## 1. Is it required?

Required, and only these:

| Class | Examples |
| --- | --- |
| Production | any change, deploy, data read or credential that reaches production |
| UAT | any change, deploy, data read or credential that reaches uat |
| Secrets and permissions | a new secret or token, rotating or revoking one, a new permission, a role, an account added to a team, a deny rule or a protected setting |
| Billing | anything that spends money beyond the set budgets: a plan, a paid key, a spend cap |
| Legal | licences, terms, personal data, anything signed or published in someone's name |
| Destructive data | deleting or overwriting data that is not a disposable scratch copy |

Also never an agent's to do, whatever the class: approving a deploy or a merge that a person must approve, changing the charter's walls (safety rules, deny rules, authz, gates, scoring). Those are written down for a person, never worked around.

Everything else is **avoidable**: product choices, naming, UI text, test strategy, ordering, a stg question with a documented default, a library choice, a refactor's shape.

## 2. Avoidable: decide by the default and write it

1. Find the default: a standing decision, the PRD's recommended default, the project's standards, the brief (`decisions` skill).
2. None written: take the safer and more reversible option.
3. Record it on the ticket before acting (options, default, reason), then act.
4. If the owner should know, add one line to the status file's DECISIONS section. Do not ask.

Do not use the interactive question tool in an autonomous chat. Do not open a needs-a-person ticket for a question with a default. Do not send the owner a message that says "let me know if you prefer otherwise".

## 3. Required: one checklist per program

Each program keeps **one** owner checklist ticket (assigned to a person) for everything only a person can do. Production-only questions are one line on it, never a new ticket. Optional checks (a real phone, a real browser on the owner's machine, polish, "please confirm it feels right") never go on it: they are the agents' work, verified in a harness or a scratch browser, and any limit ("not verified on a real device") is stated on the ticket, not turned into a task for the owner.

1. Search for the checklist (`ticket_list`, assignee `user`, a query such as "checklist"). Add your item as a comment (`ticket_comment`). Create a ticket assigned to a person (`ticket_create`, assignee `user`, type `approval` or `question`) only when the item cannot wait for the checklist's next read, or when the program has no checklist yet: then create the checklist itself.
2. The orchestrator also lists it under NEEDS A HUMAN in its status file, with exact steps.
3. Then **take the next ticket**. Never wait idle for the answer.

## 4. How to ask (one message, complete)

When a person must decide, give them everything in one message; never a trickle of questions.

```
Needs: <the decision or action, one line>
Class: <production | uat | secrets and permissions | billing | legal | destructive data>
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
