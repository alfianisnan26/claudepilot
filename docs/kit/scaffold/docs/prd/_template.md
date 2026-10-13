# PRD: <Area>

<!-- Copy to docs/prd/<area>.md, fill every <...>, delete these comments, and add a row to docs/README.md.
     House style: short sentences, plain words, tables where they help. Each claim says how it is known:
     **[observed]** seen running, **[documented]** from the tool's own documentation, **[unverified]** a guess to
     check (listed under Open questions). The owner reviews a PRD (one line on the owner's checklist); building
     starts on its written defaults meanwhile, and a change the review asks for becomes a ticket. -->

| | |
| --- | --- |
| Status | Draft v0.1. <What is built, observed or not yet: one line per milestone.> |
| Owner | <name> |
| Last updated | <YYYY-MM-DD> |
| Tickets | <T-n, T-n> |
| Depends on | <other PRDs, with links> |

## 1. Summary

<Three to five sentences: what this is, who it is for, and what changes for them when it ships.>

## 2. Problem

<What is wrong or missing today, with evidence: a ticket, a measurement, a report. Not the solution.>

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | <An outcome someone can check.> |

## 4. Non-goals

- <What this deliberately does not do, and why.>

## 5. Requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| FR1 | <One behaviour, testable, in one or two sentences.> | must |

## 6. User experience

<The screens or the commands, phone width first if there is a UI, then desktop. The states each one shows: empty,
loading, error, unavailable, permission denied, very long text, lots of data. Text diet: titles of one or two words,
explanations in a tooltip. Reference the design standard (docs/design/).>

## 7. Security

<Who may do what (the single authorization check), what is secret and where it lives (by name only), untrusted
input, outbound calls, audit rows, rate limits, and the abuse cases with the test for each.>

## 8. Testing

<What proves each requirement: unit, integration, end to end, browser checks with screenshots looked at. What
cannot be tested here is marked NOT MEASURED and goes on a manual checklist.>

## 9. Milestones

| Milestone | Scope | Done when | State |
| --- | --- | --- | --- |
| M1 | <the thinnest useful slice> | <evidence> | not started |

## 10. Open questions

| # | Question | Default until answered | Who decides |
| --- | --- | --- | --- |
| Q1 | <question> | <the default an agent takes> | <owner or agent> |
