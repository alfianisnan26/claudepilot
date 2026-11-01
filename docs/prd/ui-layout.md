# UI layout and scrolling

Status: v0.2: v0.1 built on `feat/nav-tabs`, windowed full-page lists on `feat/ui-standard-2` (owner requests 2026-11-01). One layout system for every page of the main web app, so a page
never solves scrolling on its own.

## 1. The frame

| Width | What scrolls | Chrome |
| --- | --- | --- |
| Phone (< 640 px) | The document, pinned (`lib/viewport.ts`, `scrollGuard`, `sheetDrag`; no rubber-band) | Top bar (pilot logo, glance chips, account), floating tab bar |
| Tablet (640 to 1023 px) | The document | Icon rail on the left |
| Desktop (1024 px and up) | Only the content pane `#main-scroll` (`lib/pane.ts`); the document never scrolls | Side bar fixed (logo on top, nav, context switcher, account), dock fixed on the right |

- Desktop content uses the full width between the side bar and the dock: no centred column, no fixed `max-w` container. Each page
  decides its own grid (Home: tiles of at least 22 rem, as many columns as fit).
- No safe-area insets on a desktop: from 1024 px with a fine pointer the `--safe-*` variables are 0 (`index.css`). Phones and tablets
  keep them; code reads `--safe-*`, never `env()`.
- Code that scrolls "the page" uses `scrollPageTo` / `pageScrollTop` (`lib/pane.ts`), never `window.scrollTo`.

## 2. Pages of several sections: tabs

The standard is the Usage page's pattern (`components/RoutedTabs.tsx`, `lib/routedTabs.ts`):

- Title, then a sticky bar of pill tabs; ONE section shows at a time. No stacked sections, no side lists or section pickers inside a page.
- Each tab is a sub-route: the first tab is the page's own path (`/admin/settings`), the others `base/<id>` (`/admin/settings/sessions`).
  Back, forward and deep links work; only the open tab is mounted, so only its data loads.
- A legacy `?tab=<id>` link moves to the sub-route with its other parameters kept (server links and notifications still use it).
- A tab can be `adminOnly` (a member never sees it, and its path sends them to the first tab) or `hidden`.
- The bar scrolls sideways inside itself when the tabs do not fit; the page never scrolls sideways. 44 px tabs, arrow keys, Home and End.
- The app frame does not remount a page between its tabs (`pageKey`).

Pages: Settings (General, Agents, Sessions, Claude Code, People, Glance), Org settings (General, Members, Teams, Invitations, Objects,
Access, Sign-in, Policies, Audit, Danger zone, by role), Profile (Account, Sign-in, Orgs, Tokens, Preferences), Pools (one per pool
type), Usage, CI (Runs, Remotes, Runners), Access (Sign-in, MCP), Notifications (Inbox, Setup). The workspace sheet shows Claudes,
Details and Repos one at a time (a dialog, so a segmented switch, not routes).

## 3. Lists that grow

A list inside a card or section never pushes the page taller and taller (`components/BoundedBody.tsx`, `lib/bounded.ts`):

- Desktop: the list has a height bound (`min(32rem, 60dvh)`, or the tile's height on Home) and scrolls inside itself, with a soft fade at
  an edge only when there is more behind it.
- Phone: the page is the one scroll container, so the list shows its first part (about six rows, 22 rem) and "Show all" (or a link to the
  full page when the card has one).
- Home: a grid of tiles of one height (two rows fill the pane); each tile's content scrolls inside.

In use: Home tiles, Org Members, Teams, Objects and Audit, Settings > People > Shared agents.

### 3a. Full-page lists: windowed (v0.2, `feat/ui-standard-2`)

A page that IS a list (Tickets list view, Agents list view, Needs you list view, the Notifications Inbox, CI runs; the Admin console's
Users, Orgs and Audit) draws it through one `WindowedList` (`components/WindowedList.tsx`, `lib/windowed.ts`):

- Desktop: the list fills the content pane under its filters and scrolls inside it; the pane never grows (the frame's bottom padding drops
  to 1 rem on such a page). Inside a Workbench panel (Tickets) it fills the panel instead.
- Phone: the document is the one scroll container; the filters stick under the top bar; the list is windowed against the document.
- Only the rows in view and a few more are in the page (measured once drawn, estimated before); a wide pane shows rows in columns
  (Tickets). The next page loads as the end comes into view; after a failed load a More button asks again.
- Keyboard: arrow keys, Home, End, PageUp, PageDown move between rows; rows are `listitem`s with `aria-posinset` and `aria-setsize`.
- Checked by `tools/qa/windowed-lists.mjs` (about 200 items per list, 390, 1280 and 1584 px, light and dark) and `tools/qa/admin-console.mjs`.

## 4. Glance dock

On a desktop the dock auto-hides behind a handle on the right edge (a dot when something waits on the person). Hovering the edge for
250 ms, focusing or tapping the handle slides the panel in over the page; it slides out 600 ms after the pointer leaves, on a tap outside
or Esc. Pin (kept per person in the glance settings) docks it as a column of its own from 1280 px, which never covers the content.

## 5. Not yet

- The Tickets board and timeline and the Agents tree view keep their own layouts (the board's columns already scroll inside on a desktop);
  they are not windowed.
- Remaining cards with growable lists outside the ones in §3 (session lists in Claudes, CI remotes, quota rows) adopt `BoundedBody` one
  by one.
