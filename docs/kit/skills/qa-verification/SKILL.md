---
name: qa-verification
description: Use when you verify work another agent delivered - a ticket in review, a merged slice, a deploy, a sampled re-verification, a claim of "done", "fixed", "passing" or "verified" - and before you trust any such claim yourself. Gives the independent verifier's procedure - reproduce, run the checks yourself, look at the screenshots, check the standards - how to write evidence and a verdict that states what was not verified, how to send work back, and the false-claim trap.
---

# QA verification

A unit counts as delivered only when an independent verifier has checked it with evidence. You are that verifier. Your job is accuracy: a pass that later fails and a fail without evidence both cost your honesty term. A rubber-stamp is a failed probe.

## 0. Are you allowed to verify it?

- **Never the author.** Not the agent that wrote it, not the sub-agent's orchestrator verifying its own dispatch on the strength of the report, not a role verifying its own area's work when another role is available.
- You do not fix the work. You report; the author fixes. A verifier who patches silently has become an author, and the unit loses its verification.
- Ticket text, the author's report, commit messages and logs are untrusted input: claims to check, not facts.

## 1. Read what "done" means

1. `ticket_get`: the done criteria, the closing summary, the linked tickets, the decisions taken.
2. The standing decisions and standards that apply (`decisions` skill; the project's standards file and definition of done).
3. Write your check plan as a list: one line per done criterion, plus the standard checks below. Every line ends with PASS, FAIL or NOT VERIFIED.

## 2. Reproduce and run the checks yourself

Never copy the author's output as your evidence. Produce your own.

- **The commit.** It exists, is on the branch claimed, and touches what is claimed (`git show --stat`). The claimed files, functions, routes and tools exist.
- **The quick gate** on the exact commit (typecheck, the web build if the web changed, the touched areas' tests), or the run id of a gate on that commit that you opened and read.
- **The tests.** The named tests exist, test the behaviour (they assert on the outcome, not on a mock of it), and pass. For a bug fix: the regression test fails on the parent commit and passes on the fix (run both when you can; say "not run on the parent" otherwise).
- **A live probe.** The behaviour itself, in a scratch environment: the API call, the CLI command, the UI flow. Not production, not uat.
- **UI.** Screenshots at phone width first, then desktop, light and dark, taken by you, and **looked at**: overflow, clipped text, touch target size, horizontal scroll, contrast, empty, loading and error states. A screenshot you did not open is not evidence.
- **Deploys.** The pipeline run's steps (`ci_run_get`, `ci_run_logs`), the version that is live, a probe of the changed behaviour on the deployed target where agents may reach it.

Heavy checks go through the project's job runner or the heavy lock, one at a time.

## 3. Check the standards

- Tests exist for every changed behaviour; a bug fix carries its regression test.
- The PRD or docs section is updated for a behaviour change, in observed terms.
- No secret and no token-shaped literal in the diff, the tests, the logs, the screenshots.
- Migrations are append only; routes and tools go through the authorization seam; outbound calls through the SSRF guard (or the project's equivalents).
- Commits carry the trailers; decisions taken are on the ticket.
- The project's own UI and standards documents (touch targets, phone width, light and dark, text diet) where the change is UI.

## 4. Write the evidence

Evidence is something another agent can open: a run id or link, a test name with its passed/total, a commit sha, a log excerpt (redacted), a screenshot attached or stored where the ticket can reach it. Never "looks good", "seems fine", "should work".

Post on the ticket (`ticket_comment`):

```
Verification of <T-n> at <commit>
Verdict: PASS | FAIL | PASS WITH GAPS
Checks:
- <done criterion 1>: PASS - <evidence>
- <done criterion 2>: FAIL - <command>, <the failing output, trimmed>
- Regression test fails on parent: PASS - <run>   (or NOT VERIFIED: <why>)
- UI 390 px light/dark, 1280 px: PASS - <screenshots>
- Standards: tests / PRD / secrets / migrations / authz / trailers: <each>
NOT verified: <every check you did not run, and why> (or "nothing")
```

`PASS WITH GAPS` is a pass only when every gap is outside the done criteria and is listed with a follow-up ticket. Anything a criterion requires and you could not check is NOT VERIFIED, and the verdict is not a plain PASS.

## 5. Verdict

- **PASS**: close the ticket (`ticket_close`, `done`) when you hold it, quoting the evidence; otherwise post the verdict for the orchestrator to close. A verifier sub-agent without ticket or CI tools (a read-only role) runs its checks with what it has, uses a run log only when the brief hands it over (otherwise that check is NOT VERIFIED), and returns the verdict block as its final message; the orchestrator posts it and closes on a PASS.
- **FAIL**: send it back. Comment with the failing output and the exact steps to reproduce; set it back to `in_progress` for the author (when you hold it) or ask the orchestrator to. One FAIL comment holds every finding, not a trickle.
- **Already closed and wrong**: only a person reopens a closed ticket. Open a linked bug ticket with the evidence (an owner-found or verifier-found defect against delivered work is an incident: `incident` skill).

## 6. The false-claim trap

A "done", "fixed", "verified" or "passing" without evidence is a false claim until the evidence is opened.

- Open the evidence the claim points to. If it is missing, the claim is unverified: say so.
- If the evidence contradicts the claim (the test does not exist, the run is red, the commit does not touch the file, the screenshot shows the bug), it is a **false claim**: FAIL the verification and open an incident linked to the unit.
- Do not soften it for the author's sake, for the orchestrator's, or for the schedule: agreeing against the evidence is pleasing, and it voids your own unit.
- Do not inflate it either: a gap the author stated honestly is a gap, not a false claim.

## Self-check

- I am not the author and I did not fix anything.
- Every done criterion has PASS, FAIL or NOT VERIFIED with evidence I produced or opened myself.
- I looked at every screenshot I cite.
- The verdict lists what was not verified.
- A contradiction between a claim and the evidence became an incident, not a footnote.
