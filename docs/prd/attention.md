# Needs you (attention)

Draft v0.1 · T-146 slice 1 · Owner: the portal's one person (multi-user later, T-118).

One place that lists everything that waits for a person, from every module, and opens the exact thing in one tap. By the charter (D-10,
D-34) only REQUIRED items appear: production or uat, secrets and permissions, code from outside, a gate only a person may pass, a question an
agent asked a person. An optional check never does.

Slice 1 (this document's "built") is the registry, its first five sources, the aggregate call, the page and the badges. Slice 2 is the swipe
deck, the Home widget, notifications and the Portal MCP tool (see §7).

## 1. The registry (built)

`apps/server/src/attention/registry.ts`. A **source** is one file next to the module that owns the waiting thing:

```ts
interface AttentionSource {
  kind: AttentionKind;
  list(actor: Actor, now: number): AttentionItem[]; // one read of the module's state; only what `actor` may decide
}
```

An **item** (`packages/contracts/src/attention.ts`): `kind`, `id`, `title` (what), `who` (the session, the ticket or the token that asked,
each with a link or none), `why` (the class: `production_uat`, `secrets_permissions`, `third_party_code`, `gate`, `question`), `risk` (one
line of names and facts, never a secret value), `since`, `link` (the exact item, the version preselected, never a list) and `action` (the
module's own route that decides it: a POST path, or `SOCKET` for the chat).

- **Read only.** The registry decides nothing. `action` names the module's route for the deck to call later; the page only links. Each
  module's approve route keeps its own checks (the MCP catalog's "I reviewed it", the skill review's acknowledgements, CI's person-only
  approval, the chat's whole-text rule).
- **Authorization.** Each source filters through its module's own `can()`; a denied item is absent and not counted, the same as a missing one.
  `GET /api/attention` is declared `signed-in` in `attention/authz.ts`.
- **One query per source.** Each source runs one SELECT (session titles joined in), so the aggregate is five queries whatever the number of
  items (a test counts the `prepare` calls).
- **Unavailable is a state.** A source that throws gives `counts[kind] = null` and its kind in `unavailable`; the page says "Unavailable:
  Tickets", never 0.
- **Order.** Grouped by class in the order above, then the oldest first.

## 2. The first sources (built)

| Kind | Source file | What waits | Class | Risk line | Who decides |
| --- | --- | --- | --- | --- | --- |
| `mcp_version` | `mcp/attention.ts` | a catalog version an agent or a token PROPOSED, still `draft` (the catalog's "to review" count); a person's own manual draft is not listed | third-party code | kind · host or package · private network yes/no (remote) · install scripts (npm) · secret slot NAMES | manage on the `mcp_entry` |
| `skill_version` | `skills/attention.ts` | a version whose tree hash has no decision (`needs_review`), uploads and agent proposals alike | third-party code | scan risk · scripts or text only · network · hooks · pre-allowed tools · findings | manage on the `skill_version` |
| `ci_deploy` | `ci/attention.ts` | a deployment `waiting` for approval in a running run (CI FR41) | production or uat | environment · the jobs before it and how they ended (the gate) · pipeline, ref and commit · the auto-approve rule's dry verdict | a person with manage on the run (tokens and agents never see it, as they never approve) |
| `ticket_approval` | `tickets/attention.ts` | an open ticket of type `approval` assigned to a person | question | priority · workspace | a person with operate on the ticket |
| `tool_approval` | `chat/attention.ts` | a tool request a `waiting` session has held for 10 minutes or more (T-256 item 4); a fresh one stays the session's own card | gate | the tool · the workspace | operate on the session |

Not a source in slice 1: pool revisions in `waiting_review` (they follow from unapproved versions), settings an agent proposed (T-138),
stg PRs (T-116), the login queue (T-140), Bypass acknowledgements. Each is one file and one line in `attention/index.ts`.

## 3. Changes and the event (built)

`index.ts` calls `attention.changed()` when the modules it reads publish their own live topics (`pools` for the MCP catalog and skills,
`tickets`, `ci`) and on the chat controller's request and state events; a minute's tick re-reads so a tool request crossing ten minutes
appears without another event. A change is debounced (300 ms), read as the system, compared with the last read, and on a difference the
registry emits ONE `attention.changed` event (`added` and `resolved`, each `{kind, id}`, never the text; `total`) and publishes the live topic
`attention`. The first read at start-up is the baseline and emits nothing.

The event goes to the registry's own listeners, not the platform notify bus: a kind on that bus is a notification (matrix, templates,
delivery), which is slice 2's (T-126 owns the shape).

## 4. The page (built)

`/admin/attention`, "Needs you" (the explanation in the ⓘ). One row anatomy: the kind's icon, the title (a link to the item), the why chip,
who asked (links), the age (`12m`, `3h`), the risk line, and the primary action (an arrow; with its label from 640 px, icon only on a phone)
that opens the exact item: the MCP entry with `?version=<id>` (the entry page opens, rings and scrolls to that version), the skill's review
page, the CI run with `?job=`, the ticket, the session. Grouped by class with a count and an ⓘ each, a filter by kind with counts (shown when
there are two kinds or more), "Nothing needs you" when empty, "Unavailable: …" for a source that could not be read, "N of M shown" past the
page. Rows hold still under the pointer or focus (QA A9, the glance's `useSteadyRows`): a row resolved meanwhile stays dimmed and inert until
you let go.

One request (`GET /api/attention?limit=200`) feeds the page, the nav badge and the icon; it is read again on each `attention` push, and once a
minute only while the live socket is down.

## 5. The badges (built)

- **Nav:** the Needs you item carries the total (99+). It sits in More on a phone (the bar keeps its five places until the deck takes one),
  so the More button carries the same number.
- **App icon:** the glance's Needs attention already counts every open tool request, the waiting deploys and the tickets assigned to a person
  (a superset of three of the five kinds here), so Needs you adds only the MCP and skill versions waiting: each thing is counted once. The
  glance's count also includes failed CI runs, which are not required (D-34); that is the glance's, left for slice 2 to settle.

## 6. Observed

Tests (`apps/server/src/attention/attention.test.ts`, `apps/web/src/features/attention/model.test.ts`): per source, a denial hides the item
and its count, the count equals the list, a decided item leaves the list and emits exactly one event; no secret slot value reaches an item;
the aggregate is five queries for 25 items; grouping, paging, the kind filter and "unavailable"; the route is signed-in only and refuses an
unknown kind.

Browser (`tools/qa/attention.mjs`, a scratch portal in a cluster Job, Chromium with touch at 390 px and 1280 px, light and dark): see §8.
Not observed in a browser: the CI deploy and tool approval rows (they need a runner and a live Claude; the tests cover them), a real iPhone.

## 7. Slice 2 (not built)

The swipe deck (the owner's main way in; `blocking` per item, the second step for high-risk classes, undo, reasons, batch), the Home widget,
notifications (bridge `attention.changed` to the notify bus once, with T-126's shape), the Portal MCP `attention_list` (read only), a bar
place on the phone, "explain what disappeared" (approved by X, revoked, expired), the corner banners (Pools, Skills, CI), filter by program
(T-137), and the sources listed in §2 as not yet built.

## 8. QA record

2026-10-14, Job `claudepilot-job-f31dff92` on commit eb732df: 45 of 45 checks passed. A clean portal lists nothing and the page says
"Nothing needs you"; an approval ticket, a skill upload and an MCP proposal made over the Portal MCP (an admin token, never printed) appear
on an open page without a reload (the live topic); the API counts one of each and the total equals the rows; rows grouped Outside code then
Question; no sideways scroll, every control named, 44 px targets and an icon-only action at 390 px; the More button (390) and the nav item
(1280) carry the count; the kind filter keeps one kind; the MCP row lands on its entry with that version marked, the ticket and skill rows on
their pages; closing the ticket takes its item off. Tests, Job `claudepilot-job-de08acdd`: typecheck (server, web, contracts) clean, web 434
of 434, server areas (attention, mcp, skills, ci, tickets, glance, live, portal) 255 passed, 0 failed, 1 skipped (Docker-only).
