# PRD: Web app & PWA

| | |
| --- | --- |
| Status | **Draft v0.7.** Written from the codebase, the pay reference app, the sibling PRDs and platform docs (MDN, web.dev, WebKit, Chrome, Cloudflare, RFC 8030, the Push API draft), checked 2026-10-10, then revised after review. v0.6 is a consistency pass: Chat A2 and Browser & desktop A11 applied. v0.7 (2026-10-12, platform track, the owner's notification ask) rewrites §11 in place: the owner's six events, channels beyond Web Push (a signed webhook, Discord, Slack), per-destination preferences, quiet hours, answering from a notification (which v0.6 had ruled out; §11.7 resolves it), push keys sealed at rest; §10.3, §15, §16, §17, §19 and §20 follow. Round 4 (2026-10-12, glance widgets) built the manifest shortcuts and an app badge written by the page (§10.1, §17 W4, A-table; [Glance widgets](glance-widgets.md) §11). ✅ = checked here, 📄 = documented, 🔬 = unverified: needs a check on real devices or behind the real tunnel before it becomes an acceptance criterion. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Pools foundation](foundation-pools.md) F1 (storage and encryption, built), [Portal MCP server](portal-mcp.md) MCP1 (persisted server code, listeners, tunnel) |
| Related | [Identity and onboarding](identity-onboarding.md) and [Multi-user](multi-user.md) (replace §12's server code with accounts), [Platform roadmap](platform-roadmap.md) (the phases and the owner's decisions), [Triggers](triggers.md), [Auto transfer](auto-transfer.md), [Chat sessions](chat-sessions.md), [Monitoring dashboard](monitoring-dashboard.md), [Settings & policies](settings-policies.md), [Account Pool](account-pool.md), the [Skillset](skillset-pool.md), [Persona](persona-pool.md), [MCP set](mcpset-pool.md) and [Secrets & env](secrets-env-pool.md) pools; [Browser & desktop pool](browser-desktop-pool.md) (its live view, §2) |

## 1. Summary

The portal becomes one React web app for phones, tablets and desktops, installable as a PWA. This PRD
sets what every page builds on: navigation, layouts per screen size, the app shell, install, the service
worker, push, HTTPS, lasting sign-in, budgets and shared components. On phones a tab bar holds Sessions,
Workspaces, Monitor, Pools and Menu. Push reaches the devices the admin picks when an agent needs input,
a session fails, or a workspace, account or the portal has a problem, never with transcript text or
secrets. Install and push need HTTPS: a Cloudflare Tunnel publishes a new app listener behind Access.

## 2. Background and problem

- Three pages (Workspaces, Accounts, Access) and a terminal exist. AppShell has pay's frame (phone app
  bar and tab bar, an icon-only 80 px rail from 640 px, a 256 px sidebar from 1024 px), but every NAV
  entry becomes a phone tab, and the PRDs add nine pages.
- Feature PRDs assume pieces nobody owns: `wide` and `immersive` route flags (Chat, Monitoring), a
  Pools hub (Skillset A8), StatusDot and charts (Monitoring), a secret input (Secrets A7), push (Chat A2).
- Plain HTTP on port 3000 rules out service workers, install, push, badges and passkeys off localhost
  (§12.1), and Portal MCP keeps the UI off its tunnel (its A5). Sessions live in memory for 12 h, so
  restarts sign every device out, and one shared code means no action names a device. The build is one
  241 KB gzip chunk that loads xterm (about 88 KB) on every page.
- **Scope** (Q1, answered): the owner wants a "full web frontend … best form in ui ux for both desktop
  size and mobile size (pwa)", which is this PRD. Asked about agent browsers separately, they confirmed
  "for the agent ya, yes it should have both browser and desktop for tooling/mcp", so the
  [Browser & desktop pool](browser-desktop-pool.md) stays, and this app hosts its pages and live view (A1).

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **One app, every size.** Every screen works from a 320 px phone to a wide desktop, in portrait and landscape, with the on-screen keyboard open. No separate mobile site. |
| G2 | **Navigation that scales.** At most five phone tab bar entries; every section (§8) at most two taps from launch. |
| G3 | **Installable.** On Android, iOS and iPadOS, desktop Chrome and Edge, and macOS Safari. The installed app shows its last data within 1.5 s (§13.1). |
| G4 | **Reaches the admin, privately.** Push for what needs the admin, per device, quiet by default. No secret, transcript text or session title in notifications, caches or browser storage. |
| G5 | **Signed in, safely.** Sessions survive restarts, a kept device stays signed in, sensitive actions ask again, devices can be signed out. |
| G6 | **Fast and accessible.** Every budget has a method and a CI gate (§13.1); WCAG 2.2 AA. |

## 4. Non-goals

- Native or wrapped apps (App Store, Play, Capacitor, Trusted Web Activity).
- Offline work beyond the shell and one summary: no offline edits, no stored queued actions (Chat may
  hold one unsent message in memory, A5). No Allow or Deny buttons on the lock screen (§11.3).
- The agents' browsers and desktops themselves ([their pool](browser-desktop-pool.md); this app hosts its
  pages and live view). Email, SMS or Slack alerts; per-user accounts; file handling,
  background sync, widgets; Anthropic or Claude branding (we borrow interaction patterns, not looks).

## 5. Users and stories

**Admin**: runs the portal, often from a phone. **Workspace user**: chats with agents. Often one person.

| ID | Story |
| --- | --- |
| US1 | A notification says "Approval needed · api-dev". I tap it, the app opens on the request, and I allow it. If I already answered on my laptop, it says "Already allowed on MacBook · 14:03". |
| US2 | I add the portal to my iPhone's Home Screen with a three-step guide. Inside it I sign in twice: at the edge with the Access PIN, then with the server code, which my password manager fills. The code sign-in lasts up to 90 days; the app warns 3 days before the monthly edge sign-in ends. |
| US3 | On my phone, Sessions, Workspaces, Monitor and Pools sit in the tab bar. Settings, Access, Notifications and this device's options sit under Menu, one row per tab. |
| US4 | I pick which notifications each device gets and set quiet hours in its time zone. When I lose my phone, I sign it out from my laptop, which stops its notifications. |
| US5 | Before Bypass permissions is allowed or the server code is shown, the app asks for a passkey or the code. |
| US6 | On a bad connection the app shows its last data, says it's offline or reconnecting, and catches up by itself. After an upgrade it offers "Reload" and never reloads a tab where I'm typing. |
| US7 | As the operator, I set up HTTPS with one guide, on the tunnel Portal MCP already uses. |
| US8 | On my phone I open a workspace's terminal. A key row gives me Esc, Tab and the arrows, and the prompt stays above the keyboard in portrait and landscape. |

## 6. Solution overview

```
 Phone, tablet, desktop              Cloudflare edge           Portal (one Node process)
 ┌─────────────────────────────┐     ┌─────────────────┐       ┌──────────────────────────────────┐
 │ React app: shell, nav, pages│HTTPS│ Access sign-in  │ tunnel│ App listener 127.0.0.1:3002      │
 │ Service worker: app files,  │────▶│ TLS             │──────▶│  checks the Access token         │
 │  summary, push, share target│◀────│                 │◀──────│ App files, /api/* (no-store)     │
 └──────────────▲──────────────┘     └─────────────────┘       │ live socket, sessions, devices   │
                │ notification                                 │ attention service → notifier     │
      Push services (Google, Apple, Mozilla) ◀── Web Push ─────┤ VAPID, encrypted payloads        │
                                                               └──────────────────────────────────┘
```

## 7. Functional requirements

| ID | Area | Requirement |
| --- | --- | --- |
| FR1 | Shell | One route table declares each destination: path, label, icon, badge source and flags (`wide`, `panes`, `immersive`, `task`). Sidebar, rail, tab bar, Menu and command palette render from it. |
| FR2 | Shell | The phone tab bar holds Sessions, Workspaces, Monitor, Pools and Menu, never more than five entries (§8). |
| FR3 | Shell | Pools is one hub: PageTabs from 640 px, an index list of pool types with counts and badges on phones. Each device remembers its last tab. |
| FR4 | Shell | Each workspace gets one page with four tabs (Overview, Sessions, Activity, Configuration) that take in Monitoring's drill-down and the foundation's panel (§8). |
| FR5 | Shell | Breakpoints, the short-touch class, route flags, the terminal's key row, back behavior, sheets, keyboard, scrolling and theme follow §9. |
| FR6 | Shell | One attention summary feeds the nav badges, the app badge (Needs input only), the tab title and notifications, over the live socket, or `GET /api/attention` every 30 s until that socket exists. Each item badges one destination. **Partly built** (2026-10-12): the glance aggregator's needs-attention count (`GET /api/glance`, live topic `glance`) feeds the app badge through the Badging API, written by the page while the app is open (nothing updates it after it closes: no push); the nav badges, the tab title and notifications are not built ([Glance widgets](glance-widgets.md) §11). |
| FR7 | Shell | A command palette (⌘K or Ctrl+K; search in the phone app bar) opens any workspace, session, pool, account, setting or page. On Sessions it opens scoped to sessions. |
| FR8 | Shell | One banner slot, highest first: signed out or edge sign-in expired; offline or reconnecting; Locked or Frozen; edge sign-in ending; update ready; install. Each banner is one 40 px line; phones show one, desktops two. |
| FR9 | PWA | Manifest, icons, install flows and `launchQueue` routing; a worker that stores app files and one summary response, nothing else; Android shares images into Chat (§10.1–§10.3). |
| FR10 | PWA | Opening, offline, unreachable and edge sign-in states; updates that reload only the tab that asked (§10.4). |
| FR11 | Notifications | Each device opts in from a tap, can send itself a test, and shows its last delivery or error (§11.4). |
| FR12 | Notifications | §11.1's kinds with their defaults, each switchable per destination (a device, a webhook, Discord or Slack), under §11.2's rules and §11.6's quiet hours. |
| FR13 | Notifications | Templated, encrypted, declarative payloads that open only portal pages (§11.3). A Notifications page lists the history (30 days), pushed or not. |
| FR19 | Notifications | A signed webhook, Discord and Slack through one guarded outbound client; URLs, keys and secrets sealed at rest and never returned (§11.5). |
| FR20 | Notifications | Deny, and Allow for the tool classes the owner switched on, from a notification: the signed-in session plus a single-use token bound to the request, the policy checked again on arrival, abuse-tested (§11.7). |
| FR14 | Sign-in | `PORTAL_APP_URL` and an app listener behind Cloudflare Access or Tailscale (§12.2, §12.3). |
| FR15 | Sign-in | Web sessions and devices persist in SQLite; "Keep me signed in" sets §12.4's lifetimes; restarts sign nobody out. |
| FR16 | Sign-in | Access → Devices: rename, sign out one, sign out all others. Rotating the server code signs out every other device after a last push. |
| FR17 | Sign-in | Re-auth within 10 minutes for §12.5's actions, enforced by the server, from W2; passkeys from W6. |
| FR18 | Quality | §13.1's budgets run in CI with the gate each row names; WCAG 2.2 AA (§13.2). |

## 8. Information architecture

| Destination (lucide icon) | Routes | Contents | Badge |
| --- | --- | --- | --- |
| Sessions (MessagesSquare) | `/admin/sessions`, `…/new`, `…/:id`, `…/share` | Chat sessions, Needs input first ([Chat](chat-sessions.md) §12) | Needs input count |
| Workspaces (Boxes) | `/admin/workspaces`, `…/:target/:name?tab=`, `…/:target/:name/shell`, `…/:target/:name/browser` | The list; one page per workspace (below); the terminal; the browser live view ([Browser & desktop](browser-desktop-pool.md) §15.1) | — |
| Monitor (Activity) | `/admin/monitor?tab=` | Overview, Workspaces, Agents, Events, Accounts. Events is the portal-wide event log with saved filters All and Security; Security adds its StatGrid and Policy card ([Monitoring](monitoring-dashboard.md) §14, A4) | Dot for health items |
| Pools (Layers) | `/admin/pools?tab=`, `/admin/pools/<type>/…` | Accounts, Skills, Personas, MCP sets, Secrets, Browser (ids `accounts`, `skills`, `personas`, `mcp`, `secrets`, `browser`). Libraries, catalogs, reviews and list editors are routes, not nested tabs | Work waiting in Pools: reviews, servers needing sign-in |
| Settings (SlidersHorizontal) | `/admin/settings?tab=`, `…/policies/:id` | Defaults, Policies, Data ([Settings](settings-policies.md) §15). Data takes today's Storage section: database state, Set up encryption and Unlock, backups, Resume delivery | Dot for a policy not yet applied |
| Access (KeyRound) | `/admin/access?tab=` | Sign-in, MCP ([Portal MCP](portal-mcp.md) §15), Devices (§12.4) | — |
| Notifications (Bell) | `/admin/notifications` | The Inbox (the history, 30 days) and Setup (§11.6), opened from the bell and Menu | Unread count |
| Menu (LayoutGrid), phones only | `/admin/menu` | Rows: Defaults, Policies, Data, Sign-in, MCP, Devices, Notifications; Install, Appearance; version and "Check for updates"; Sign out | Dot when a row has one |

| Topic | Rule |
| --- | --- |
| Chrome | Sidebar and rail: Sessions, Workspaces, Monitor, Pools, then Settings and Access after a divider; at the foot a bell (unread count) and the account menu (Appearance, Install, version, Sign out). Phones: the tab bar, and an app bar with the logo or "‹ Parent", search and the bell, but no account menu; the app bar scrolls away on list pages and returns on scroll up. |
| Why | The tab bar holds the daily phone jobs (answer agents, start or stop a workspace, check the fleet, fix a pool) and ends on Menu, as pay's does. **Home** is Sessions, or Workspaces before Chat ships. |
| Pools on phones | Five tab pills need about 480 px, more than a 360 px phone has, so `/admin/pools` is an index list (type, count, badge), and each type opens with "‹ Pools". |
| Workspace page | Overview: status, health line, Resources (CPU and memory with the limit, restarts, OOM kills, disk, and the browser container's own row), Data sources, a Browser card when one is assigned ([Browser & desktop](browser-desktop-pool.md) §15.1), its attention items. Sessions: its chat and terminal sessions with tokens, est. cost and turns (Monitoring's Agents section). Activity: its event feed, Processes, MCP & tools. Configuration: the foundation's panel. The header holds Shell, Chat and ⋯. |
| Links | Every screen has a URL, so notifications and attention items open the exact item (`/admin/sessions/:id?request=<id>`). Moved routes redirect (`/admin/accounts` → `/admin/pools?tab=accounts`). The worker never touches `/connect/*`, `/oauth/*`, `/mcp`, `/.well-known/*`, `/cdn-cgi/*` or `/healthz`. |
| Section | A destination, a hub tab or a Menu row (G2, §16). |

## 9. Layout and app shell

### 9.1 Breakpoints

| Screen | Chrome | Content |
| --- | --- | --- |
| Under 640 px wide | App bar (64 px) on top, under the status bar; a **floating** tab bar (60 px, frosted, fully rounded) below, the same gap (`--bar-gap`, 12 px) from the left, right and bottom edges of the screen, measured from the physical edge with or without a home indicator, the page scrolling under it (§10.5) | One column, 16 px gutters; dialogs are bottom sheets; PageTabs show one section at a time |
| 640–1023 px (the design system's `useIsDesktop` switch, kept) | Icon rail, 80 px, with short labels | One column up to 896 px, 24 px gutters; dialogs centred |
| 1024 px and up | Sidebar, 256 px; the rail on `panes` routes | `wide` routes up to 1280 px; Monitor and the workspace page in two columns from 1280 px |
| Short touch: `(pointer: coarse) and (max-height: 500px)`, such as a phone in landscape; checked at load and on orientation change, never while a field has focus, so a shrinking keyboard never switches layouts mid-typing | Compact rail: 48 px icons without labels, scrolling | Bottom sheets at any width; the session screen immersive; rail and content padded by the left and right insets |

### 9.2 Route flags

| Flag | Effect | Used by |
| --- | --- | --- |
| `wide` | Content up to 1280 px from 1024 px | Monitor, the workspace page, Settings |
| `panes` | Full width, the sidebar narrowed to the rail from 1024 px: a 320 px list, the transcript (24 px padding, text up to 760 px) and, from 1280 px, a 360 px panel (Agents, Files, Diff). Transcript text is the window minus 808 px with the panel (472 px at 1280, 760 from 1568), minus 448 px without (760 from 1208). | Sessions |
| `immersive` | No app bar, tab bar, rail or sidebar. The session screen (2026-10-13): a floating frosted header (52 px: back, title, state, ⋯) under the status bar and a floating composer, both inset by `--bar-gap`, the transcript scrolling under both and under the status bar (§10.5; Chat §12.3). The terminal and the browser keep a 48 px header below the top inset | The terminal and the browser live view at every width; the session screen under 640 px and in short touch |
| `task` | No tab bar on phones; actions pinned in a bottom bar; DiscardDialog guards leaving | On phones, every editor holding a list or more than one section: persona, policy, skillset, MCP set, Secrets set and browser pool editors, skill review. Never `/admin/sessions/new`, which keeps the session screen's flags (Chat A2) |

### 9.3 Terminal on touch screens

| Piece | Behavior |
| --- | --- |
| Key row | Above the keyboard: Esc, Tab, ⇧Tab, Ctrl, Alt, the four arrows, Ctrl+C, Ctrl+D, `\|`, `~` and `/` as 44 px keys, in two rows under 600 px wide. Ctrl and Alt apply to the next key (a second tap locks them); arrows repeat while held. Claude Code needs these to interrupt, cycle modes and pick from menus, and phone keyboards lack them. Hidden while a hardware keyboard is in use. One KeyBar component serves this row and the browser live view's, each with its own keys ([Browser & desktop](browser-desktop-pool.md) §15.3). |
| Keyboard | The column is `visualViewport.height` tall. xterm refits and sends the new size on each `visualViewport` resize (at most once a frame), so the cursor row stays above the keyboard on iOS too. Landscape pads by the left and right insets. 🔬 On a real iPhone at 390×844 and 844×390, keyboard open. |
| ⋯ menu | Copy, Paste, A− and A+ (text size, remembered per device), and Screen reader mode (xterm's `screenReaderMode`). |

### 9.4 Behavior, input and theme

| Topic | Rule |
| --- | --- |
| Back | Installed iOS apps have no back button, so screens below a destination show "‹ Workspaces" in place of the logo. A cold start on a deep link seeds history (`replaceState` the parent route, then `pushState` the target), so Android's Back goes to the parent, not out of the app. |
| Sheets, rows | Sheets are one level deep with a visible ×, and each pushes a history entry so Back closes it. Long content (agents, files, diff, effective settings) is a pushed screen with its own URL on phones. Phone rows wrap to two lines; nothing hides behind hover; no swipe actions; only the page fade moves, keyed by destination, so switching sessions never remounts the list. |
| Keyboard | `interactive-widget=resizes-content` makes Chrome on Android shrink the layout for the keyboard ([Chrome](https://developer.chrome.com/blog/viewport-resize-behavior)); iOS ignores it, so immersive docks follow `visualViewport`. On touch screens the tab bar hides while a text field has focus. Touch fields are 16 px or more and never focused for the user; pinch zoom stays on. 🔬 Fixed bars around the keyboard in iOS 26 Home Screen apps (26.0 left them offset after it closed). |
| Enter | In Chat, Enter sends when a hardware keyboard is in use (`pointer: fine`, or keys arriving while no on-screen keyboard shrinks the visual viewport), whatever the width, so an iPad with a keyboard sends on Enter (Chat A5). |
| Scrolling | Pages scroll the document; immersive and `panes` routes scroll inside a `100dvh` column with `overscroll-behavior: contain`, where each pane scrolls on its own. Sticky bars set `--appbar-h` and `scroll-padding`. No sideways page scroll from 320 px. |
| Theme | Light, dark or system, two densities, token colors only (ShellPage's raw dots become StatusDot), `theme-color` following. Code uses `ui-monospace, Menlo, monospace`, since the tokens' `font-mono` is the UI font. The terminal stays dark. |

## 10. PWA

### 10.1 Manifest and icons

| Field | Value |
| --- | --- |
| The file | `/manifest.webmanifest` (`application/manifest+json`), linked with `crossorigin="use-credentials"` for when Access guards it ([MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest)) |
| `id`, `start_url`, `scope` | `/`, `/admin/?source=pwa`, `/`: a stable identity that keeps `/login` in the app |
| `name`, `short_name` | One `APP_NAME` constant also feeds `<title>`, `apple-mobile-web-app-title`, the tab title ("(2) Sessions · <name>") and notification titles, replacing today's four spellings and ShellPage's "portal". The name waits on Q6. |
| `display`, colors | `standalone`, no orientation lock (the terminal likes landscape); `#fafaf9` theme and background, with `theme-color` metas for dark |
| `icons` | 192 and 512 px `any`, 512 px `maskable`, from LogoMark; a 180 px `apple-touch-icon`, a 96 px monochrome badge, `favicon-32.png` |
| `shortcuts`, `launch_handler` | **Shortcuts built** (2026-10-12, [Glance widgets](glance-widgets.md) §11): New session (`/admin/sessions?new=1`), Sessions and Needs attention (`/admin/sessions?glance=attention`), each with the 192 px app icon, 🔬 on a device; Monitor and Workspaces below are not in, and `launch_handler` is not built. Draft: New session, Monitor, Workspaces (Android, desktop Chrome and Edge, macOS Safari; not iOS). `focus-existing` (Chrome and Edge): the open window takes focus and gets the URL through `launchQueue` without navigating ([MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/launch_handler)); our consumer routes inside the app, or asks first when the tab holds unsaved input. |
| `share_target` | `POST`, `multipart/form-data`, image files (§10.3) |

### 10.2 Install

| Platform | How | What the app shows |
| --- | --- | --- |
| Android (Chrome, Edge, Samsung Internet), desktop Chrome and Edge | `beforeinstallprompt`, after HTTPS, the manifest, a tap and 30 s on the page ([web.dev](https://web.dev/articles/install-criteria)). The app catches it before React renders (pay's `initPwa`), since `useInstallPrompt` listens only after mount. | "Install app" in Menu and the account menu; one banner on Sessions from the second visit, hidden 14 days after "Not now" (pay's rule); never at sign-in or mid-task. 🔬 In-scope links open in the installed app (WebAPK intent filters). |
| iPhone and iPad | Share, then Add to Home Screen; from iOS 26 every site added opens as a web app by default ([WebKit](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)) | A three-step guide sheet; "Open in Safari" in in-app browsers |
| iPhone and iPad, opened from a link | The installed app keeps its own cookies ([WebKit bug 181849](https://bugs.webkit.org/show_bug.cgi?id=181849)), and iOS opens links from Claude (`PORTAL_UI_URL`), mail or chat in Safari, not the app 🔬 (community reports, no Apple documentation) | Safari signs in separately, Access included; passkeys and password-manager autofill keep it to a tap or two (§12.4, §12.5) |
| macOS Safari 17+; Firefox 143+ on Windows | File, then Add to Dock; the web-app button in the address bar ([Mozilla](https://support.mozilla.org/kb/web-apps-firefox-windows)) | One line each under Install |
| Plain HTTP away from localhost | No prompt and no worker; iOS 26 still adds an icon | Install explains HTTPS and links §12.2 |

### 10.3 Service worker

| Request or event | Handling |
| --- | --- |
| The worker | `vite-plugin-pwa` 1.3.x with `injectManifest`: our `sw.ts` with Workbox precaching, navigation preload, and pay's share and notification handlers. Registered from a file (no inline script), on secure contexts only, with scope `/`; `sw.js` is served `no-cache`. **Built so far:** `public/sw.js`, a plain file with the offline page, registered in production builds only. The platform track adds its push and click code to a plain file next to it (no build step, no new dependency; the Workbox plan above stays the plan for W4). |
| Navigations to `/`, `/login`, `/admin/*` | Network first with navigation preload ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent/preloadResponse)). The precached shell answers on a network error, after 4 s, or on 502–504 and 520–530 (Cloudflare's own pages when the portal or tunnel is down). Never cache-first: a cached shell hides Access's sign-in redirect ([Node-RED behind Access](https://discourse.nodered.org/t/dashboard-2-0-pwa-service-worker-prevents-authentication-redirect-when-session-expires/100574)). |
| `/assets/*`, `/icons/*`, the manifest | Precached: the shell, the Latin font, and the chunks of routes with offline data (the session list, Workspaces, Monitor's Overview). Other chunks are cached on first use, up to 60. Only 2xx responses whose Content-Type matches the extension are stored; Workbox's CacheFirst stores any 200 by default ([Workbox](https://developer.chrome.com/docs/workbox/modules/workbox-cacheable-response)). |
| An unknown `/assets/*` path | 404 with `no-store`. Today it gets the app page as `200 text/html`, stamped `immutable`. The deploy keeps the previous build's assets in `dist-prev` for 7 days and the server serves both, since Vite's `emptyOutDir` deletes them and open tabs still lazy-load routes. |
| `GET /api/offline/summary` | The one API response kept, for 24 h, in `cp-data`. Built from a field allowlist: workspace id, name, target and status; counts by state; attention counts by kind; `asOf`. Stored only when the path is on the worker's list and the response carries `X-Offline-Cache: 1`, which only the server sets. |
| Every other `/api/*`, the sockets, `/mcp`, `/oauth/*`, `/connect/*`, `/hooks/*`, `/.well-known/*`, `/cdn-cgi/*`, `/healthz` | Never handled or stored. The server marks `/api/*` `Cache-Control: no-store`, the HTML `no-cache`, and hashed assets `immutable`. |
| Sign-out, any 401, a `signed_out` socket message | The worker deletes `cp-data` and `cp-share`. No `Clear-Site-Data`: `"cache"` clears only the HTTP cache, and `"storage"` would unregister the worker and its push subscription ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Clear-Site-Data)). |
| `POST /share-target` | From Android's share sheet (Chrome Android 76+, Samsung Internet; not Safari or Firefox). Up to 10 images (20 MB) wait in `cp-share` with a timestamp; `/admin/sessions/share` picks or starts a session and the composer attaches them (Chat FR30). Entries go once attached, or after 10 minutes, checked whenever the worker starts or the app opens. |

### 10.4 Opening, offline and updates

| State | Detected by | Shown |
| --- | --- | --- |
| Opening | Every start | The shell and the cached summary at once, with "Updated 14:02"; `/api/session` and the socket start in parallel, with no blank splash. A 401 drops the view and clears the cache. |
| Offline | `useOnlineStatus` | "Offline · showing 14:02"; portal actions disabled with the reason; uncached routes say "Not available offline · Retry" |
| Portal unreachable | The socket or a fetch fails while online; 502–504, 520–530, or a non-JSON `/api/*` body | "Reconnecting… · Retry now"; backoff 1–30 s with jitter, reset with an immediate retry on `online`, `pageshow` and the tab becoming visible; then replay from the last sequence numbers; approvals disabled until live |
| Edge sign-in expired | API calls send `X-Requested-With: XMLHttpRequest`, so Access answers a non-JSON 401 instead of redirecting ([Cloudflare](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)), and use `redirect: 'manual'`, so any redirect is an `opaqueredirect`. After a socket failure the app probes once this way. | "Sign in again": a top-level reload through the network, so Access can redirect |
| Signed out | The portal's own JSON 401 (`UNAUTHORIZED`) | Sign-in, then back to the same URL |
| Stale | Data older than twice its interval | Dimmed values, "Stale · 3 min" |
| Update ready | A new worker waits until no page uses the old one ([web.dev](https://web.dev/articles/service-worker-lifecycle)). Browsers check `sw.js` on navigation and at least daily ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)); the app also checks on becoming visible (at most every 15 minutes), hourly, and when `X-Portal-Build` changes. Vite's `vite:preloadError` ([Vite](https://vite.dev/guide/build#load-error-handling)) counts too. | "New version · Reload". Only the tab where Reload was pressed sends `SKIP_WAITING` and reloads on `controllerchange`; other tabs show "Updated · Reload when ready" and keep their input. Holding control of a browser counts as unsaved input. `409 CLIENT_TOO_OLD` blocks until reload. |

### 10.5 Edge to edge on iPhone (status bar, safe areas, floating bars)

**Built (2026-10-13, UX1).** The installed app runs edge to edge: `viewport-fit=cover` and `apple-mobile-web-app-status-bar-style` `black-translucent` (`apps/web/index.html`), so the page runs under the status bar. The manifest stays `display: standalone` (iOS reads the status bar style from the meta tag, not the manifest).

| Piece | Rule |
| --- | --- |
| Safe areas, one place | `apps/web/src/index.css` reads `env(safe-area-inset-*)` once into `--safe-top/right/bottom/left`; the floating bars use `--bar-gap` (12 px), `--bar-left/right` (the gap or the side inset, whichever is larger) and `--bar-top` (the gap or the top inset). The session screen, the tab bar and the app bar read these; older screens (terminal, browser, viewers, knowledge) still read `env()` directly and move over as they are touched. |
| Status bar band | `black-translucent` draws the clock and icons **white in both themes**. A frosted band the height of the top inset (`body::before`, over every page, no pointer events) dims what scrolls under it so white keeps 4.5:1 over a white page: measured 5.25:1 light and 7.46:1 dark over solid white (`tools/qa/session-chrome.mjs`). Its lower edge fades into the page. Without an inset (a browser tab, a desktop) it has no height. |
| Floating bars | The session header, the composer and the phone tab bar are one style (`glass-card`): rounded, inset by `--bar-gap` on the left, right and below (the composer and the tab bar) measured from the physical screen edge, home indicator or not, keyboard up or down. Content scrolls under them. |
| Glass | More see-through than before (60 % tint over a 24 px blur), with the backdrop's contrast squeezed (`contrast(0.5)`, then brightness up in light, down in dark) so text on it keeps 4.5:1 over the busiest background: lowest measured 5.14:1 light and 5.94:1 dark (phone), 4.53:1 (desktop light, a muted label on a chip) over solid black, solid white and black/white stripes, sampled from screenshots. Grey text on the glass uses ink-soft. |

Device checklist (🔬: only a real device shows it; emulated in Chromium with `Emulation.setSafeAreaInsetsOverride` 59/34 px; each row: Pass, Fail or Not run, with the device, iOS version, date and tester):

| ID | Steps | Expected |
| --- | --- | --- |
| E1 | Add to Home Screen (an icon added before this change may keep the old status bar style until it is removed and added again: reported by others, not checked 🔬), open a session, light theme | Clock and icons white and readable on the dimmed band; the transcript scrolls under the band and the header |
| E2 | The same in dark | The same |
| E3 | Look at the composer and the Sessions tab bar on a phone with a home indicator | The gap under each equals the gap beside it; the home indicator sits in that gap and a swipe up from it still goes home (not a tap on Send) |
| E4 | Open the keyboard in the composer, then close it | The composer rides 12 px above the keyboard, the header stays put, and both come back to the same place when it closes (iOS 26.0 once left fixed bars offset, §9.4) |
| E5 | Turn Bypass on in a session | The composer keeps its height and place; the model chip keeps its name; the header shows the red shield |
| E6 | Rotate to landscape | Bars clear the notch side (inset), nothing under the camera housing |
| E7 | Scroll a dark code block and a white image under the header and the composer | Text on the bars stays readable (the glass squeezes what is behind it) |

## 11. Notifications

This section is the design for the platform track (phase 1 of [Platform roadmap](platform-roadmap.md)); the contracts are in `packages/contracts/src/notify.ts`, and nothing else is built yet. v0.7 (2026-10-12, owner's ask) extends the v0.6 text in place: kinds the owner named, channels beyond Web Push (a signed webhook, Discord, Slack), per-destination preferences, quiet hours, and answering from a notification, which v0.6 had ruled out (§11.7 resolves it). Multi-user (PLAN-10) is coming and is in this design from the start: everything per person belongs to a user and routes by ownership (§11.10); today there is one user, `u_owner`, and nothing about the single-owner behaviour changes. Marks: ✅ checked on 2026-10-12 in the code or by running something here, 📄 documented (source linked), 🔬 unverified (needs a real device or account; the manual list is in the roadmap §9).

```
 seams that exist                 one in-process bus        the pipeline                         destinations
 ChatController.onEvent ──┐                           ┌ kind on? ▸ quiet hours ▸ presence ┐    Web Push devices
 CiService.hooks.changed  ├─▸ NotifyEvent ───────────▸│ collapse ▸ throttle ▸ render      ├─▸  signed webhook
 ClaudeUsage.onAlert      │   (facts, never free text)│ history (30 d) ▸ delivery log     │    Discord, Slack
 U1b spike alerts         │                           └───────────────────────────────────┘    in-app toast
 Tickets hook (new)       ┘   triggers and auto transfer read the same bus
```

### 11.1 Kinds

The ids are `NotifyKind` in the contract. One list: the owner's six events, the three that the trigger and auto-transfer work add, and v0.6's other kinds, kept for later.

| Kind | Default | Fires when | Title · body | Opens |
| --- | --- | --- | --- | --- |
| `approval` | On | A session asks for an answer to a tool request ([Chat](chat-sessions.md) FR22; a stored `request` event). Answerable from the notification only as §11.7 says. | Approval needed · api-dev · run a command | The request: `/admin/sessions/<id>?request=<rid>` |
| `human_request` | On | A ticket is assigned to a person by an agent, a trigger or the portal, not by the person, and is open ([Tickets](tickets.md) FR12, FR25) | Request for you · T-12 · Approval · api-dev | The ticket |
| `session_failed` | On | A turn fails (an `error` event) or a session ends for a reason that is not a person ending it (`credential:`, `integrity:`, a crash) | Session failed · api-dev · rate limit | The session |
| `session_done` | Off | A turn ends while "Notify when done" is on for the session (Chat's ⋯), or a turn of 5 minutes or more ends while this destination's device is not active | Session finished · api-dev · 12 min | The session |
| `ci_failed` | On | A CI run ends `failed` (not `cancelled`) | CI failed · api · #14 · test | `/admin/ci/runs/<id>` |
| `ci_waiting` | On, urgency high | A deployment job starts waiting for a person's approval ([CI](local-git-ci.md) FR41); quiet hours hold it; no button approves | Deploy waits · production · claudepilot · #21 | `/admin/ci/runs/<id>` |
| `quota_low` | On | A usage alert at `high` (95 %), `exhausted`, or a `projection` alert (an estimate); `near` (80 %) goes to the history only | Quota low · Work · Session · 4 % left · resets 14:00 | `/admin/usage?claude=<id>` |
| `cost_spike` | On, breaks through quiet hours | A spend spike, or a budget at its critical or exceeded threshold ([Claude usage](claude-usage.md), U1b) | Cost spike · api-dev · $12.40 est. today | `/admin/usage` |
| `trigger_approval` | On | A trigger run waits for approval ([Triggers](triggers.md)) | Run needs approval · nightly-lint · push | `/admin/triggers/<id>?run=<rid>` |
| `trigger_failed` | On | A trigger run failed, or a limit stopped it | Trigger problem · nightly-lint · cost limit | The trigger's run |
| `auto_move` | On | A chat moved to another Claude by itself, or a move is suggested ([Auto transfer](auto-transfer.md)) | Moved to Work · api-dev · 8 % left | The session |

Later kinds, not emitted by the platform track: `workspace` (error, OOM kill, 3 restarts in 15 minutes, disk under 5 %), `account` (invalid, billing, exhausted, pool waiting, budget reached), `portal` (delivery failing in 3 or more workspaces), `security` (high-severity events, a new device signs in) and `expiring` (a digest at 09:00 while secrets expire within 3 days; off). `portal` for a Locked start is dropped (§11.4, O4).

Text is a fixed template over workspace, Claude and device names, tool classes, ticket numbers, run numbers and times: never prompts, replies, commands, paths, URLs, error text, secret names, ticket summaries or session titles. A session's own agent can rename it (the portal's `chat` tools), so a title is text an attacker may write; the same goes for a ticket summary and everything that came out of a webhook. A number says what it is: measured as is, an estimate with "est.". A destination with "Include detail" adds the redacted detail of the request, clipped, labelled untrusted (§11.7).

### 11.2 Delivery rules

| Rule | Behavior |
| --- | --- |
| Active device | Tabs report `presence {device, visible, active, session}` on the live socket (`LivePresence`; the socket closing ends it). While a device is visible and used in the last 2 minutes, it gets toasts and history entries instead of pushes, and nothing for the session it shows. Other devices get nothing, except `approval` (pushed after 60 s if the request is still open) and `cost_spike` (at once). |
| Recipients | An event goes to the **owner** of what it is about (§11.10): a session's creator, a ticket's assignee, a trigger run's trigger owner, the admins for platform events. Each recipient is checked with `can(user, 'view', subject)` again at delivery, so a revoked share stops the notifications. Today everything belongs to `u_owner`. |
| Announce delay | An `approval` is announced 3 seconds after its request, and only if the request is still open then: the person answering in the page, or a rule answering for them (the auto-approval rules of PLAN-8), sends nothing. The history row is written either way. |
| Collapse | One notification per item, under a tag carried only inside the encrypted payload: `approval:<session>:<request>`, `session:<id>`, `ci:<run>`, `quota:<claude>:<window>`, `ticket:<id>`, `trigger:<id>`, `move:<session>`. A newer one replaces it in place; `renotify` for `approval`, `session_failed` and `cost_spike`. |
| Topic | `Topic` keeps only the latest push per topic for an offline device. RFC 8030 allows at most 32 characters of the URL-safe Base64 alphabet and push services answer 400 to others ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030.html) 📄, read 2026-10-12), so it is the first 32 characters of base64url(HMAC-SHA256(topic key, tag)), which also hides ids from push services. |
| Resolved elsewhere | No silent push closes a notification: Safari revokes subscriptions whose pushes show nothing ([WebKit](https://webkit.org/blog/12945/meet-web-push/)), and WebKit requires a visible notification for every push, declarative ones included ([WebKit](https://webkit.org/blog/16535/meet-declarative-web-push/) 📄). The app closes resolved ones when it opens (`getNotifications`); the history row gets `resolvedAt`; a resolved request says "Already allowed on Pixel 8 · 14:03". |
| Throttle | One push per tag per minute, 10 per destination per 10 minutes; the rest become "3 more items need you". A channel gets at most 1 message per second (the portal's own conservative limit: the Slack and Discord pages read here state no rate). |
| Quiet hours | Per destination, in the IANA zone stored with it, off by default (the preset is 22:00 to 07:00); evaluated with `Intl` at the time of the event, so a clock change cannot misplace it. Kinds listed as break-through are delivered anyway (default: `cost_spike`). What was held is summarised once when the window ends ("2 items waited"); an item that was dealt with meanwhile is not in the summary. |
| Retries | A webhook, Discord or Slack delivery is tried up to 3 times (now, 30 s, 5 min) on a timeout, a 5xx or a 429 (honouring `Retry-After` up to 5 minutes); never on another 4xx. A destination is `failing` after 3 failed deliveries in a row (one try an hour after that) and `disabled` after 20, until a person turns it on. A push service's 404 or 410 ends that subscription at once ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030.html) 📄 names 404 for an expired subscription; the earlier draft also listed 410, so both end it). |
| Urgency, TTL | Per kind (`NOTIFY_KIND_INFO`): `approval` and `cost_spike` `high` (1 h and 6 h), the rest `normal` or `low`; `Urgency` and `TTL` are request headers of RFC 8030 ([RFC 8030](https://www.rfc-editor.org/rfc/rfc8030.html) 📄: TTL is required, 400 without it). |
| Locked, Frozen, read-only | While the portal is Locked or Frozen it cannot open its sealed keys and URLs (§11.4), so it delivers nothing and says so on the page; the history is still written when the database can be written. |

### 11.3 Payload and click

`{"web_push":8030,"mutable":true,"notification":{"title":"Approval needed","body":"api-dev · run a command","navigate":"https://cpapp.isnan.me/admin/sessions/s_41?request=r_7","tag":"approval:s_41:r_7","renotify":true,"silent":false,"actions":[{"action":"review","title":"Review","navigate":"https://cpapp.isnan.me/admin/sessions/s_41?request=r_7"}],"data":{"v":1,"id":"evt_8f2c1a9d3b7e4c05","kind":"approval","path":"/admin/sessions/s_41?request=r_7","act":{"t":"cpna_…","d":["deny"],"exp":1791807000}}}}` (the types are `PushPayload`, `PushNotification` and `PushData`).

Every push uses this Declarative Web Push shape, which iOS and iPadOS 18.4+ Home Screen apps and Safari on macOS show without our code ([WebKit](https://webkit.org/blog/16535/meet-declarative-web-push/) 📄: `web_push` 8030, `notification.title` and `navigate` required). In the W3C draft each declarative action needs `action`, `title` and `navigate`, so every declarative action is a navigation, never a callback ([Push API](https://w3c.github.io/push-api/) 📄); and `mutable: true` hands the message to our worker first. Our worker parses the same JSON everywhere, checks `web_push` and that the path matches `^/admin/`, shows the notification with `showNotification` (always: Safari's no-silent-push rule), applies the tag, `renotify` and the badge, and, only when `data.act` is present, replaces the `review` action with real `deny` and `allow` buttons (§11.7). A browser that does not show action buttons shows the body, and a tap opens the deep link. If the worker fails, Safari shows the message as sent. Under 1 KB (a push service must accept bodies up to 4,096 bytes, RFC 8030 📄), encrypted (aes128gcm), VAPID-signed.

`notificationclick`: a click on the body or on `review` opens or focuses a window on `data.path` (same origin, `/admin/` only; anything else opens `/admin/`). `deny` and `allow` call `POST /api/notify/act` (§11.7). Nothing in `data` is needed to open the right page: a browser that drops `data` (MDN's compatibility data lists no `data` for Safari's `showNotification` 📄) still opens `navigate`.

### 11.4 Support and subscriptions

| Topic | Detail |
| --- | --- |
| Support | Push in Android and desktop browsers, and on iPhone and iPad (16.4+) only in Home Screen apps, asked from a tap ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)); Firefox 72+ and Safari refuse prompts without one ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API)). Action buttons: Chrome 48+, Edge 18+, Opera, Samsung Internet and (new) Firefox 152+; not Safari, not iOS ([MDN browser-compat-data](https://github.com/mdn/browser-compat-data) `ServiceWorkerRegistration.showNotification` `actions`, main branch, fetched and parsed 2026-10-12 ✅). Badges: Chrome and Edge 81+, Safari 17+, iOS 16.4+ with notifications allowed; Android shows dots. |
| Turning on | The Notifications page says what arrives ("never message text") and asks only on "Turn on", since a blocked prompt is hard to undo ([web.dev](https://web.dev/articles/push-notifications-permissions-ux)). States: Unsupported, Add to Home Screen first, Blocked (how to unblock), Off, On (last delivery or error, Send test). |
| Per device | A subscription is one destination (`type: 'push'`) with its name ("Pixel 8 · Chrome", editable) and its time zone; sign-in re-registers it (pay's `syncPush`); registering the same endpoint again updates it. Removing it, an explicit sign-out of that browser (the Sign out button; an expiring session does not end it), rotation of the keys, a disabled or removed user and a push service's 404 or 410 end it, and its pending answer tokens die with it. A push endpoint belongs to one user at a time: registering one that another user holds moves it to the new user and tells the old one in their history (a phone that is handed to someone else stops notifying the first person). There is no `devices` table yet (§12.4 plans one): the destination is the device record for notifications until it arrives. |
| Validation | The endpoint must be `https`, with no user info, on a public address (the delivery guard of §11.5 checks it again at every send), at most 500 characters; `p256dh` a valid uncompressed P-256 point of 65 bytes (checked with an ECDH computation), `auth` 16 bytes; at most 20 subscriptions. A push service host this version does not know is flagged ("unrecognised service") and still allowed: the known hosts (Google's FCM, Mozilla, Apple, Microsoft) come from third-party descriptions, not from a vendor's list 🔬. |
| Keys, sending | One VAPID key pair (P-256) and a random topic key, made on first use, **sealed at rest** with the portal's secret key (`notify_keys`; v0.6 kept them in plain text so a Locked portal could still push its own alert; the owner's security rule, PLAN-5 R3, and the cost of leaking a push endpoint and its keys, which lets anyone send convincing fake alerts to the owner's devices, win: decision O4). The sender is Node's `crypto` only, no new dependency: RFC 8291 `aes128gcm` and RFC 8292 VAPID. ✅ Checked here (spike, 2026-10-12): all eight intermediate values of RFC 8291 Appendix A (ECDH secret, PRK_key, IKM, PRK, CEK, nonce, the 86-byte header and the ciphertext) match; an ES256 JWT signed with `crypto.sign` and `dsaEncoding: 'ieee-p1363'` is 64 bytes and verifies; the private key survives a PKCS#8 round trip. The Appendix A vector is a required test. `Authorization: vapid t=<jwt>, k=<public key>` with `aud` the push service's origin, `exp` under 24 hours ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292.html) 📄: "MUST NOT be more than 24 hours"; `sub` should be a `mailto:` or https contact). `sub`: setting `notify.contact`, else `PORTAL_PUSH_CONTACT`, else derived from `PORTAL_UI_URL` when it is https; Apple's service may refuse a push without a valid `sub` 🔬. Outbound HTTPS only through the guarded client. |

### 11.5 Channels

| | Webhook | Discord | Slack |
| --- | --- | --- | --- |
| What the person pastes | A URL (https; a private address only with an explicit tick, never a metadata address) | A Discord incoming-webhook URL | A Slack incoming-webhook URL |
| What is sent | JSON `{v:1, id, kind, at, title, body, url, subject:{type,id,workspaceId}, severity}` and headers `X-Pilot-Event`, `X-Pilot-Delivery`, `X-Pilot-Timestamp` (Unix seconds) and, when "Sign" is on, `X-Pilot-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>` (✅ vector, computed with openssl and node: secret `s3cret`, timestamp `1700000000`, body `{"v":1}` gives `v1=bf81b0df9ab63212348caadf6ab8b1fc3d2c0c0cb838b2f767a6c1f11d1fa717`) | One embed (title linking to the portal when `PORTAL_UI_URL` is set, one description line, a colour by severity), `allowed_mentions: {parse: []}` so no text can ping anyone, `username: "pilot"`; content under 2,000 characters ([Discord](https://docs.discord.com/developers/resources/webhook) 📄: `content` 2,000, up to 10 `embeds`) | `{text, blocks}`: a section with the title and body, a context line, and a link `<url\|Open>` in mrkdwn ([Slack](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks) 📄: JSON POST, 200 `ok`) |
| Buttons | None. A link. | None (components on a webhook that is not application-owned are ignored without `with_components` and then only non-interactive ones 📄) | None. A link. |
| Secret | The URL and the signing secret (sealed; the secret is shown once) | The URL ("contains a secret", sealed) | The URL (sealed) |
| Limits | Body at most 8 KB | 2,000 characters | 3,000 characters of text |

Rules for all channels (the design; N1 and N5 write the tests): the URL, the signing secret and a push endpoint are sealed at rest and shown only as a host (`hint`); the API never returns them; the delivery log stores a host, a status and a fixed error code (`NotifyError`), never a URL, a path, a query or a provider's reply. The HTTP client is one guarded function: https only; no user info; resolve the name, refuse when ANY address is private, loopback, link-local or a metadata address (the same `isPrivateAddress` and `embeddedIPv4` the account and MCP checks use), and connect to the address it checked (a connect-time `lookup`, so a name that changes its answer between check and use cannot slip through, which the admission-time guards in `mcp/spec.ts` and `accounts/check.ts` accept as a risk). ✅ Checked here (spike, Node 22.23.3, 2026-10-12): a `lookup` guard blocks a name that resolves to loopback, **but Node never calls `lookup` for an IP literal** (a request to `http://127.0.0.1/` went through), so the URL's host is parsed with `new URL` (which normalises `2130706433` to `127.0.0.1`) and a literal is checked with `isPrivateAddress` before any connection (loopback, `::1`, `::ffff:7f00:1` and `169.254.169.254` were all refused by that pre-check); never follow a redirect (a 3xx is the code `redirect`); no `rejectUnauthorized: false`; 5 s to connect and 10 s in all; at most 4 KB of the reply read; 4 deliveries in flight per destination. Discord and Slack always refuse a private address (only a webhook may be ticked). A test button sends a harmless `test` event through the same path and shows the fixed code.

Rejected for v1: interactive buttons in Discord and Slack. They need a public interactions endpoint that Discord and Slack can call (an Ed25519 signature check with PING/PONG for Discord, [📄](https://docs.discord.com/developers/interactions/overview); a signing-secret check with a 5 minute window for Slack, [📄](https://docs.slack.dev/authentication/verifying-requests-from-slack)), an application the owner creates in each, and the same exposure problem as inbound webhooks (the front: §12.2), for little gain over the phone's own push. If it is wanted later, the same single-use token table carries it, bound to the channel instead of a device.

### 11.6 Preferences, devices and quiet hours

The unit is the **destination**: a push device, a webhook, a Discord or a Slack channel. Each has its own set of kinds (the matrix on the page is a view over those sets), its own quiet hours with their break-through kinds, an "Include detail" switch (off), and its state. A new destination starts with the kinds whose `defaultOn` is true (`NOTIFY_KIND_INFO`). A destination belongs to a user (a push device is a device under its user); "per device" is per destination. The platform's own settings (the VAPID contact, the base URL, the ceiling on answers) are an admin's.

| Place | What the person sees (text diet: a word or two, the rest behind ⓘ) |
| --- | --- |
| Notifications page (`/admin/notifications`, Bell in the nav; the unread count on it) | Two tabs: **Inbox** (the history, newest first, unread dot, dimmed when dealt with; tap opens the item) and **Setup**. |
| Setup | **This device**: state chip (Unsupported, Add to Home Screen, Blocked, Off, On), "Turn on", "Send test", name, zone. **Devices** and **Channels**: one row each (name, host, state dot, last error code), a ⋯ menu (Test, Rename, Remove); "Add channel" (type, name, URL, Sign for a webhook). **Events**: kinds as rows, destinations as columns, switches; a row's ⓘ says when it fires. **Quiet hours**: per destination, one line (22:00 to 07:00, zone) and the break-through kinds. **Answers**: Deny, Read, Edit, Command: four switches with ⓘ (§11.7), the caller's own; greyed with a line when the platform ceiling is off. A destination's "Also shared with me" switch (off) lets it hear of sessions others shared to this user. |
| Session ⋯ | "Notify when done" (a per-session flag, `PUT /api/notify/sessions/<id>`). |
| Toasts | An item for a visible, active tab arrives as a toast and in the Inbox (the existing `ToastProvider`). |

### 11.7 Answering from a notification

**The conflict.** v0.6 decided "no action buttons: Safari has none, and a decision needs the whole request on screen" (Chat FR22, FR23). The owner now asks for approve and deny from the notification, and that every such action be authenticated and abuse-tested. **The decision** (owner decision O1; the one design, with the alternatives it beat below): a notification offers **Review** always (a deep link to the request, where the ApprovalCard and every rule of FR23 apply), **Deny** on a tool request (on by default), and **Allow** only for a tool class the owner switched on, only when the whole request is in the notification, and never for the things in the second table. A notification that cannot carry buttons (Safari, iOS, Discord, Slack, a webhook) carries the link. An answer needs the signed-in session AND a single-use token bound to the request, and the policy is checked again at the moment it arrives.

What is offered where:

| Where | Buttons | Why |
| --- | --- | --- |
| Chrome, Edge, Opera, Samsung Internet, Firefox 152+ (desktop and Android) | Deny, Allow (when eligible), Review | Their `showNotification` supports `actions` (✅ browser-compat-data) and our worker runs on the push |
| Safari (macOS), iPhone, iPad Home Screen app | None: a tap opens the request | No `actions` in Safari (✅ browser-compat-data); the declarative form's actions are navigations 📄 |
| Discord, Slack, webhook | A link | §11.5 |
| In the app | The ApprovalCard: Allow, Allow for session, Deny, with FR23's anti-misclick rules | Unchanged |

Allow, by tool class (`notifyToolClass`; each person turns their own classes on in Setup, `PUT /api/notify/prefs`; each starts off; turning one on asks for a confirmation, the one for Command is a red line):

| Class | Tools | Allow is offered only when |
| --- | --- | --- |
| `read` | `Read`, `Glob`, `Grep`, `LS` | `allowRead` is on; a path, if the tool has one, is inside the session's folder (or worktree) after normalising, with no `..` and no segment that starts with a dot (so never `.ssh`, `.env`, `.git`, `.claude`, `.pilot`); the whole request is shown |
| `edit` | `Edit`, `MultiEdit`, `Write`, `NotebookEdit` | the same, with `allowEdit` |
| `command` | `Bash` | `allowCommand` is on and the whole command is shown: only letters, digits, spaces and `._/=:@%+,-` (no `; & \| < > $ ( ) { } \` \\ * ? ! " '`, no newline, no hidden or look-alike character: so `npm test` and `git status` qualify, `npm test; curl x` and `$(…)` never do), at most 100 characters (what a lock screen shows when expanded 🔬), not cut by the 200 character clip. The strict command matcher of the auto-approval rules ([PLAN-8](platform-roadmap.md) §10) replaces this check when it lands. |
| `other` | everything else: MCP tools (`mcp__…`), `Task`/`Agent`, `WebFetch`, `WebSearch`, `ExitPlanMode`, `AskUserQuestion`, any unknown tool | never; Deny is offered except for `AskUserQuestion` |

Never, whatever the policy (the code has no way to do these, and tests prove it): `allow_session` (a standing permission); answering a plan (it changes the mode); typing an answer; entering or leaving Bypass or changing any mode; answering a request of a session that a webhook or CI trigger started, or whose parent chain leads to one (its prompt contained text from outside; its approvals are Review and Deny only; cron-started sessions are not restricted); offering Allow when "the whole request is shown" does not hold: the stored detail is missing (an unknown tool shape), is longer than 100 characters, ends in the clip's `…`, or has a character outside printable ASCII (no control, bidi or zero-width character).

How an answer travels:

1. When an `approval` event is made, the pipeline works out the offer from the policy and the request (`NotifyAnswerOffer`). For each push destination with actions possible (`Deny` or `Allow`), it makes **one token**: 32 random bytes from `crypto.randomBytes`, `cpna_` + base64url, stored only as its SHA-256 in `notify_action_tokens` with the destination id, the event id, the session id, the request id, the decisions offered (`deny`, or `allow,deny`), the tool class and an expiry (10 minutes, at most 200 pending; older ones are deleted). The token is placed only inside the **encrypted** push payload of that destination (`data.act`); it is never in a channel message, a URL, a log, the history, an audit row or any API response (the redactor learns the `cpna_` prefix).
2. The worker's `notificationclick` posts `{token, decision}` to `POST /api/notify/act` with the session cookie (`credentials: 'same-origin'`). That route is behind the session guard and the Origin check like the rest of `/api`; it takes at most 1 KB.
3. The server, in this order, stopping at the first failure: the session is valid (401); the rate limit (5 refusals in 10 minutes per session, 20 answers an hour per destination: 429, `rate_limited`); the portal is not Locked (503, `locked`); the token's SHA-256 is found (403, `unknown`; there is no way to tell a wrong token from a missing one); it is not used (409, `used`) and not expired (410, `expired`); its destination exists and is enabled (403, `device_removed`); the decision is one the token carries (403, `not_allowed`); **the policy now** allows that decision for that class (403, `disabled` or `not_allowed`: turning a switch off cancels every pending token); the signed-in user is the user the token and its destination belong to (a token of another user looks like a wrong token: `unknown`) and `can(user, 'operate', session)` holds now (403, `not_allowed`: a revoked share or a disabled user stops answers at once); the session exists, is not ended, was not started by an untrusted-origin trigger, and the request is still open (`controller.openRequests`, the source of truth; 409, `closed`); the details still hold (class, shown detail unchanged). Then **one atomic statement** marks the token used (`UPDATE … SET used_at = ? WHERE id = ? AND used_at IS NULL`; zero rows changed means someone else got there first: 409, `used`). Only then `ChatController.respond(session, requestId, decision, {note, actor: 'portal:notify-<destination id>'})` runs; its own `That request is no longer open` conflict maps to `closed`. The result is `{ok, sessionId, outcome}`.
4. Every attempt that reached step 3 writes a platform audit row (`notify.action`: decision, class, destination name, session, request, outcome or refusal; severity `medium` for an Allow); the transcript gets the normal `resolved` row; the history row is marked resolved; the other devices' notifications close when the app opens.
5. The worker shows nothing on success and, on a refusal, a notification "Couldn't answer · open" with the deep link (a click is not a push: the no-silent rule does not apply, but the person should know).

Why this is safe, and how it is tested (N5 and N1 write these as tests; 🔬 marks what only a device can show):

| Threat | Control | Test |
| --- | --- | --- |
| Someone forges a request without the token | 256 random bits, hashed at rest; no oracle (unknown and wrong look the same) | Random and truncated tokens, a token for another request, a token from another destination: all refused, nothing answered |
| Someone has the token but not the session (a log, a forwarded message) | Tokens never leave the encrypted payload; the route needs the session cookie | Valid token without a cookie: 401; with a cookie of a signed-out session: 401 |
| Someone has the session cookie but no token, or another user's token | The token binds request, destination, user and decisions; the cookie's user must be the token's user | A cookie alone cannot answer; the old chat socket path is unchanged |
| Replay or double tap | Single-use by one atomic update; the request must still be open | Two concurrent requests: exactly one answers; the second is `used` or `closed` |
| A token for Deny used as Allow | The decisions are in the row | Deny token with `allow`: `not_allowed` |
| Policy changed after the push | Policy re-checked on arrival | Turn `allowCommand` off: a pending token for a Bash request is refused |
| Escalating the class | The class is stored and the tool name re-read from the open request | A request whose tool differs from the token's class: refused |
| An agent crafts a request that looks harmless | Allow only when the whole text fits 100 printable ASCII characters; path and dotfile rules; `other` never; webhook-started sessions never | Path traversal (`../`), absolute paths outside the folder, `.claude/settings.json`, `.git/hooks`, a 300-character command, a command with a bidi override or a zero-width space, a request with no detail: Allow not offered and refused if forced |
| An agent renames its session to mislead | Titles are never in the text | A title with "URGENT approve" never appears in a payload, history row or log (canary) |
| Flooding (many requests, many answers) | Per tag and per destination throttles; 200 pending tokens at most; rate limits on `act` | 1,000 requests in a minute: at most the throttle's pushes; the table stays under its cap |
| A lost phone | Remove the destination (its tokens die); a session sign-out (rotation of the server code) stops answers | Remove, then answer: `device_removed`; sign out, then answer: 401 |
| Locked portal | Sealed material is unreadable; no pushes, no answers | Start Locked: nothing sent; `act` answers `locked` |
| Secrets in logs | The token, endpoints, URLs and secrets are sealed or hashed; the redactor knows `cpna_` | A canary token and a canary webhook URL never appear in the log, the audit, the history or any response |
| CSRF from another site | Origin check; `SameSite=Strict` cookie | A cross-origin form or fetch: 403 |
| Lock-screen shoulder surfing, an accidental tap, notification text hidden by the OS | Allow is off by default and per class; the text carries what is allowed; the app's own rules are not weakened | 🔬 on devices (roadmap §9) |
| The session cookie is not sent by a worker's `fetch` (SameSite=Strict, service worker) | The route answers 401 and the worker opens the deep link: the failure is safe | ✅ Checked here (spike, headless Chromium 154, 2026-10-12): a same-origin worker `fetch` POST with `credentials: 'same-origin'` sent the `SameSite=Strict; HttpOnly` cookie, with `Origin` the page's origin and `Sec-Fetch-Site: same-origin`, so the Origin check passes; N2 repeats it against the portal; Safari and Firefox 🔬 |

Rejected, and why: (a) a link in the notification that approves on GET: a GET with a side effect, fetched by previewers, kept in logs; (b) a stateless signed token (a JWT): cannot be single-use or revoked without state, and the portal has a database; (c) a per-device signing key in IndexedDB instead of the session: stronger proof of the device but a key lifecycle to build, and the session already gives revocation; revisit if the owner wants answers to outlive a sign-in (the session lasts 12 hours today: after that the tap opens the app); (d) Allow for every tool by default: a lock-screen tap would run arbitrary commands; (e) no actions at all (v0.6): leaves the owner's request unmet when Deny and Review cost almost nothing; the owner can keep every Allow switch off and still have Deny and Review; (f) interactive Discord and Slack buttons (§11.5).

### 11.8 API, data and settings

Routes (the table is `NOTIFY_API`; all behind the session guard and the Origin check, JSON bodies at most 4 KB, except `act` at 1 KB):

| Route | Purpose |
| --- | --- |
| `GET /api/notify` | Overview for the caller: state, VAPID public key, base URL, their destinations, their answer policy and the ceiling, unread count |
| `GET`, `PUT /api/notify/prefs` | The caller's answer switches |
| `POST /api/notify/push` | Register this browser (`PushSubscription.toJSON()`, a name, the zone) |
| `GET`, `POST /api/notify/destinations`; `PATCH`, `DELETE /api/notify/destinations/:id` | List; make a channel; edit kinds, quiet hours, name, switches; remove |
| `POST /api/notify/destinations/:id/test`, `.../secret` | Send a test; rotate a webhook's signing secret (the server code is checked again, `REAUTH_REQUIRED`) |
| `GET /api/notify/history`, `POST .../history/read`, `DELETE .../history` | The Inbox |
| `GET /api/notify/log` | Delivery log (30 days): status and fixed codes only |
| `GET`, `PUT /api/notify/sessions/:id` | "Notify when done" for one session (`{done}`; reading needs `view` on the session, changing it `operate`) |
| `POST /api/notify/act` | Answer from a notification (§11.7) |
| `GET /api/platform/audit` | The audit rows every platform module writes |

Data (migrations 200 to 209 are N1's; shapes, not SQL; every per-person table carries `user_id TEXT NOT NULL DEFAULT 'u_owner'`, the platform-wide ones are named as such; **as built** (migration 200, 2026-10-12) that column is `owner_id` with a `created_by` beside it, the authorization seam's adoption rule 4, and the wire still says `userId`): `notify_destinations` (id, **user_id**, type, name, include_shared, enabled, kinds, quiet, include_detail, allow_private, signed, tz, hint, state, failures, last_ok_at, last_error_at, last_error, created_at, and a **sealed** `config`: a push endpoint and its two keys, or a channel URL and signing secret); `notify_keys` (**platform-wide**: id `vapid` or `topic`, a **sealed** `value`, a public key); `notify_user_prefs` (**user_id** primary key, deny, allow_read, allow_edit, allow_command); `notify_history` (**user_id**); `notify_log` (**user_id** copied from the destination, so a user reads only their own); `notify_held` (**user_id**; what quiet hours kept back); `notify_action_tokens` (hash, **user_id**, destination, event, session, request, decisions, class, expiry, used_at); `notify_session_flags` (session_id, **user_id**: "Notify when done" is each user's own); `platform_audit` (**platform-wide**, each row with a nullable `user_id` of the person it concerns). `ENCRYPTED_COLUMNS` gains `notify_destinations.config` and `notify_keys.value`. Retention: history and log 30 days, audit 90 days, used and expired tokens 1 day. Settings (group `notify`, platform-wide, an admin's): `notify.actions.enabled` (the ceiling on answers, on), `notify.baseUrl`, `notify.contact`. The four answer switches (Deny on; Read, Edit, Command off; turning one on asks for a confirmation, `PUT /api/notify/prefs` with `confirm: true`) are each user's own, in `notify_user_prefs`. Live: a topic `notify` ("changed, load again") and the `presence` message on the socket. The redactor learns `cpna_`, `cpwh_`, `cpws_` and the two webhook URL shapes. No Portal MCP tool changes a destination, a policy or answers a request: reads only, at the read scope, and none for agents.

### 11.9 Verification and status

| Check | How | Status |
| --- | --- | --- |
| RFC 8291 and 8292 | Known-answer test from Appendix A, decrypt round trip, ES256 verify | ✅ `notify/webpush.test.ts`: all eight Appendix A values, the RFC receiver key decrypts, 3,993 bytes of plaintext make exactly 4,096, the JWT verifies (`aud` origin, `exp` 12 h, never over 24 h) |
| Payload shape, size, `Topic`, tags | Unit tests; a canary for every text rule | ✅ `webpush.test.ts`, `pipeline.test.ts`, `adapters.test.ts`: the payload as §11.3, `Topic` 32 base64url characters, canaries in session titles, commands, error texts, ticket and commit text reach no payload, Inbox row, log or audit row; detail only with "Include detail" |
| Push round trip in a browser | Headless Chromium over CDP: grant the permission, register the worker from a production build, `ServiceWorker.deliverPushMessage`, check `showNotification`, drive the click handler through its pure function; no real push service is contacted (no real accounts) | ✅ N2, 2026-10-12, Chromium 154 against a stand-in portal (N1's routes did not exist yet): worker registered from the production build; a delivered payload showed title, body, tag, `renotify` and Deny and Review buttons; a garbage payload still showed a fixed notification; the click path (through `self.__pilotPush.handleClick` in the worker target) sent a real `fetch` that carried the `SameSite=Strict` cookie, `Origin` and `Sec-Fetch-Site: same-origin`, with the token only in the body; a 409 produced "Couldn't answer · open" with "Already answered". Against N1's real `act` route: 🔬 still to repeat |
| Channels | A local stand-in server (the guard takes an injected `allowPrivate` in tests only): signature, retries, 429, redirect refused, DNS to a private address refused | ✅ `channels.test.ts` (the signature vector, Discord `allowed_mentions` and length, Slack escaping), `egress.test.ts` (literals in 12 spellings refused before any lookup, ANY private answer refused, a rebinding name refused at connect time, metadata refused even with the tick, no redirect, 4 KB, time limit), `pipeline.test.ts` (now, 30 s, 5 min; `Retry-After`; 3 failing, 20 disabled) |
| Answers | The table in §11.7 | ✅ `actions.test.ts` and `routes.test.ts`: forged, truncated, other request, other device, other user (`unknown`), no cookie 401, foreign Origin 403, replay 409, two at once (one wins), Deny token as Allow, switch off after the push, ceiling off, tool or text changed, crafted paths and commands, outside-started sessions, closed, ended, expired, removed device, Locked, 200 pending at most, 5 refusals then 429 |
| Across users (when accounts exist; the suite is written now with two fake users) | User B cannot list, read, change, test or remove user A's destinations, history, log, prefs or flags; cannot register A's endpoint for A; cannot answer with A's token or on A's request; cannot subscribe to A's presence; an event about A's session never reaches B unless it is shared and B opted in; B's sign-out does not touch A's devices | CI (N5) |
| Real devices | iOS Home Screen, Android Chrome, desktop Chrome, Edge, Firefox 152+, Safari, screen readers, a device used by two people one after the other | 🔬 manual, roadmap §9 |

Milestones: **N1** (server: bus, adapters, destinations, pipeline, sender, channels, tokens, audit; migration 200) **Built, 2026-10-12**: `apps/server/src/platform/**` and `apps/server/src/notify/**`, 54 tests; checked end to end on port 3232 with the real app's middleware over a real chat controller (the chat test harness) and local stand-ins: a `Bash npm test` request reached a stand-in push service 3 s later, decrypted, with a Deny-only token; the answer without the cookie was 401, Allow with that token 403 `not_allowed`, Deny 200 and the transcript shows `denied`, the replay 409 `used`; a signed webhook verified; a private-address webhook answered `blocked_address`; the log and the audit hold codes only. **Not yet:** a real push service, Discord or Slack (stand-ins only, by rule), the unread count for the Bell (N2), the 🔬 rows; **N2** (web: worker, subscription, Notifications page, presence, toasts, session menu item) **Built against the contract, 2026-10-12**: `public/sw.js` and `apps/web/src/features/notify/**`, 31 tests (the worker under Node `vm`, the pure parts), and the flow below checked in Chromium on a stand-in portal at 390 and 1280 px, light and dark: turn on (stubbed subscription), device in the list, Send test (toast and Inbox row), events and quiet hours persist, a webhook to a private address shows `blocked_address`, an Allow switch asks for a confirmation, a new history item while the tab is in use is a toast, sign-out removes the registration. **Not yet:** a run against N1's real routes (they did not exist), the unread count on the nav's Bell, the server state of "Notify when done" (the menu remembers it per browser until a read route exists), and every 🔬 device row; contracts landed 2026-10-12.

### 11.10 Multi-user (PLAN-10)

| What | Rule |
| --- | --- |
| Ownership | Destinations, preferences, quiet hours, history, "Notify when done", answer switches and answer tokens belong to a user; a push device is a device under its user. The VAPID keys, the base URL, the contact and the ceiling on answers are platform-wide (an admin's). |
| Routing | Recipients come from the subject's owner (§11.2 Recipients), through one resolver (`ownersOf(subject)`, from the authorization layer when it lands; `u_owner` until then). Shared sessions notify a sharer only if their destination has "Also shared with me" on, and never another user's private session. |
| Answers | The session's user must match the token's user, and `can(user, 'operate', session)` is checked on arrival (§11.7). Sign-out, a disabled user and a revoked share end answers at once. |
| Devices | A push endpoint has one user at a time; an explicit sign-out removes the browser's registration; a handed-over phone stops notifying the first person (§11.4). |
| Admin acts | The ceiling on answers, the VAPID contact, the base URL and the emergency stop (roadmap phase 2) are admin settings. |
| Today | One user, `u_owner`; no screen shows users; the single-owner behaviour is the whole of what is built. |

## 12. HTTPS and sign-in

> **Multi-user (PLAN-10, 2026-10-12).** The one shared server code that §12.4 and §12.5 describe is replaced by **accounts** ([Identity and onboarding](identity-onboarding.md), overview in [Multi-user](multi-user.md)): a sign-in is a database row with a person and a device (the `devices` and `web_sessions` of §12.4 become the Devices list and `login_sessions`), re-auth (§12.5) is the person's own password, "Keep me signed in" and its 30 and 90 days stay as designed, and the code field, rotation and the sign-in switch of today's Access page go (the sign-in switch becomes a setting of the Registration control). §12.1 to §12.3 (why HTTPS, the front, the app listener, cookies, the CSP) stay as the outer layer: the cookie is `portal_session` on plain HTTP and `__Host-portal_session` with `Secure` over HTTPS, as §12.3 says. A Cloudflare Access email is an outer gate, not an account (Q2 stays an option for later). Built: nothing of this is built yet.

### 12.1 Why HTTPS

Service workers, push, notifications, badges, the async clipboard and passkeys need a secure context.
`http://localhost:3000` counts as one ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)); `http://192.168.1.20:3000` on a phone doesn't.

### 12.2 The front

| Piece | Detail |
| --- | --- |
| Recommended | **Cloudflare Tunnel with Cloudflare Access**, on Portal MCP's named tunnel (its §11.3). |
| Hostname | A second name one level under the zone, such as `cpapp.isnan.me`, routed to the app listener; Universal SSL covers only first-level names ([Cloudflare](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)). |
| Access | One-time PIN to the operator's email, or SSO, with the longest session, one month ([sessions](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)). The portal checks its token on every request (§12.3) and keeps the Access email on the device record. |
| Static paths | A more specific Access application with a Bypass policy covers `/assets/*`, `/icons/*`, `/manifest.webmanifest` and `/sw.js`, since the more specific path wins ([paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)). The repo is public, so nothing secret is exposed, and install and worker updates survive an expired Access session 🔬 (Q5). |
| Edge expiry | `/api/session` returns the Access token's `exp`. Three days before it a banner says "Edge sign-in ends Tue · Renew now". Renew goes through `/cdn-cgi/access/logout`, which ends every Access session in this browser, and signs in again, so the PIN comes when the admin chooses 🔬 (Q5). |
| Sockets | WebSockets work on every plan, but idle ones close and restarts drop them ([Cloudflare](https://developers.cloudflare.com/network/websockets/)), so sockets ping every 25 s. |
| Alternatives | Tailscale Serve to the app listener ([Tailscale](https://tailscale.com/kb/1312/serve)) keeps it private, but every device runs Tailscale and claude.ai still needs Portal MCP's tunnel; or the operator's own proxy with a real certificate. Self-signed certificates aren't supported 🔬. |

### 12.3 Portal changes

| Change | Detail |
| --- | --- |
| App listener | `127.0.0.1:PORTAL_APP_PORT` (default 3002), never forwarded (devcontainer `onAutoForward: ignore`). Serves the UI, `/api/*`, the terminal and the live socket for `PORTAL_APP_URL`'s host only. |
| Access check | Mode `cloudflare-access` with `PORTAL_ACCESS_TEAM` and `PORTAL_ACCESS_AUD`: verify `Cf-Access-Jwt-Assertion`'s RS256 signature against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` by `kid`, then `iss`, `aud` and `exp` with 60 s of skew ([Cloudflare](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)). Keys are cached and refetched on an unknown `kid` (Access rotates them every 6 weeks). A failure refuses the request, and the reason shows on the main listener's Access → Sign-in. The bypassed static paths need no token. Mode `tailscale` serves a tailnet front. |
| Client IP | Only the app listener trusts the front's header (`CF-Connecting-IP`; Tailscale's 🔬) for the sign-in limiter. The main listener stays plain HTTP for localhost and the LAN and ignores such headers (Portal MCP FR4). |
| Cookies | One per listener: `__Host-cp_session` (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`) on the app listener; today's `portal_session` without `Secure` on the main listener, since browsers refuse `Secure` cookies from plain HTTP off localhost. |
| Origins and links | CSRF and socket Origin checks compare against `PORTAL_APP_URL`, since tunnel requests arrive as `http://`. Portal MCP's `PORTAL_UI_URL` defaults to it. |
| CSP | `default-src 'self'; script-src 'self' 'sha256-<theme script>'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss://<app host>; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. xterm 6 adds `<style>` elements at runtime and takes no nonce; Chat's previews use `blob:` and `data:` images; older Safari doesn't match `wss:` with `'self'` ([WebKit bug 201591](https://bugs.webkit.org/show_bug.cgi?id=201591)). The main listener names its own `ws://` origin. Report-Only for one release first. |
| HSTS, exposure | HSTS for a year on the app host. With the front on the portal's host, `PORTAL_HOST=127.0.0.1`, or a firewall on port 3000 for the LAN and the Docker bridges that DinD workspaces reach (Chat §11). |

### 12.4 Sign-in that lasts

| Piece | Detail |
| --- | --- |
| Lifetimes | "Keep me signed in on this device" is on by default in the installed app and off in a tab. Kept sessions end after 30 days unused or 90 days at most (cookie `Max-Age`, under [Chrome's 400-day cap](https://developer.chrome.com/blog/cookie-max-age-expires)); others after 12 h. |
| Storage | SQLite rows keyed by the SHA-256 of a 256-bit token, so restarts sign nobody out; the code and sign-in switch persist per Portal MCP §12.5. A Frozen database falls back to memory. Tables: `devices`, `web_sessions`, `passkeys`; the notification tables are §11.8's (`notify_*`, with `user_id`), which replace `push_subscriptions`, `notification_prefs` and `notifications`. |
| Code field | `autocomplete="current-password"` beside a hidden username, `admin@<host>`, so iCloud Keychain and Google Password Manager save and fill the code; today's `one-time-code` is never saved. After a rotation, a "Save the new code" form (`new-password`) lets them update it 🔬. |
| Devices | An editable name ("iPhone · Safari"), browser, OS, seen times, kept flag, time zone, notifications and Access email. UI actions name the device in the event log ("Allowed by Alfian's iPhone"), browser take-overs and handoff answers included. |
| Rotation | Every other device gets one last push ("Signed out: the server code changed. Sign in to keep notifications."), then is signed out and loses its subscription. Signing out in one tab signs out every tab. |

### 12.5 Re-auth for sensitive actions

A code or passkey check within 10 minutes (`403 REAUTH_REQUIRED`, then ReauthSheet and a retry) guards
the server code (show, rotate, set), turning sign-in off, signing devices out, MCP tokens, relaxing
settings changes (Settings FR19), entering Bypass, and deleting a workspace or a pool with secrets; it
ships with the code in W2. Passkeys (W6, WebAuthn) sync through iCloud Keychain or Google Password
Manager, so they belong to the admin with a device label, and survive a rotation unless "Also remove
passkeys" is ticked. 🔬 Passkey sign-in inside the installed iOS app.

## 13. Performance and accessibility

### 13.1 Budgets

Lab budgets, as the portal has no field data: Lighthouse's mobile profile, an emulated Moto G Power at
150 ms RTT, 1.6 Mbps and 4× CPU slowdown ([throttling](https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md), [device](https://github.com/GoogleChrome/lighthouse/blob/main/core/config/constants.js)).

| Measure | Budget | Method | Gate |
| --- | --- | --- | --- |
| Home JavaScript (shell and session list), gzip | ≤ 170 KB | size-limit on the build | Fails the build |
| Any other route chunk, gzip | ≤ 100 KB | size-limit | Fails the build |
| Chat's session screen, gzip | ≤ 150 KB without the highlighter (its §12.7) | size-limit | Fails the build |
| CSS, gzip | ≤ 20 KB | size-limit | Fails the build |
| Precache at install | ≤ 350 KB compressed | size-limit on the precache manifest | Fails the build |
| LCP, cold | ≤ 2.5 s | Lighthouse mobile, median of 3 runs | Fails the build |
| TBT | ≤ 200 ms | The same runs | Fails the build |
| CLS | ≤ 0.1 | The same runs | Fails the build |
| INP | No interaction over 200 ms | `web-vitals` in Playwright flows (open a session, approve, switch tabs) at 4× CPU slowdown | Fails the build |
| Installed app, open to last data | ≤ 1.5 s to `performance.mark('data-visible')`, median of 5 runs | Playwright with the worker active, lab profile | Fails the build |
| Open to fresh data | ≤ 3 s | The same runs, to the first live summary | Fails the build |
| Socket back after `online` | ≤ 2 s, nothing lost or doubled | Playwright, offline then online | Fails the build |
| Event to push request sent | ≤ 2 s for 95 of 100 events | Mock push service | Fails the build |
| Lighthouse accessibility | ≥ 0.95 on every route | Lighthouse | Fails the build |
| JS heap | ≤ 150 MB | CDP after replaying an hour of Monitor and a streaming session at 10× speed | Warns |

Today: 241 KB gzip in one chunk (xterm about 88 KB), CSS 12 KB, the Latin font 27 KB. Code splitting
keeps xterm, markdown, highlighting and charts on their routes. Motion's `m` with `LazyMotion`, features
loaded after first paint (the nav pill's `layoutId` needs `domMax`), keeps about 29 KB out of the first load ([Motion](https://motion.dev/docs/react-reduce-bundle-size)).
Hidden tabs don't poll; Chat owns streaming budgets; Playwright tests install, as Lighthouse [dropped its PWA category](https://github.com/GoogleChrome/lighthouse/releases/tag/v12.0.0).

### 13.2 Accessibility (WCAG 2.2 AA)

- 44 px targets on phones (2.5.8 asks 24 px); focus visible and never under sticky bars (2.4.11); a
  single-pointer way for every drag (2.5.7). Status is color, shape and text; gold and flame only in
  icons, badges and large text. Reflow at 320 px and 200% zoom (1.4.10); no orientation lock (1.3.4).
- Sign-in takes paste, autofill and passkeys (3.3.8). Nav uses `aria-current`; badges have text
  ("Sessions, 2 need input"); banners are `role="status"`; Enter never approves; shortcuts use a
  modifier (2.1.4); the terminal has screen reader mode. axe runs on every route in both themes.

## 14. Component inventory

The rest of `@isnanme/ui` is used as is, except `useInstallPrompt` (§10.2). It shares this repo's owner,
so its changes ship in one minor release before W1 (or W1 vendors them under `apps/web/src/vendor/ui`).
New pieces go in `apps/web/src/components` before Chat and Monitoring ship UI.

| Piece | Where | What | First users |
| --- | --- | --- | --- |
| Dialog | `@isnanme/ui`, changed | Pushes a history entry, so Back closes it (§9.4) | Every sheet |
| PageTabs | `@isnanme/ui`, changed | Sticks at `var(--appbar-h)`, not `top-16`; an edge fade; scrolls the active tab into view | Monitor, workspace page, Settings |
| Toast | `@isnanme/ui`, changed | Sits above `--tabbar-h`, which immersive docks also set; an attention tone (gold "!") and an action button | Chat's composer, terminal, live view |
| TextArea | `@isnanme/ui`, changed | `mono` and `autoGrow` props | Persona editor |
| Hub, RoutedPageTabs, CommandPalette, InstallBanner, IosInstallGuide | Moved from pay into `@isnanme/ui` | As in pay; pay isn't in this repo | Pools hub, palette, install |
| Push client, `sw.js` share and click code, NotificationsPanel, OfflineBanner | Copied from pay; the server's sender is written with `node:crypto` (§11.4), not copied | OfflineBanner without its write queue | Worker, Notifications |
| AppShell, AccountMenu, PageHeader | `apps/web`, extended | Route flags, badges, back, banner slot, short touch, bell; Appearance, Install and version in the desktop account menu | Shell |
| ImmersiveLayout, PushedScreen, KeyBar, PickerSheet | New | §9.2's immersive frame; a full-screen layer with its own URL on phones, a panel or dialog on desktops; §9.3's key row, shared with the browser live view; one-level pickers, an anchored popover from 640 px and a bottom sheet below it ([Chat](chat-sessions.md) §12.4) | Terminal, session screen, live view; Agents, Files, Diff, Browser, Effective settings; Chat's pickers |
| StatusDot | New | Token color, shape and text, in attention order (Chat FR3's states), with Monitoring §14's looks: Interrupted's gold pause, the browser's In control | Everywhere |
| Meter, Sparkline, TrendChart, FreshnessLabel | New | A bar with bands and a threshold tick (from WorkspacesPage); inline SVG charts, TrendChart from pay's LineChart; "Updated 8 s ago", "Stale" | Workspaces, Monitor, accounts |
| NavBadge, ConnectionBanner, UpdatePrompt | New | A count or dot with text; §10.4's banners and update flow | Shell, Menu |
| NotificationSettings, ReauthSheet | New | §11.6; a passkey or the code, then retry | Notifications, Access, Settings |
| SecretInput | New | Write-only: never prefilled, "Replace value", hint and fingerprint (Secrets A7) | Accounts, Secrets, MCP sets |
| Disclosure, SelectionBar, DropZone | New | A row that expands (MCP set §15); Select, then checkboxes, then a bottom action bar for bulk actions on phones (foundation §10); drop or pick files with progress | MCP sets, Workspaces, skill import, Chat |
| CodeBlock, FileViewer, DiffView, formatters | New | Monospace, wrap or scroll inside, copy, line numbers, an always-dark variant with a hairline border in dark mode; `formatTokens`, `formatUSD` ("est."), `formatDuration` | Chat, skill review, persona history |

## 15. Security

1. **Nothing sensitive is stored in the browser or sent through push:** app files and one allowlisted
   summary in the worker (§10.3), templates over allowlisted fields in notifications (§11.1, §11.3),
   `no-store` on the API. Left over: a lost phone that stays offline shows that summary (names, states,
   counts) for up to 24 h, and a notification's text shows on a lock screen (§11.1: names and categories only, details only where a destination asks, §11.7). Push keys, subscriptions and channel URLs are sealed, so a copy of the database cannot push fake alerts (§11.4).
2. **Two checks on every request over HTTPS:** the Access token, verified by the portal (§12.3), and a
   hashed, persisted session with re-auth for sensitive actions (§12.4, §12.5).
3. **The page runs only its own code:** a strict CSP (§12.3), pushes that open only `/admin/` paths
   (§11.3), and a worker that never touches `/cdn-cgi/*`, OAuth, MCP or any API path but the summary.

## 16. Testing

| Area | What | Where |
| --- | --- | --- |
| Layout, navigation | Every route at 360, 390, 768, 1024, 1280 and 1536 px in both themes, plus 744×1133, 820×1180, 1180×820, 844×390 with the keyboard open, and a 375 px Split View; no sideways scroll at 320 px; at most 5 tabs; 2 taps to any section; deep links, cold-start Back, redirects for moved routes | CI (Playwright) |
| PWA, worker, CSP | Manifest, icons, content types, scope (pay's `pwa.spec.ts`); install (Chromium); the iOS guide; only the summary cached; offline start; an unknown `/assets/*` is 404; build A to B with two tabs, one holding unsaved input; an old tab opening a route it hasn't visited after B deploys; the terminal, image previews and the live socket under the real CSP header | CI |
| Leaks | Canary secrets from every pool type, canary transcript text, and canaries in a workspace's `detail`, an approval preview and a session title never reach caches, web storage or push payloads | CI |
| Push | Payload allowlist and declarative shape, `Topic` validity (≤ 32 base64url characters), RFC 8291 and 8292 vectors, 404 and 410 cleanup, throttling, quiet hours by time zone, active devices and escalation, against a mock push service; the channels' guard (private addresses, redirects, DNS answers that change), signatures and retries; every row of §11.7's abuse table; nothing sent and nothing answered while Locked | CI |
| Sign-in | Restarts keep sessions; lifetimes; rotation's last push and sign-out; re-auth and retry; sign-out across tabs; Access token checks (bad signature, wrong `aud`, unknown `kid`, skew) | CI |
| Edge | Behind a staging tunnel and Access: install, worker update, Access expired mid-session, tunnel down (Cloudflare's 502 and 530 pages), Renew, requests without a token refused | By hand 🔬 |
| Devices | iPhone on iOS 18 and 26 (installed, push, badge, terminal with the keyboard, passkeys, §10.5's checklist E1–E7); Android Chrome (installed, push, share, link capture); Chrome and Edge desktop; Safari Add to Dock | By hand, before W4 and W5 |
| Speed, access | §13.1's gates; axe on every route in both themes; keyboard only; VoiceOver and TalkBack | CI; by hand |

## 17. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| W1 | Route table, tab bar and Menu, Pools hub (the Accounts page moves in; `/admin/accounts` redirects) and workspace page frames, route flags, short touch, ImmersiveLayout with KeyBar (the terminal moves onto it), PushedScreen, PickerSheet, back and sheet rules, banner slot, StatusDot, Meter, charts, code splitting, the `@isnanme/ui` release | None; before Chat C1 and Monitoring D1 ship UI |
| W2 | Sessions and devices in SQLite, Keep me signed in, Access → Devices, sign-out across tabs, device names in the event log, re-auth with the code, the password-manager code field | Foundation F1 (built); Portal MCP MCP1 |
| W3 | App listener, `PORTAL_APP_URL`, Access token check, cookies, HSTS, CSP (Report-Only first), the tunnel and Access guide, Tailscale mode | MCP1; Q2 |
| W4 | Manifest, icons, worker, offline summary and states, update flow, two-build asset serving, install flows, attention summary, badges. Built early (2026-10-12): manifest shortcuts and an app badge from the glance count | W3 for phones (localhost desktops earlier) |
| W5 | VAPID and topic keys, subscriptions, §11.1's kinds, delivery rules, the Notifications page and bell, app badge. The platform track builds it in two packages from §11's 2026-10-12 design: N1 (server) and N2 (web), **Not built** | W4 for the app shell; Chat C1; Monitoring D3 for problems; U3 done with the manifest |
| W6 | Passkeys, share target, command palette, shortcuts and `launchQueue` routing | W3 |

## 18. Success metrics

| Metric (§13.1 gates speed and access in CI) | Target |
| --- | --- |
| Devices on the latest build within 24 h of an upgrade | ≥ 95% of devices used that day |
| Pushes accepted by the push service (2xx), per day | ≥ 99%, after 404 and 410 cleanup |
| Code sign-ins on a kept device | Zero within 90 days, except after a rotation |

## 19. Amendments to other PRDs

| ID | PRD and section | Change |
| --- | --- | --- |
| A1 | README; Browser & desktop pool; Skillset A8 | This PRD: Draft v0.6 (reviewed). The "One web app" rule adds: installable over HTTPS (`PORTAL_APP_URL`), with push for what needs the admin. The Browser & desktop pool stays (Q1): this app gives it the live-view route, the Browser tab and the handoff push its A11 asks for. |
| A2 | Foundation §4.1, §5, §10, §11 | Pool pages live in the Pools hub, an index list on phones. The Configuration panel is the workspace page's Configuration tab. Bulk assignment uses SelectionBar on phones. The Locked or Frozen banner uses the shell's banner slot and links to Settings → Data. Portal MCP A3's `ui` actor label is the device name. §4.1's list of encrypted columns gains the notification destinations and keys (§11.4: sealed, which replaces v0.6's plain-text push keys). §11's transport note points to the app listener and §12.2's guide. F1 adds §12.4's tables. |
| A3 | Portal MCP §11.2, A5, FR11, §12.5, §15 | Add the app listener to §11.2. A5 becomes: the UI, `/api/*` and the terminal are never on the public listener or hostname; over HTTPS only the app listener serves them, behind Access with its token checked, or a tailnet. `PORTAL_UI_URL` defaults to `PORTAL_APP_URL`; on iPhones its links open in Safari (§10.2). Keep an scrypt hash of the server code beside the encrypted copy, so sign-in works while Locked, in the built `portal_meta`. Access gets a Devices tab; its Storage section moves to Settings → Data; on phones its tabs are Menu rows. |
| A4 | Monitoring §4, §14, A7, A8, FR28, Q11, Q12 | Drop the non-goal "alerts outside the open page": alerts go out as push (§11). §14's NAV: the phone tab bar is Sessions · Workspaces · Monitor · Pools · Menu, and Access is its own destination, not inside Settings. The Security tab becomes Events, the event log (A7) with saved filters All and Security; Security keeps its StatGrid and Policy card above the feed. A8's workspace page has four tabs (§8): Resources and Data sources go to Overview, Agents to Sessions, and Events, Processes and MCP & tools to Activity. FR28 items carry a notification kind and a stable tag, and health items badge Monitor only. StatusDot, Meter and the charts come from W1. Push answers Q11; device names answer Q12. |
| A5 | Chat §10.4, §12, FR9, FR25, A2, Q11, Q14 | The socket becomes the app's one live socket (`/api/live`), adding tab `presence` and the attention summary. FR9: offline, one pending message is held in memory only, shown as "Sends when back online · Cancel", lost on reload and never stored. §12.3: Enter sends whenever a hardware keyboard is in use, whatever the width (§9.4). §12.4: ⌘K opens the global palette scoped to sessions. FR25's tab title becomes "(2) Sessions · <name>". The session ⋯ menu adds "Notify when done". `panes` routes are full width (§9.2). `/admin/sessions/share` takes shared images. Requests and failed turns feed the attention service. Q11 and Q14 are answered here. |
| A6 | Settings §15, FR19, §11.4 | Settings sits under Menu on phones, one row per tab. "Effective settings" is a pushed screen on phones, not a sheet. Data takes today's Storage section and is the Locked or Frozen banner's target. The policy editor is a `task` route on phones. FR19's relaxing changes and entering Bypass require re-auth, from W2. Retention adds devices (90 days after last seen) and notification history (30 days). |
| A7 | Account Pool §13; Secrets & env §12, A7 | Their pages become the Pools hub's Accounts and Secrets tabs; `/admin/accounts` redirects. Account problems feed the attention service and the Account push kind. Secrets enter attention at 14 days (Monitoring FR28) and the Expiring digest at 3 days. The Secrets set editor is a `task` route on phones. SecretInput comes from W1. |
| A8 | Skillset A8, Persona §15, MCP set §15 | Accepted with tab ids `skills`, `personas`, `mcp` and `browser`. MCP set's Catalog becomes its own route, `/admin/pools/mcp/catalog`, like Skillset's Library, and its set editor is a `task` route on phones. Persona's TextArea props ship upstream (§14). |
| A9 | §7 FR1, FR2; §8 | **Built** (owner direction 2026-10-12, QA/core): the navigation is `NAV` in `apps/web/src/app/nav.ts`; each item has a `group` (`work` or `admin`) and an optional `bar`. The phone bar is icon only (name in `aria-label` and `title`, a pill on the current one, 72-78 px by 64 px targets) and shows the `bar` items, today Workspaces, Sessions, Tickets and Knowledge, plus a More button whose sheet lists every other item with its label. The sidebar and rail list everything, work first and admin after one divider, no headings. This replaces FR2's list (Sessions, Workspaces, Monitor, Pools, Menu): a page added later sets `group` and leaves `bar` unset. Checked at 360, 390, 768 and 1280 px, light and dark. |
| A10 | Tickets Q3 and "Notifications outside the portal"; Chat FR22, FR23, FR25; Claude usage §12 | Answered by §11: push and channels for "needs you"; an answer from a notification only as §11.7 says (Chat FR22 and FR23 stay as they are in the app); the usage alert sink (`onAlert`) feeds `quota_low`. |
| A11 | §7 FR6, §10.1, §17 W4 | **Built** (round 4, glance widgets): manifest shortcuts (New session, Sessions, Needs attention) and the app badge written by the page from the glance aggregator's needs-attention count, set while the app is open and not updated after it closes (no push). `?glance=<id>` on any `/admin` URL opens a widget's full form and `/admin/sessions?new=1` opens New session. See [Glance widgets](glance-widgets.md). |

## 20. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | Answered by the owner: this app is the full web frontend for desktops and phones, and agents also get a browser and desktop through the [Browser & desktop pool](browser-desktop-pool.md) (§2, A1). | — |
| Q2 | App hostname and front: Cloudflare Tunnel and Access on a first-level name such as `cpapp.isnan.me` (proposed), or Tailscale only? Must Access always be in front? Option: "Trust the Access identity for sign-in", with an email allowlist, so the installed app signs in once, keeping the code for re-auth. Depends on where the portal runs (Portal MCP Q1). | Operator |
| Q3 | Lifetimes: 12 h, or 30 days unused and 90 days at most when kept; re-auth lasting 10 minutes. Right? | Operator |
| Q4 | Quiet hours off by default, since phones' Focus modes cover most needs, or 22:00–07:00 on new devices? Keep the one offline summary, or nothing? The platform track builds it off by default with one summary when the window ends (§11.2); owner decision O10. | Product |
| Q5 | 🔬 Behind Access, with the static paths bypassed, does the installed app install, update its worker and recover from an expired Access session on iOS and Android? Does Renew restart the month? | Device test |
| Q6 | Home screens will show the app's name next to Anthropic's Claude app. Check "pilot" against Anthropic's trademark guidelines, then fix one display name and one short name (Chat Q13). | Operator |
| Q7 | 🔬 Do high-urgency pushes reach an iPhone within seconds after days unopened? Does Apple's push service collapse by `Topic`? Does Safari hand `mutable` declarative pushes to the worker? | Device test |
| Q8 | Passkeys in W6 or later? Should notifications ever show session titles? Never: a session's own agent can rename it, so a title is text an attacker may write (§11.1). | Product |
| Q9 | 🔬 Under `focus-existing`, does Chrome on Android open the share target's POST in a new window or hand it to the open one? | Device test |
| Q10 | Answering from a notification (§11.7): is "Deny and Review on, every Allow off until switched on" the right default? Should Command ever be allowed from a lock screen? Owner decision O1 in the [platform roadmap](platform-roadmap.md). | Owner |
| Q11 | Push keys and channel URLs are sealed, so a Locked portal sends nothing and the earlier "Locked alert" is dropped. Accept, or keep one plain-text emergency channel? Owner decision O4. | Owner |
| Q12 | Interactive buttons in Discord and Slack (a public interactions endpoint, an application in each): wanted later? Owner decision O6. | Owner |
