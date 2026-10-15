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

## Second window: 02:00 to 03:35 UTC (after the hand-overs and fixes)

MEASURED from the portal (sessions, tickets, CI) and git at 03:35; lead cost split by the time each lead lived in the window (ESTIMATE), worker
cost counted in the window the worker started.

| | ClaudePilot | Konfersi | Event |
| --- | --- | --- | --- |
| Tickets closed | 4 | 3 | 2 |
| Cost (leads + workers) | about 66 USD (lead 13, workers 53) | about 43 USD (16 + 27) | about 38 USD (12 + 26) |
| Cost per closed ticket | about 16 USD | about 14 USD | about 19 USD |
| Workers started | 22 (implementer 12, reviewer 5, qa-verifier 3) | 15 (konfersi-qa 4, reviewer 5, -ai 3, -web 2) | **26** (event-qa 10, -devops 6, -builder 6, -web 3) |
| Worker models | opus 18, sonnet 4 | opus 6, sonnet 9 | **opus 21**, sonnet 5 |
| Most workers on one Claude | 11 | 7 | 11 |
| In review now | 10 (waiting for a deploy) | 18 (waiting for the stg merge gate, T-387) | 2 |
| Commits | 36 on integration | (module branches) | 30, **16 by the lead** (`main`) |
| CI | deploy 32 passed | stg-deploy 17 passed | none |

Across the three: QA and review workers cost 1.21 USD a session on opus against 0.47 on sonnet (15 of 28 on opus); build workers 2.65 on opus
against 0.42 on sonnet. Throughput: 9 closed in 95 minutes (about 5.7 an hour); 30 tickets are done in work but wait in review on a gate
(a deploy, the Konfersi stg merge gate).

What got better since the first window: Konfersi's cost per closed ticket (47 to 14 USD), no outage, no OOM, no duplicate lead, the owner's
queue at zero (D-62), spawns spread once the leads named the Claude (two.claude from 5 live sessions to 0).

What is still wrong, and the defaults now in force (D-63): opus where sonnet does (QA and review on sonnet; opus only for gate, rule and
security reviews and large slices); spawn churn instead of reusing function sessions; Event's lead implementing; leads copying worker reports
because workers have no ticket tools in ClaudePilot and Konfersi (T-433); leads growing 200k to 300k context an hour (T-423). Next measurement
at about 05:30 UTC, same table.

## Cost spikes (owner's request, 04:00 UTC)

Sources: the portal's spike detector (`/api/usage-spend/spikes?range=1d`: 37 events, 29 outliers, 8 rate spikes; an "outlier" is one agent
TURN, which can hold dozens of model requests) and the raw Claude Code tapes of the spiking sessions in the pod (per request: input, cache
read, cache write, output; weights input 1, cache read 0.1, cache write 1.25 or 2, output 5). MEASURED.

| Session | Spike | Requests | Context p50 / max | Cost share: cache read / write / output |
| --- | --- | --- | --- | --- |
| old ClaudePilot lead 619018ca (fable, yesterday) | one turn 107 USD, one 80 USD | 191 | 213k / 363k | 71 / 13 / 16 percent |
| old Event lead e1235d03 (yesterday) | one turn 53 USD | 121 | 105k / 191k | 64 / 18 / 17 |
| konfersi-qa 1448a718 (sonnet, reused across tickets) | 36 USD in 15 min; turns of 16 and 18 USD | 499 | **397k / 967k** | **85** / 10 / 6 |
| konfersi-core 30f199b2 | one turn 19 USD | 290 | 277k / 484k | 81 / 10 / 9 |
| Konfersi lead b317c7ab | turns of 14 and 10 USD | 302 | 272k / 479k | 81 / 9 / 10 |
| Event lead 88591c13 | | 222 | 259k / 387k | 76 / 11 / 13 |

No cache misses: every session writes its cache with the 1-hour TTL, and no request rewrote more than 100k. The cost is the size of the
context times the number of requests: cache reads are 64 to 85 percent of it. With 1M-token models Claude Code compacts only near 1M, so a
long-lived or reused session keeps growing (a QA worker reused across tickets reached 967k).

Done: the agent policy sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` for every Claude (setting `agents.autoCompactWindow`, integration
d354977, live after the next deploy and each Claude's next start); until then any worker over 200k context is replaced after its ticket,
QA briefs stay narrow (the diff, the criteria, logs through grep or tail). Expected effect (ESTIMATE): requests of the big sessions read
about half to a third of today's context, so their cost per request falls by the same factor. Measure after the deploy: context p50 and
cost per request of workers and leads, the spike count per day.

### Second cost source: a restart storm (05:30 UTC)

MEASURED (chat audit, and `delivery_events` read-only from the portal database): 87 automatic session restarts with why `mcp` in three
hours, about 30 an hour, every live lead and worker restarted 3 to 6 times. 11 of the 13 deliveries into the workspace in that time were
the pool `claudepilot-context-pack` (T-292 slice 2): every push to integration that changes `docs/context-pack.md` made a new revision
(30 today), each delivery marked every live session's config as changed, and the portal restarted them all at the next boundary. A restart
re-reads the whole context and writes it to the prompt cache again; Konfersi and Event sessions restarted for ClaudePilot's pack. One
example: the ClaudePilot lead's 11 USD turn at 05:18 included such a restart.

Done: the pool is off the workspace (05:29); ClaudePilot sessions read `docs/context-pack.md` themselves. T-472: context-only deliveries
never restart (Claude Code re-reads managed instructions), the rest debounced, the pack scoped to its own repository. Measure: restarts with
why `mcp` per hour, before and after.
