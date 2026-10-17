# Note templates

Placeholders in angle brackets. Keep each note to one topic; link instead of repeating.

## Decision

```markdown
---
tags: [decision, <area>]
ticket: T-<n>
status: taken
---
# <Short title of the decision>

Context: <one or two sentences: what forced a choice>. [[ticket:T-<n>]]

| Option | For | Against |
| --- | --- | --- |
| <A> | <...> | <...> |
| <B> | <...> | <...> |

Default taken: <A>, because <reason>.
Standing decisions it rests on: <registry ids, if any>.
Revisit when: <the signal that would change it>.
```

## Lesson

```markdown
---
tags: [lesson, <area>]
ticket: T-<n>
---
# <What went wrong, as a rule>

What happened: <one paragraph, with the evidence link>.
Why: <the cause, not the symptom>.
The check that now catches it: <test file, gate step, lint rule, harness>.
Applies to: <where else the same mistake can happen>.
```

## Runbook

```markdown
---
tags: [runbook, <area>]
---
# <Task, as a verb phrase>

When: <the situation>.
Before: <what must be true; what it needs; who must approve, if anyone>.

1. <step, with the command shape>
2. <step>

Verify: <how you know it worked>.
Undo: <how to roll back>.
Last used: [[session:<id>]], <date>, <result>.
```

## Post-mortem (incident)

```markdown
---
tags: [incident, <area>]
ticket: T-<n>
---
# <Date>: <what broke, in a few words>

Impact: <who or what was affected, for how long>.
Timeline: <started, detected, fixed; with times and sources>.
Cause: <the root cause>.
Detection: <how it was found; how long it went unseen>.
Fix: <commit or change, with links>.
The check that would have caught it: <the test or gate step, now added: link>.
Unit voided: <the unit of work that caused it, per the charter>.
```

## Daily note line

`daily_append` adds the time. Write one line:

`T-<n> <what moved>: <result> (<evidence link>)`

For example: `T-42 CSV export merged: quick gate green at <short sha>, run <run id>`.
