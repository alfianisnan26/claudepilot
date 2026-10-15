# List paging audit (T-382)

Date 2026-10-15. Read-only audit of every list route and Portal MCP list tool found by name, handler and SQL (53 checked; the full GET
surface was not enumerated, so treat the counts as the verified set). Standard it is measured against: D-58.

## Counts

| Kind | HTTP | MCP | Total |
| --- | --- | --- | --- |
| Cursor | 10 | 11 | 21 |
| Offset | 3 | 0 | 3 |
| Limit only (no next page) | 6 | 5 | 11 |
| Unbounded | 16 | 2 | 18 |

Of the 21 cursor routes, 11 are true keyset cursors (`before`/`after` on an id, a time or a seq, e.g. `notify/history.ts:124-150`,
`connect/store.ts:490-492`, `autotransfer/store.ts:258-266`, `repos/store.ts:290`); 10 are offsets inside an HMAC cursor
(`portalmcp/paging.ts:5-11`), seven of which reload the whole source on every call (`paging.ts:66-73`). Server-side caps hold on most
routes (`paging.ts:11` 100, `ci/store.ts:308` 200, `platform/audit.ts:89` 500, `notify/history.ts:127` 200, `tickets/service.ts:605` 500).

## The ones that matter most

| Route or tool | Where | Kind | Size in real use |
| --- | --- | --- | --- |
| GET `/api/chat/sessions` | `chat/store.ts:456-467`, `chat/routes.ts:58` | unbounded, refetched every 5 s (`useChatSocket.ts:494`) | 506 sessions = 406 KB (QA-018); pilot today 82 = 96 KB |
| GET `/api/chat/:id/events?after=` | `chat/store.ts:704`, `chat/routes.ts:169` | unbounded from a seq | 25k events = about 8 MB (QA-017) |
| GET `/api/tickets` | `tickets/service.ts:603-609` | offset, 100/500; the web asks 300 with no next page (`tickets/labels.ts:86`) | 374 KB per 100 with full descriptions (pilot today) |
| GET `/api/attention` | `attention/registry.ts:126-136` | offset after building the full list in memory | grows with open items |
| GET `/api/knowledge/vaults/:id/search` | `knowledge/service.ts:645-653` | offset 20, the web shows no more (`SearchPane.tsx:93`) | grows with the vault |
| GET `/api/chat/audit`, `/api/settings/audit`, `/api/notify/log`, `/api/usagespend/audit`, `/api/lab/slices` | `chat/store.ts:1392-1402`, `settings/store.ts:118`, `notify/history.ts:194-197`, `usagespend/service.ts:750-754`, `lab/routes.ts:60` | limit only | grow with use |
| GET `/api/workspaces`, `/api/repos`, `/api/triggers`, `/api/accounts`, `/api/pools/:type`, `/api/mcp/catalog`, `/api/mcp/builtin`, `/api/connect/targets`, `/api/knowledge/vaults`, `/api/skills/library`, `/api/personas/proposals`, `/api/personas/pools/:id/revisions`, `/api/secrets/:pool/rotations`, `/api/portalmcp/agents` | `app.ts:565,659,695`, `repos/routes.ts:38`, `triggers/routes.ts:102`, `pools/routes.ts:66`, `mcp/routes.ts:33`, `mcp/builtin/routes.ts:22`, `connect/routes.ts:62`, `knowledge/routes.ts:97`, `skills/routes.ts:36`, `personas/index.ts:222,233`, `secrets/adminRoutes.ts:18`, `portalmcp/routes.ts:105` | unbounded (route passes no limit) | revisions, rotations, proposals grow |
| MCP `account_list`, `account_pool_list`, `pool_list`, `mcp_catalog_list`, `session_list`, `workspace_list`, `repos_list` | `portalmcp/tools/*.ts`, `repos/portalTools.ts:128` | cursor shape, full load per call (`session_list` loads `chat.list()` whole, `portalmcp/tools/sessions.ts:105`) | as the source |
| MCP `attention_list`, `ci_runs_list`, `trigger_runs`, `skill_proposals_list`, `repos_attention` | `attention/portalTools.ts:41-58`, `ci/portalTools.ts:77-106`, `triggers/portalTools.ts:45-55`, `skills/portalTools.ts:94-102`, `repos/portalTools.ts:201-220` | limit only, no cursor | page 2 unreachable |
| MCP `trigger_list`, `mcp_builtin_list` | `triggers/portalTools.ts:15-25`, `portalmcp/tools/builtin.ts:16-24` | unbounded | low today |

No response is compressed (measured on pilot by the coordinator, T-382).

## Web

- Load more exists on two screens only: the notifications inbox (`notify/InboxTab.tsx:67-71`, 30 per page) and the repos timeline
  (`repos/Timeline.tsx:47-51`, 20 per page). Each `loadMore` is hand-written; there is no shared hook and no `Page<T>` in contracts (three
  page shapes: `contracts/notify.ts:373-376`, `contracts/repos.ts:348-351`, `contracts/triggers.ts:306-309`).
- Fixed one-shot limits with no next page: tickets 300, CI runs 100 (`ci/RunsTab.tsx:50`), knowledge search 20, settings audit 50.
- Unpaged: the session list (whole, every 5 s), workspaces (`lib/api.ts:137`), the transcript (`chat/api.ts:101`).
- No virtualization (no virtual-list dependency; the chat PRD asks for TanStack Virtual, `docs/prd/chat-sessions.md:806`).

## Performance and load testing today

- `tools/qa/seed-perf.mjs` seeds sessions, events and usage; QA-017/018 were a manual browser run, not a gate (`docs/qa/qa-report.md:145-158`).
- No load tool (autocannon, k6, artillery) in the repo; no route test asks for a huge `limit` and checks the clamp; no web test covers load more.
- Written bars that are not enforced yet: QA-STANDARDS B1 (big session list, paging or virtualisation), B2 (p50/p95 per key endpoint,
  EXPLAIN and indexes), C (re-runnable gate scripts under `tools/qa/`); Portal MCP FR9 (cursor + limit, 25 default, 100 max: MCP only);
  roadmap item 5 (paging, archive: not built).

## Slices proposed on T-382

1. Contracts `Page<T>` (`items`, `next`) and one keyset cursor helper on the server (opaque, signed, sort key + id), with a test that walks
   every list route with a huge `limit` and checks the clamp and the `next` chain.
2. Chat sessions and events on keyset paging (T-376 for the transcript), the web windowed (TanStack Virtual).
3. The other unbounded and limit-only routes and MCP tools; filter before paging (Authorization FR18).
4. One shared infinite-list hook on the web (load more on scroll, holds still per QA A-bars) for every list screen.
5. Response compression; a load test under `tools/qa/` (seed at 10x, p50/p95 per list route, payload size) as a gate step with budgets in
   QA-STANDARDS B2 (T-378 is the at-scale fixture).
