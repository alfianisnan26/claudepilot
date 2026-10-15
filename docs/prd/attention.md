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
- **One query per source.** Each source runs one SELECT (session titles joined in), so the aggregate is one query per source (seven) plus
  one for the person's Later, whatever the number of items (a test counts the `prepare` calls).
- **Unavailable is a state.** A source that throws gives `counts[kind] = null` and its kind in `unavailable`; the page says "Unavailable:
  Tickets", never 0.
- **Order.** Grouped by class in the order above, then the oldest first.

## 2. The first sources (built)

| Kind | Source file | What waits | Class | Risk line | Who decides |
| --- | --- | --- | --- | --- | --- |
| `mcp_version` | `mcp/attention.ts` | a catalog version an agent or a token PROPOSED, still `draft` (the catalog's "to review" count); a person's own manual draft is not listed | third-party code | kind · host or package · private network yes/no (remote) · install scripts (npm) · secret slot NAMES | manage on the `mcp_entry` |
| `skill_version` | `skills/attention.ts` | a version whose tree hash has no decision (`needs_review`), uploads and agent proposals alike | third-party code | scan risk · scripts or text only · network · hooks · pre-allowed tools · findings | manage on the `skill_version` |
| `ci_deploy` | `ci/attention.ts` | a deployment `waiting` for approval in a running run (CI FR41) | production or uat | environment · the jobs before it and how they ended (the gate) · pipeline, ref and commit · the auto-approve rule's dry verdict | a person with manage on the run (tokens and agents never see it, as they never approve) |
| `ticket_approval` | `tickets/attention.ts` | an open ticket of type `approval` assigned to a person, and an open ticket tagged `owner-checklist` whatever its type or assignee (the owner's checklist, T-509; its action reads "Reply" instead of "Decide") | question | priority · workspace | a person with operate on the ticket |
| `tool_approval` | `chat/attention.ts` | a request a session's live process has held for 10 minutes or more while its turn runs (`waiting`, or `working` with a second request still open; T-256 item 4, T-284 item 4); a fresh one stays the session's own card; a request of a process that is gone is not listed (it is resolved `stale`, chat-sessions FR25b) | gate | the tool · the workspace | operate on the session |
| `keepgoing_down` | `keepgoing/attention.ts` | a chat with Keep going on that the sweep reported left down (the cap, a refused start, still ended 15 minutes after it ended; T-257 item 1) and that has not run again; it goes when the chat runs (the next look clears the report). Announced by Keep going's own `keepgoing_attention` notification, so the bridge stays quiet | question | ended · the workspace | operate on the session |

| `persona_proposal` | `personas/attention.ts` | a session's `pending` proposal to change its own persona: instructions (never auto-approved), or a name or avatar the persona's switch did not let through (Persona PRD I11; slice 3) | gate | what changes · its size (`adds 120 chars, 2 replacements`, never the text) · the revision it was made against · the workspace | a person with manage on the persona |
| `ci_upstream` | `ci/upstreamAttention.ts` | a pilot remote's branch that diverged from the upstream it follows; the sync leaves it untouched (CI FR8a, T-486); it goes once the branches agree again | question | pilot sha · upstream sha · upstream host | a person with operate on the remote (action: Sync now) |

Not a source yet: pool revisions in `waiting_review` (they follow from unapproved versions), Bypass acknowledgements, and three that do
not exist in the code yet: settings an agent proposed (T-138), stg PRs (T-116), the login queue (T-140). Each is one file and one line in
`attention/index.ts`.

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

## 7. Slice 2 (built): the deck, Later, Home's Review card, notifications, `attention_list`

- **The deck** is the page's way in (`/admin/attention`; the list is `?view=list`, a Deck/List switch at the top). One card per item that is
  not put off, in the registry's order (why, then the oldest); the card shows what, the kind, why (a chip with its InfoTip), how long it has
  waited, the risk line and who asked. **Right** (a swipe, the right arrow on the focused card, or the action button named by the item:
  Review, Approve, Answer) opens the item's own page, where its module decides it with its own checks: the deck never approves by itself, so
  no swipe is ever the only guard of a high-risk approval. **Left** (a swipe, the left arrow, or Later) puts it off for an hour. Previous and
  Next move without deciding; "1 of N" says where you are. `?item=<kind>:<id>` opens the deck at that card (a push, the Home card).
- **Gestures:** the card follows the finger sideways only (`touch-action: pan-y`; a mostly vertical drag is a scroll and decides nothing), a
  drag shorter than a third of the card's width (72 to 140 px) snaps back, and a hint at the card's foot says what letting go would do.
  Motion is transform and opacity only, about 180 ms, none with reduced motion. The deck is not in a sheet (no drag handle question) and the
  page keeps its no-rubber-band rule. Targets are 44 px or more (Later and the action 48 px).
- **Later** is the person's own (migration 860, `attention_snoozes`: the registry keeps no item rows): `POST /api/attention/snooze`
  `{ kind, id, minutes? }` (60 by default, 0 brings it back, at most a day), only for an item the person sees now (anything else is the same
  404 as a missing one; tokens and agents never snooze). A put-off item still waits and is still counted; the list marks it ("Later, until
  07:54"), the deck lists it under Later with the time it returns and a Back now button, and it is back in the deck by itself at that time.
  The person's list reads their snoozes with one query (the aggregate is the sources' queries plus that one).
- **Home's Review card** (glance widget `review`, on Home only until switched on for the strips): a figure per source the server has (`-` for
  one that could not be read, never a guessed zero) and the newest item, whose tap opens the deck at its card; Open deck opens the page.
  It adds nothing to the app icon (that count is the glance's plus MCP and skill versions, as in §5).
- **Notifications:** a NEW item tells each person whose own read lists it, once (the registry's first read is the baseline, so a restart
  announces nothing again; the bridge remembers what it sent, so an item that is resolved and comes back is not sent twice). Kind `attention`
  ("Needs you", a row in the notification matrix; migration 861 adds it to destinations that hear `human_request`). It goes out only for the
  kinds nothing else announces (MCP and skill versions): a stuck tool approval, a deploy that waits and a ticket for a person already have
  `approval`, `ci_waiting` and `human_request`. The body is fixed words (kind and why); the item's title is agent text and travels only as
  the untrusted detail. The tap opens `/admin/attention?item=<kind>:<id>`. Quiet hours, mutes, collapse and the cap are the pipeline's.
- **`attention_list` (Portal MCP, read only):** short rows by default (item, kind, why, title labelled untrusted, since, the deck link),
  `full: true` adds who asked, the risk and the item's page; `item: "<kind>:<id>"` returns one. It reads the registry with the token's own
  actor, so it sees what that actor may decide: an agent sees its own session's stuck approvals (not another session's, not a deploy or an
  approval ticket, which are a person's); one it does not see is the same NOT_FOUND as one that does not exist. It approves nothing.

## 7a. Slice 3 (built): persona proposals, and the "see" view for the coordinator

- **Persona proposals** are a source (§2). The item's link is `/admin/pools?tab=personas&proposal=<id>`: the Personas tab opens its
  Proposals dialog with that proposal ringed (`aria-current`) and scrolled into view, also when it was decided meanwhile (the dialog then
  says "Nothing to review"); closing it drops `?proposal=`. Nothing else announces a proposal, so the notify bridge sends `attention` for it.
  `persona_propose_update` and `persona_set_avatar_proposal` return, for a proposal still waiting, `link`: the Needs you card
  (`/admin/attention?item=persona_proposal:<id>`) the agent gives on its ticket.
- **`attention_list` scope** (decided on the ticket by the written defaults): `decide` (default, as before) lists what the caller may
  decide; `see` lists what it may VIEW through the same module `can()` (view on the run, the ticket, the entry, the version, the session,
  the persona), with the person-only filter of deploys and approval tickets lifted for reading. So the coordinator's token sees the deploy
  held for approval or the approval ticket that blocks it and can say so on its ticket, without a person sending a link. Why it is safe: it
  shows nothing the module's own read tools (`ci_run_get`, `ticket_get`, ...) would not; an agent stays boxed to its own session (another
  session's tool approval is still absent and uncounted); the registry stays read only and the decide routes keep refusing tokens and
  agents. The HTTP page, the badge, Later and the notifications keep `decide`. The summary names the scope; an empty `decide` view says
  that `see` exists.

Not built (later slices): `blocking` per item and ordering by it, the second step and undo for high-risk approvals done in the deck itself,
reject reasons, batch review, "Ask the agent", a bar place on the phone, "explain what disappeared", the corner banners (Pools, Skills, CI),
the program filter (T-137), and the sources of §2 not yet built.

## 8. QA record

2026-10-14, Job `claudepilot-job-f31dff92` on commit eb732df: 45 of 45 checks passed. A clean portal lists nothing and the page says
"Nothing needs you"; an approval ticket, a skill upload and an MCP proposal made over the Portal MCP (an admin token, never printed) appear
on an open page without a reload (the live topic); the API counts one of each and the total equals the rows; rows grouped Outside code then
Question; no sideways scroll, every control named, 44 px targets and an icon-only action at 390 px; the More button (390) and the nav item
(1280) carry the count; the kind filter keeps one kind; the MCP row lands on its entry with that version marked, the ticket and skill rows on
their pages; closing the ticket takes its item off. Tests, Job `claudepilot-job-de08acdd`: typecheck (server, web, contracts) clean, web 434
of 434, server areas (attention, mcp, skills, ci, tickets, glance, live, portal) 255 passed, 0 failed, 1 skipped (Docker-only).

2026-10-14, slice 2, Job `claudepilot-job-f7023021` on commit e50463d: `tools/qa/attention.mjs` 101 of 101 checks passed (slice 1's
journey on `?view=list`, plus the deck at 390 px with touch and 1280 px, light and dark): the deck opens at the first item and says "1 of 3";
the card shows what, why with its InfoTip and the age, `touch-action: pan-y`; no sideways scroll, every control named, the page does not
rubber-band, 44 px targets at 390 px; a 60 px swipe snaps back and a vertical drag decides nothing; mid-swipe the card follows the finger; a
swipe left puts the item off for 59 to 60 minutes, it is still counted, the next card takes its place, Later lists it with its time and the
list marks it; Back now returns it; `?item=` opens at that card and a swipe right opens the ticket's page; at 1280 px the left arrow puts a
card off and the right arrow opens its page; Home's Review card counts MCP 1, Skills 1, Tickets 1 and its newest item opens the deck at that
card. Screenshots looked at: deck, mid-swipe, Later, list with Later, Review (390 and 1280, light and dark). Tests, Job
`claudepilot-job-16da5cc4` on b81b497: typecheck (server, web, contracts) clean; server attention, notify, store, portalmcp tools 124 of 124;
web 458 of 458.
