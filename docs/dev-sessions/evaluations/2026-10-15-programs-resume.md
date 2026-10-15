# Konfersi and Event back as crews: the first 100 minutes (2026-10-15, 00:20 to 02:00 UTC)

The owner asked for an audit of effectiveness and efficiency after Konfersi and Event restarted as crews with function and QA personas
(D-52, 00:21 UTC). Every number is MEASURED from the portal at about 01:58 UTC (chat sessions, tickets, CI runs) or from git in the
workspace pod, unless it says ESTIMATE. Caveat first: the portal stalled in waves from about 00:45 to 01:44 (T-365), so about half of this
window ran degraded, and both programs spent it mostly on setup (allow lists, folder trust, the operating model, the runner).

## Per program

| | ClaudePilot | Konfersi | Event |
| --- | --- | --- | --- |
| Lead | 83842ba6 (after a hand-over at 01:22), 18.52 USD, context 205k | b317c7ab, 22.73 USD, 47 turns, context **459k** | 88591c13, **31.10 USD**, 23 turns, context **371k** |
| Workers started | 10 (implementer 3, qa-verifier 5, reviewer 2), 14.98 USD | 12 (konfersi-qa 4, -qa-ui 2, -ai 2, -core 2, -web 1, -metocean 1), 33.94 USD | **3** (event-qa 1, event-devops 2), 3.73 USD |
| Worker models | opus 5, sonnet 5 | opus 4, sonnet 8 | opus 1, sonnet 2 |
| Worker Claudes | 5 different | 7 different | 2 (hasyim, satria) |
| Tickets closed | 9 (3 of them by the coordinator) | 2 (T-357, T-358) | 1 (T-155) |
| Tickets opened | 22 | 14 | 4 |
| Commits | (integration, many) | 15 on module work branches (konfersi-core 4, konfersi-metocean 3), 24 on konfersi-universe | 22 (18 on stg); **14 carry Pilot-Agent `main`**, 4 event-devops |
| CI since 00:20 | gates and the hand release (T-365) | stg-deploy: 1 passed, 1 failed | gate: 5 cancelled, 1 failed, 1 running; stg-deploy-native: 1 failed (now parked, D-57) |
| Duplicate lead (supervisor, T-400) | 0.82 USD | 0.62 USD | 1.06 USD |

Cost per closed ticket (ESTIMATE, lead plus workers over closed tickets, setup included): Konfersi about 28 USD (57.29 / 2), Event about 36 USD
(35.89 / 1). Too early to compare with ClaudePilot's crew (about 5 USD a ticket on 2026-10-14): most of this window was setup and outage.

## What works

- Function and QA personas load from the workspace persona (all 20 agents in /etc/claude-code/.claude/agents) and the workers use them.
- QA workers are cheap: konfersi-qa and -qa-ui sessions cost 0.23 to 0.43 USD each; QA verified before close (T-357, T-358, T-155).
- Konfersi spreads its workers over seven Claudes; no spawn was refused (agent.refused: none).
- Allow lists: Konfersi's and Event's were read by the coordinator: no command runner, Edit and Write scoped, pushes to work branches only.

## What does not, and what was done

1. **Leads far past the hand-over line.** Konfersi 459k and Event 371k after 90 minutes; every turn re-reads that context, which makes the
   leads the most expensive sessions (Event's lead 31 USD against 3.73 USD for all its workers). Action: both asked to hand over at 01:58
   (status on T-84 and T-150, the supervisor starts continuations that take the live workers). The coordinator loop checks the 250k line every
   pass.
2. **Event's lead implemented** (14 of 22 commits by `main`), against D-52: its workers were refused until the crew folders were trusted
   (T-360), so it fell back to its own sub-agents. Two folders are trusted (crew-qa, crew-devops); three wait on the final settings. Action: the
   continuation dispatches only to function workers; T-366 makes the trust automatic.
3. **Konfersi does not reuse function sessions** (konfersi-qa started four times, -qa-ui, -ai and -core twice each), against D-52's "a live
   function session takes the next ticket of its function". Action: told to the lead and its continuation.
4. **Wasted CI runs on Event**: five gate runs cancelled and one failed, the native deploy failed (parked by D-57).
5. **Duplicate leads** during the outage cost 2.50 USD and nearly double-dispatched (T-400).

## Next measurement

Two hours after the hand-overs: cost per closed ticket per program, leads' context per hour, function-session reuse (spawns per function),
share of commits by workers, CI cancelled/failed share.
