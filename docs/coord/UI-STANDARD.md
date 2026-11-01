# UI standard

The one way the portal, the Admin console and the reporter panel look and behave (owner, 2026-11-01: "UI/UX should be consistent,
standardized"). QA-STANDARDS A1-A10 say how it is checked; `docs/prd/ui-layout.md` records why and what is built. Guards:
`apps/web/src/components/uiStandard.test.ts` (shared components only), `apps/web/src/features/ci/focusRing.test.ts` (focus),
`tools/qa/nav-tabs.mjs` (tabs, frame, bounded lists in a real browser).

## 0. Tokens, in one place

Colour, radius, type, spacing and motion come from `@isnanme/tokens` (Tailwind theme and `tailwind.css` utilities: `press`, `skeleton`,
`no-scrollbar`, the `tap:` variant). Screen edges are `--safe-*` and `--bar-*` in `apps/web/src/index.css` (zero on a desktop). Motion:
120-250 ms, the kit's `ease` and `spring`, transform and opacity only, `MotionConfig reducedMotion="user"`. Layers: page 0, sticky bars
20, side bar and dock 30-40, menus and sheets 50, skip link 70. No ad hoc colours, radii or durations.

## 1. Layout and scrolling

| | Phone (< 640) | Tablet (640-1023) | Desktop (1024+) |
| --- | --- | --- | --- |
| Frame | top bar + floating tab bar | icon rail | side bar fixed, dock fixed |
| Scrolls | the document (pinned: `lib/viewport.ts`, `scrollGuard`, `sheetDrag`) | the document | ONLY the content pane (`#main-scroll`; the console's `#console-pane`) |
| Width | full | full | full between side bar and dock; no centred column |
| Safe area | `--safe-*` | `--safe-*` | none |

- Code that scrolls the page calls `scrollPageTo` / `pageScrollTop` (`lib/pane.ts`), never `window.scrollTo`.
- No page makes its own page-level scroll container (`<main>` that scrolls, a full-height box that scrolls).

## 2. Tabs

A page of several sections: `PageHeader`, then the shared `TabBar` (pill tabs, sticky, scrolls sideways inside itself, 44 px, arrow keys,
Home/End), ONE section at a time.

- Portal: `RoutedTabs` (each tab a sub-route, first tab at the page's path, legacy `?tab=` moves to the path, `adminOnly`/`hidden` tabs).
- Console and reporter panel: `TabBar` with local state (no router).
- No stacked sections, side lists or section pickers inside a page. A dialog that switches views uses the kit's `Segmented`.

## 3. Headers

`PageHeader`: a title of one or two words, what the page is for in its InfoTip, the page's one primary action on the right. Inside a hub tab
the header turns slim. No org or context label above a title (the side bar names the context).

## 4. Lists

- A list inside a card or section: `BoundedBody` (desktop: scrolls inside up to `min(32rem, 60dvh)` or its tile, fades at an edge with more
  behind it; phone: the first part and Show all, or a link to the full page).
- Home: equal-height tiles in as many 22 rem columns as fit; each tile's body is a `BoundedBody fill`.
- A full-page list is THE `WindowedList` (`components/WindowedList.tsx`, `lib/windowed.ts`; kit-free, the console uses it too): on a desktop
  it fills the content pane under its filters (`header`) and scrolls inside, so the pane never grows; on a phone the document scrolls, the
  filters stick under the top bar (unless they are too tall: the console's Audit). Only the rows in view (and a few more) are drawn, measured
  once drawn; the next page loads as the end comes into view (a More button only after a failed load); arrow keys, Home, End, PageUp and
  PageDown move between rows; rows are `listitem`s with their place in the set. In use: Tickets (list view), Agents (list view), Needs you
  (list view), Notifications Inbox, CI runs, the console's Users, Orgs and Audit. `tools/qa/windowed-lists.mjs` checks them with about 200
  items each.
- Master-detail (the console's Users and Orgs, `MasterDetail` + `DetailPanel`): on a desktop the detail opens beside the list, a panel of
  the pane's height that scrolls inside; on a phone it is a sheet.
- Rows: 44 px or taller, text that breaks anywhere (`[overflow-wrap:anywhere]`), `min-w-0` on every text child, lists hold still.

## 5. Sheets and dialogs

Portal pages: the kit's `Dialog` (a bottom sheet on a phone, header not a drag handle), `FormDialog`, `ConfirmDialog`. The two small
bundles (the console and the reporter panel) share the kit-free `components/Sheet.tsx` (`sheet`: bottom on a phone, centred from 640 px;
`bottom`; `page`: the whole frame), and the console's `Confirm` on top of it. Confirm only what destroys or removes a protection; everything else just applies and says so in a toast. Escape closes the
top one; focus returns to what opened it.

## 6. Forms

A label, the field, its error under it. 44 px controls (`h-11`/`h-12`), `text-base` inputs on a phone (no zoom). A setting row is a label,
an InfoTip and the control, nothing else (`SettingRow`, Settings' rows).

## 7. Feedback states

Loading is a skeleton, never a long spinner. Empty says so in a few words (`EmptyState`). An error says what failed and offers Retry
(`LoadError`). Unavailable data is a state, never a guess. Success is a toast. A step-up asks once and runs the action it interrupted
when it succeeds (the console's `run` and `StepUp`): the password inline, or the console's OIDC provider in a POPUP window that comes back
with `?oidc=stepped&popup=1`, tells the console (window.opener and the `pilot-admin-step-up` BroadcastChannel; the console also asks the
server whether the session is fresh every 2.5 s while it waits) and closes. Never "do it again". A blocked popup falls back to the full
navigation, which cannot resume.

## 8. Text diet and accessibility

Titles of one or two words, explanations in an InfoTip, icon-only on a phone with an accessible name. Focus is always visible
(`outline-hidden` plus a ring, never `outline-none` on a control). WCAG AA contrast, light and dark, keyboard and touch.

## 9. Not migrated yet

Listed in `uiStandard.test.ts` (the lists may only shrink): the browser app view's tabs, the reporter's evidence tabs; dialogs by role
(account menu, popovers, the switcher, viewers, the reporter's annotator and image viewer). Not windowed yet: the Tickets board and
timeline, the Agents tree view (their own layouts). Older QA harnesses that count every session row (`session-crew.mjs`, `crew-tree.mjs`,
`session-density.mjs`, `session-limits.mjs`) see only the drawn window now and need to scroll the list or read the set size.
