---
name: peer-review
description: Use when you are assigned to assess another agent's delivered unit or a checkpoint of a long one, when you write the self-reflection after finishing your own unit, and when you read what peers said about your work. Gives the rubric - the eight charter terms rated 1 to 5, each with the evidence opened, plus what I would do differently and what I would copy - blind review, self-rating before reading peers, the calibration gap, and how reviewers are themselves scored.
---

# Peer review

Agents rate each other's work so every agent can learn and calibrate. Ratings are inputs to the retro and the playbooks, never the score itself: outcomes (real defects, the gate, independent QA, the owner's reports) beat any opinion. The signal you are measured on is **accuracy against outcomes**, not harshness and not niceness.

Peer review is not QA: QA decides whether a unit is delivered (`qa-verification`); a peer review assesses how well it was done. Neither edits the author's work.

## 1. Who reviews

- A different agent than the author, of another role, chosen by the orchestrator: never a reciprocal pair, never the same pair twice in a row. You do not choose whom you review.
- **Blind by default** for code review: do not look up who wrote it (session, label, model) when the work does not reveal it. Not blind for QA of a role's own area.
- The orchestrator is reviewed too, by the roles, on dispatch quality: clear briefs, a sensible order, no idle roles, no contradictory instructions.
- Never rate, quote or read the owner's messages as review material.

Tools: `peer_review_next` (what to review), `peer_review_submit` (the rubric), `peer_review_get` (what was said about my work), all when available. Until then: the orchestrator assigns the review on the ticket, and you post the rubric as a ticket comment headed `Peer review` (a reviewer sub-agent without ticket tools returns it as its final message, and the orchestrator posts it).

## 2. The rubric

Rate each term from 1 to 5. **Every rating names the evidence you opened** (a commit, a gate result, a test, a screenshot, a log, a ticket state). A rating without evidence is discarded; write `n/a: <why>` instead of guessing.

| Term | What to look at |
| --- | --- |
| Delivered | the done criteria met, against the size and priority of the ticket |
| Quality and standards | tests that test the behaviour, the regression test, the PRD and docs, the project's standards, the UI bar |
| Safety | zero-tolerance events, deny-rule hits, secrets, actions outside the narrow doors |
| Honesty | claims against evidence, "not verified" stated, failures reported first, the self-rating's calibration |
| Traceability | ticket, trailers, decision comments before acting, closing summary with evidence |
| Human touch | questions asked that had a default (avoidable), required escalations made properly, owner-found defects |
| Efficiency | tokens and cost against similar units, retries, idle burn, context growth, CI minutes; was any spike justified |
| Predictability | the first estimate against what happened, blocked time caused, conflicts caused, reopens |

Scale: 5 = could serve as the example for this task type; 4 = solid, minor gaps; 3 = acceptable with clear gaps; 2 = a bar was at risk; 1 = a bar was broken.

Then two lines, each one sentence and concrete:
- **What I would do differently**: a step, a tool sequence, a check, an order; not a value judgment.
- **What I would copy**: the specific technique worth repeating, with where it is.

```
Peer review of <T-n> at <commit> (blind: yes/no)
Delivered: 4 - <evidence>
Quality and standards: 3 - <evidence>
Safety: 5 - <evidence>
Honesty: 4 - <evidence>
Traceability: 5 - <evidence>
Human touch: 5 - <evidence>
Efficiency: 2 - <evidence>
Predictability: 3 - <evidence>
Would do differently: <one line>
Would copy: <one line>
```

## 3. Accuracy, not harshness or niceness

- Agreeing is allowed when it is true. A 5 that later meets an escaped defect costs you; so does a 2 on work that proved fine.
- Do not rubber-stamp (all 4s and 5s with thin evidence), do not attack without evidence, do not rate to please the author, the orchestrator or the owner.
- Separate what you saw from what you infer. Say "not opened" rather than imply you checked.
- Rate the work, not the model or the role's reputation.

## 4. Self-reflection (the author, after each unit)

Write it **before** you read any peer rating of the unit, on the ticket:

```
Reflection on <T-n>
Went well: <one line>
Cost the most: <one line, with the number if known: tokens, hours, retries>
Next time: <the one change>
Self-rating: <the same eight terms, 1 to 5, each with its evidence>
```

Then read the peers (`peer_review_get` when available, or the ticket). The **calibration gap** (your self-rating against the peers' ratings and against the outcome) is a learning signal and part of your honesty term. Rating yourself far above the evidence is shown to you; a well-calibrated self-rating is noted.

## 5. Reading reviews of your work

- Answer a finding with evidence or accept it; do not argue the number.
- Turn a recurring "would do differently" into a change in how you work, and say so in your next reflection.
- Never edit, delete or ask to change a review. Disagreement with evidence goes on the ticket.

## Self-check

- Every rating I gave names evidence I opened; the rest are `n/a`.
- I did not look up the author of a blind review.
- My reflection was written before I read the peers.
- Nothing in the review rates or quotes the owner's messages.
