---
name: incident
description: Use when you notice that you, or another agent, caused or found an incident - a zero-tolerance event (a secret printed, a force push, an approval or gate worked around, a false claim), an outage, lost data, a failed or rolled-back deploy, a red gate on the integration branch, a deny-rule hit, a session ended for integrity, or an owner-reported bug against delivered work - and when writing its post-mortem. Gives containment first, the self-report format, the voiding rule, the post-mortem note, and the test the fix must carry.
---

# Incident

An incident reported by the agent that caused it, at once and in full, is honest work. An incident hidden, softened or found by someone else first is a second zero-tolerance event (pleasing, false claim). Report your own mistakes the same way as anyone else's.

## 1. Contain first (minutes, before writing)

- **Stop the action.** Stop the command, the loop, the merge or the sub-agent that does it. If others repeat it (a brief, a skill, a dispatched agent), tell them to stop now, in their channel.
- **Do not make it worse.** Never print, paste or quote a leaked value again, not even to show it, and never put it in a command to search for it (`grep`, `git log -S`): that prints it again. Look for where it is with a search by its shape that reports only locations (file names or counts, such as `grep -l`), or with the project's secret scanner; never one that prints the matching text. Never "undo" with another hazardous step (a force push to hide a force push, deleting evidence, rewriting history).
- **Do not do a person's part.** Rotating or revoking a credential, changing a deny rule, restoring production data, reverting a release by hand: write them as "what is needed from a person". Do the safe part yourself: stop, isolate (a branch, a rig), keep the evidence.
- **Note the times**: when it happened, when you noticed, when it was contained.

## 2. Self-report: the incident ticket

`ticket_create` with type `incident` (or `bug` where the program uses it), tag `incident`, a severity, linked to the unit that caused it: the ticket, the slice or role label, the session, the model, the commit through its `Ticket:` and `Pilot-*` trailers. Title: what happened, plainly ("Sub-agent printed this chat's portal token into its transcript"). Then these sections, in this order, short:

```
What happened. <who (role, session), when, what was run or done, in plain words; who reported it (say "the agent reported it itself" when true)>
Where the value or damage is. <exactly where it is AND where it is not: transcript, file, commit, log, ticket, CI run; what you checked to say so>
Impact. <what someone could do with it, or what broke, for whom, for how long; "no runtime effect" only with the reason>
Containment. <what was stopped, when, by whom>
What is needed from a person. <the exact steps only a person can take, or "nothing">
Cause. <the mechanism, not the blame: the command, the rule that was missing, the instruction copied without checking>
Fix. <the brief line, the code change, the new default; what is proposed for a person to decide (a deny rule is a person's)>
Check that would have caught it. <a test, a scan, a deny rule, a gate step; whether it exists today>
Unit. <which unit is voided, or why a related unit is not; what a stricter reading would require>
```

Rules for the text:
- Facts with their source; "I checked X" means you opened X. Say what you did not check.
- Never the secret, never a token-shaped string, never the environment. Describe it by name and scope.
- No adjectives, no apology paragraphs, no "minor". The impact section carries the size.
- The cause names the mechanism even when it is your own choice ("a plain push was refused and `-f` was the shortcut").

## 3. Voiding

The charter voids the unit that caused a zero-tolerance event: it does not count as delivered until a person decides otherwise. Name that unit. When a related unit (a merge made possible by the event, say) is arguably clean, say so with the reason, state what a stricter reading would require (for example a re-verification), and leave the decision to the owner. Never decide in your own favour silently.

## 4. Post-mortem note

Within the same session, write a note in the knowledge vault's incidents folder (`note_write`; see the `knowledge` skill): the incident ticket link, cause, detection time (how long it went unnoticed), fix, the test or check that would have caught it, and the lesson as one line. No secret, no raw transcript.

A lesson that can recur becomes a brief line or a skill line (proposed through a normal pull request) or a ticket for the check. A proposal that touches the walls (deny rules, safety rules, authz, gates, scoring) is written for a person to decide.

## 5. The fix carries the test

- The fix ticket names the check that would have caught it, and the change adds that test or scan.
- A regression test must fail without the fix (run it on the parent commit when you can) and pass with it.
- The fix is verified independently (`qa-verification`); the incident is closed by someone other than the author, with the evidence.

## 6. What counts as an incident

The zero-tolerance list (`charter` skill), and also: a failed or rolled-back deploy, a red gate on the integration branch, a deny-rule hit, a secret found by a redactor or a repository scan, a session ended for integrity, a watchdog finding, an owner-reported bug against delivered work. When unsure, open it: an incident ticket closed as "not an incident, because <evidence>" costs little; a hidden one costs the unit and your honesty term.

## Worked patterns

Three real self-reports, condensed, are in `references/example-incidents.md`: a token printed by an environment dump (containment by a person, a brief line, a scan proposed), a force push to a private branch (no damage, a new convention, a deny rule proposed, an honest note on voiding), and approvals made in a person's name (containment, a list of affected items, a decision needed). Read them before writing your first report.

## Self-check

- Contained before reported; no leaked value repeated anywhere.
- The ticket has every section; "where it is not" is stated with what was checked.
- The person's part is written as steps, not done by me.
- The voided unit is named; any exception is argued, not assumed.
- The post-mortem note exists and names the check; the fix ticket carries the test.
