# PRD: Web app & PWA

| | |
| --- | --- |
| Status | **Draft v0.6.** Written from the codebase, the pay reference app, the sibling PRDs and platform docs (MDN, web.dev, WebKit, Chrome, Cloudflare, RFC 8030, the Push API draft), checked 2026-10-10, then revised after review. v0.6 is a consistency pass: Chat A2 and Browser & desktop A11 applied. 🔬 = unverified: needs a check on real devices or behind the real tunnel before it becomes an acceptance criterion. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-10 |
| Depends on | [Pools foundation](foundation-pools.md) F1 (storage and encryption, built), [Portal MCP server](portal-mcp.md) MCP1 (persisted server code, listeners, tunnel) |
| Related | [Chat sessions](chat-sessions.md), [Monitoring dashboard](monitoring-dashboard.md), [Settings & policies](settings-policies.md), [Account Pool](account-pool.md), the [Skillset](skillset-pool.md), [Persona](persona-pool.md), [MCP set](mcpset-pool.md) and [Secrets & env](secrets-env-pool.md) pools; [Browser & desktop pool](browser-desktop-pool.md) (its live view, §2) |

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
| FR6 | Shell | One attention summary feeds the nav badges, the app badge (Needs input only), the tab title and notifications, over the live socket, or `GET /api/attention` every 30 s until that socket exists. Each item badges one destination. |
| FR7 | Shell | A command palette (⌘K or Ctrl+K; search in the phone app bar) opens any workspace, session, pool, account, setting or page. On Sessions it opens scoped to sessions. |
| FR8 | Shell | One banner slot, highest first: signed out or edge sign-in expired; offline or reconnecting; Locked or Frozen; edge sign-in ending; update ready; install. Each banner is one 40 px line; phones show one, desktops two. |
| FR9 | PWA | Manifest, icons, install flows and `launchQueue` routing; a worker that stores app files and one summary response, nothing else; Android shares images into Chat (§10.1–§10.3). |
| FR10 | PWA | Opening, offline, unreachable and edge sign-in states; updates that reload only the tab that asked (§10.4). |
| FR11 | Notifications | Each device opts in from a tap, can send itself a test, and shows its last delivery or error (§11.4). |
| FR12 | Notifications | §11.1's kinds with their defaults, each switchable per device, under §11.2's rules. |
| FR13 | Notifications | Templated, encrypted, declarative payloads that open only portal pages (§11.3). A Notifications page lists the last 7 days, pushed or not. |
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
| Notifications (Bell) | `/admin/notifications` | The last 7 days and this device's switches (§11.4), opened from the bell and Menu | Unread count |
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
| Under 640 px wide | App bar (64 px) on top, tab bar (64 px) below, both padded by the safe-area insets | One column, 16 px gutters; dialogs are bottom sheets; PageTabs show one section at a time |
| 640–1023 px (the design system's `useIsDesktop` switch, kept) | Icon rail, 80 px, with short labels | One column up to 896 px, 24 px gutters; dialogs centred |
| 1024 px and up | Sidebar, 256 px; the rail on `panes` routes | `wide` routes up to 1280 px; Monitor and the workspace page in two columns from 1280 px |
| Short touch: `(pointer: coarse) and (max-height: 500px)`, such as a phone in landscape; checked at load and on orientation change, never while a field has focus, so a shrinking keyboard never switches layouts mid-typing | Compact rail: 48 px icons without labels, scrolling | Bottom sheets at any width; the session screen immersive; rail and content padded by the left and right insets |

### 9.2 Route flags

| Flag | Effect | Used by |
| --- | --- | --- |
| `wide` | Content up to 1280 px from 1024 px | Monitor, the workspace page, Settings |
| `panes` | Full width, the sidebar narrowed to the rail from 1024 px: a 320 px list, the transcript (24 px padding, text up to 760 px) and, from 1280 px, a 360 px panel (Agents, Files, Diff). Transcript text is the window minus 808 px with the panel (472 px at 1280, 760 from 1568), minus 448 px without (760 from 1208). | Sessions |
| `immersive` | No app bar, tab bar, rail or sidebar. A 48 px header (back, title, subtitle, StatusDot, ⋯) below the top inset, the banner line under it, and a dock above the bottom inset that sets `--tabbar-h` so toasts clear it | The terminal and the browser live view at every width; the session screen under 640 px and in short touch |
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
| `shortcuts`, `launch_handler` | New session, Monitor, Workspaces (Android, desktop Chrome and Edge, macOS Safari; not iOS). `focus-existing` (Chrome and Edge): the open window takes focus and gets the URL through `launchQueue` without navigating ([MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/launch_handler)); our consumer routes inside the app, or asks first when the tab holds unsaved input. |
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
| The worker | `vite-plugin-pwa` 1.3.x with `injectManifest`: our `sw.ts` with Workbox precaching, navigation preload, and pay's share and notification handlers. Registered from a file (no inline script), on secure contexts only, with scope `/`; `sw.js` is served `no-cache`. |
| Navigations to `/`, `/login`, `/admin/*` | Network first with navigation preload ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent/preloadResponse)). The precached shell answers on a network error, after 4 s, or on 502–504 and 520–530 (Cloudflare's own pages when the portal or tunnel is down). Never cache-first: a cached shell hides Access's sign-in redirect ([Node-RED behind Access](https://discourse.nodered.org/t/dashboard-2-0-pwa-service-worker-prevents-authentication-redirect-when-session-expires/100574)). |
| `/assets/*`, `/icons/*`, the manifest | Precached: the shell, the Latin font, and the chunks of routes with offline data (the session list, Workspaces, Monitor's Overview). Other chunks are cached on first use, up to 60. Only 2xx responses whose Content-Type matches the extension are stored; Workbox's CacheFirst stores any 200 by default ([Workbox](https://developer.chrome.com/docs/workbox/modules/workbox-cacheable-response)). |
| An unknown `/assets/*` path | 404 with `no-store`. Today it gets the app page as `200 text/html`, stamped `immutable`. The deploy keeps the previous build's assets in `dist-prev` for 7 days and the server serves both, since Vite's `emptyOutDir` deletes them and open tabs still lazy-load routes. |
| `GET /api/offline/summary` | The one API response kept, for 24 h, in `cp-data`. Built from a field allowlist: workspace id, name, target and status; counts by state; attention counts by kind; `asOf`. Stored only when the path is on the worker's list and the response carries `X-Offline-Cache: 1`, which only the server sets. |
| Every other `/api/*`, the sockets, `/mcp`, `/oauth/*`, `/connect/*`, `/.well-known/*`, `/cdn-cgi/*`, `/healthz` | Never handled or stored. The server marks `/api/*` `Cache-Control: no-store`, the HTML `no-cache`, and hashed assets `immutable`. |
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

## 11. Notifications

### 11.1 Kinds

| Kind | Default | Fires when | Title · body | Opens |
| --- | --- | --- | --- | --- |
| Needs input | On | A chat session asks for approval (tool, edit, plan, workflow) or an answer ([Chat](chat-sessions.md) FR22–FR25); an agent asks for the admin in its browser ([Browser & desktop](browser-desktop-pool.md) §15.4) | Approval needed · api-dev wants to run a command; Question waiting · api-dev; Sign-in needed · api-dev, body "The agent is waiting in its browser" (no host) | The request, or the live view (`…/browser?handoff=<id>`) |
| Failed | On | A chat or terminal turn fails | Session failed · api-dev · rate limit | The session |
| Workspace | On | Error, OOM kill, 3 restarts in 15 minutes, disk under 5% | Workspace problem · api-dev · out of memory | Workspace, Overview |
| Account | On | Invalid, billing, exhausted, pool waiting for quota, budget reached or paused | Account needs attention · prod-2 · invalid key | Pools, Accounts |
| Portal | On | Locked or Frozen at start; delivery failing in 3 or more workspaces | Portal needs attention · locked | Settings, Data |
| Security | On | High-severity events (Monitoring §12, Portal MCP lockdown); a new device signs in | Security alert · api-dev · Bypass in use; New sign-in · iPhone, Safari | Monitor, Events (Security); Access, Devices |
| Done | Off | "Notify when done" on a session (Chat's ⋯), or the device option "Turns of 5 min or more while I'm away" | Session finished · api-dev · 12 min | The session |
| Expiring | Off | A digest at 09:00 device time while secrets expire within 3 days | 2 secrets expire soon | Pools, Secrets |
| Terminal waiting | Not offered | Until Chat Q15 gives a way to answer a terminal session from the portal | — | — |

Text is a template with workspace, account and device names, fixed categories (command, file edit, web
request, MCP tool, plan, workflow; rate limit, auth, billing, error) and times: never prompts, replies,
commands, paths, URLs, error text, secret names or session titles.

### 11.2 Delivery rules

| Rule | Behavior |
| --- | --- |
| Active device | Tabs report `presence {visible, session}` on the live socket. While a device is visible and used in the last 2 minutes, it gets toasts and history entries instead of pushes, and nothing for the session it shows. Other devices get nothing, except Needs input and Security, which push to them after 60 s if still open. |
| Collapse | One notification per item, under a readable tag (`session:<id>`, `ws:<id>:<kind>`, `browser:<workspace>`) carried only inside the encrypted payload, replaced in place. `renotify` for Needs input and Failed, so a replacement alerts again. |
| Topic | `Topic` keeps only the latest push per topic for an offline device. RFC 8030 allows at most 32 URL-safe Base64 characters, and push services refuse others with 400 ([RFC 8030 §5.4](https://www.rfc-editor.org/rfc/rfc8030.html#section-5.4)), so it is the first 32 characters of base64url(HMAC-SHA256(topic key, tag)), which also hides IDs from push services. |
| Resolved elsewhere | No silent push closes a notification: Safari revokes subscriptions whose pushes show nothing ([WebKit](https://webkit.org/blog/12945/meet-web-push/)), and Chrome shows a generic notice instead. The app closes resolved ones when it opens (`getNotifications`); a resolved request says "Already allowed on MacBook · 14:03". |
| Throttle | One push per tag per minute, 10 per device per 10 minutes; the rest become "3 more items need you". |
| Quiet hours | Per device, in the IANA time zone stored with its subscription; off by default (preset 22:00–07:00). Only Security and Portal may break through, chosen per device; one summary of what's still open follows. |
| Urgency, TTL | Needs input and Security `high` (1 h; Security 24 h); others `normal` (6–24 h); Expiring `low`. |

### 11.3 Payload and click

`{"web_push":8030,"mutable":true,"notification":{"title":"Approval needed","body":"api-dev wants to run a command","navigate":"https://cpapp.isnan.me/admin/sessions/s_41?request=r_7","tag":"session:s_41","app_badge":"3","data":{"v":1,"id":"ntf_8f2c","kind":"approval"}}}`

Every push uses this Declarative Web Push shape, which iOS and iPadOS 18.4+ Home Screen apps and Safari
18.5+ on macOS show without our code ([WebKit](https://webkit.org/blog/16535/meet-declarative-web-push/)).
`mutable` hands it to our worker first ([Push API](https://w3c.github.io/push-api/)) 🔬; other browsers
deliver it to the worker as before. The worker parses the same JSON everywhere, applies the tag,
`renotify` and the badge, and opens only same-origin `/admin/` paths; if it fails, Safari shows the
message as sent. Under 1 KB (push services must take 4,096 bytes), encrypted (aes128gcm), VAPID-signed,
with no action buttons: Safari has none, and a decision needs the whole request on screen (Chat FR22).

### 11.4 Support and subscriptions

| Topic | Detail |
| --- | --- |
| Support | Push in Android and desktop browsers, and on iPhone and iPad (16.4+) only in Home Screen apps, asked from a tap ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)); Firefox 72+ and Safari refuse prompts without one ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API)). Badges: Chrome and Edge 81+, Safari 17+, iOS 16.4+ with notifications allowed; Android shows dots. |
| Turning on | The Notifications page says what arrives ("never message text") and asks only on "Turn on", since a blocked prompt is hard to undo ([web.dev](https://web.dev/articles/push-notifications-permissions-ux)). States: Unsupported, Add to Home Screen first, Blocked (how to unblock), Off, On (last delivery or error, Send test). |
| Per device | A subscription belongs to a device record, with its time zone; sign-in re-registers it (pay's `syncPush`). Sign-out, signing the device out, expiry, rotation and a push service 404 or 410 end it. |
| Keys, sending | One VAPID key pair and a random topic key, made on first use and kept unencrypted in `portal_meta` (like A3's scrypt hash of the code), with endpoints and keys in `push_subscriptions`, so a Locked portal can still send its Portal alert. A leak lets someone push fake alerts to our own devices, which open only portal pages. Subject `PORTAL_PUSH_CONTACT` or `PORTAL_APP_URL`; pay's Web Crypto sender (RFC 8291, 8292); outbound HTTPS only to push services. |

## 12. HTTPS and sign-in

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
| Storage | SQLite rows keyed by the SHA-256 of a 256-bit token, so restarts sign nobody out; the code and sign-in switch persist per Portal MCP §12.5. A Frozen database falls back to memory. Tables: `devices`, `web_sessions`, `push_subscriptions`, `notification_prefs`, `notifications` (30 days), `passkeys`. |
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
| Push client and sender, `sw.js` share and click code, NotificationsPanel, OfflineBanner | Copied from pay | OfflineBanner without its write queue | Worker, Notifications |
| AppShell, AccountMenu, PageHeader | `apps/web`, extended | Route flags, badges, back, banner slot, short touch, bell; Appearance, Install and version in the desktop account menu | Shell |
| ImmersiveLayout, PushedScreen, KeyBar, PickerSheet | New | §9.2's immersive frame; a full-screen layer with its own URL on phones, a panel or dialog on desktops; §9.3's key row, shared with the browser live view; one-level pickers, an anchored popover from 640 px and a bottom sheet below it ([Chat](chat-sessions.md) §12.4) | Terminal, session screen, live view; Agents, Files, Diff, Browser, Effective settings; Chat's pickers |
| StatusDot | New | Token color, shape and text, in attention order (Chat FR3's states), with Monitoring §14's looks: Interrupted's gold pause, the browser's In control | Everywhere |
| Meter, Sparkline, TrendChart, FreshnessLabel | New | A bar with bands and a threshold tick (from WorkspacesPage); inline SVG charts, TrendChart from pay's LineChart; "Updated 8 s ago", "Stale" | Workspaces, Monitor, accounts |
| NavBadge, ConnectionBanner, UpdatePrompt | New | A count or dot with text; §10.4's banners and update flow | Shell, Menu |
| NotificationSettings, ReauthSheet | New | §11.4; a passkey or the code, then retry | Notifications, Access, Settings |
| SecretInput | New | Write-only: never prefilled, "Replace value", hint and fingerprint (Secrets A7) | Accounts, Secrets, MCP sets |
| Disclosure, SelectionBar, DropZone | New | A row that expands (MCP set §15); Select, then checkboxes, then a bottom action bar for bulk actions on phones (foundation §10); drop or pick files with progress | MCP sets, Workspaces, skill import, Chat |
| CodeBlock, FileViewer, DiffView, formatters | New | Monospace, wrap or scroll inside, copy, line numbers, an always-dark variant with a hairline border in dark mode; `formatTokens`, `formatUSD` ("est."), `formatDuration` | Chat, skill review, persona history |

## 15. Security

1. **Nothing sensitive is stored in the browser or sent through push:** app files and one allowlisted
   summary in the worker (§10.3), templates over allowlisted fields in notifications (§11.1, §11.3),
   `no-store` on the API. Left over: a lost phone that stays offline shows that summary (names, states,
   counts) for up to 24 h, and anyone who reads the database can push fake alerts (§11.4).
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
| Push | Payload allowlist and declarative shape, `Topic` validity (≤ 32 base64url characters), RFC 8291 and 8292 vectors, 404 and 410 cleanup, throttling, quiet hours by time zone, active devices and escalation, a Locked start's alert, against a mock push service | CI |
| Sign-in | Restarts keep sessions; lifetimes; rotation's last push and sign-out; re-auth and retry; sign-out across tabs; Access token checks (bad signature, wrong `aud`, unknown `kid`, skew) | CI |
| Edge | Behind a staging tunnel and Access: install, worker update, Access expired mid-session, tunnel down (Cloudflare's 502 and 530 pages), Renew, requests without a token refused | By hand 🔬 |
| Devices | iPhone on iOS 18 and 26 (installed, push, badge, terminal with the keyboard, passkeys); Android Chrome (installed, push, share, link capture); Chrome and Edge desktop; Safari Add to Dock | By hand, before W4 and W5 |
| Speed, access | §13.1's gates; axe on every route in both themes; keyboard only; VoiceOver and TalkBack | CI; by hand |

## 17. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| W1 | Route table, tab bar and Menu, Pools hub (the Accounts page moves in; `/admin/accounts` redirects) and workspace page frames, route flags, short touch, ImmersiveLayout with KeyBar (the terminal moves onto it), PushedScreen, PickerSheet, back and sheet rules, banner slot, StatusDot, Meter, charts, code splitting, the `@isnanme/ui` release | None; before Chat C1 and Monitoring D1 ship UI |
| W2 | Sessions and devices in SQLite, Keep me signed in, Access → Devices, sign-out across tabs, device names in the event log, re-auth with the code, the password-manager code field | Foundation F1 (built); Portal MCP MCP1 |
| W3 | App listener, `PORTAL_APP_URL`, Access token check, cookies, HSTS, CSP (Report-Only first), the tunnel and Access guide, Tailscale mode | MCP1; Q2 |
| W4 | Manifest, icons, worker, offline summary and states, update flow, two-build asset serving, install flows, attention summary, badges | W3 for phones (localhost desktops earlier) |
| W5 | VAPID and topic keys, subscriptions, §11.1's kinds, delivery rules, the Notifications page and bell, app badge | W4; Chat C1; Monitoring D3 for problems |
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
| A2 | Foundation §4.1, §5, §10, §11 | Pool pages live in the Pools hub, an index list on phones. The Configuration panel is the workspace page's Configuration tab. Bulk assignment uses SelectionBar on phones. The Locked or Frozen banner uses the shell's banner slot and links to Settings → Data. Portal MCP A3's `ui` actor label is the device name. §4.1 notes that push keys and subscriptions stay unencrypted (§11.4). §11's transport note points to the app listener and §12.2's guide. F1 adds §12.4's tables. |
| A3 | Portal MCP §11.2, A5, FR11, §12.5, §15 | Add the app listener to §11.2. A5 becomes: the UI, `/api/*` and the terminal are never on the public listener or hostname; over HTTPS only the app listener serves them, behind Access with its token checked, or a tailnet. `PORTAL_UI_URL` defaults to `PORTAL_APP_URL`; on iPhones its links open in Safari (§10.2). Keep an scrypt hash of the server code beside the encrypted copy, so sign-in works while Locked, in the built `portal_meta`. Access gets a Devices tab; its Storage section moves to Settings → Data; on phones its tabs are Menu rows. |
| A4 | Monitoring §4, §14, A7, A8, FR28, Q11, Q12 | Drop the non-goal "alerts outside the open page": alerts go out as push (§11). §14's NAV: the phone tab bar is Sessions · Workspaces · Monitor · Pools · Menu, and Access is its own destination, not inside Settings. The Security tab becomes Events, the event log (A7) with saved filters All and Security; Security keeps its StatGrid and Policy card above the feed. A8's workspace page has four tabs (§8): Resources and Data sources go to Overview, Agents to Sessions, and Events, Processes and MCP & tools to Activity. FR28 items carry a notification kind and a stable tag, and health items badge Monitor only. StatusDot, Meter and the charts come from W1. Push answers Q11; device names answer Q12. |
| A5 | Chat §10.4, §12, FR9, FR25, A2, Q11, Q14 | The socket becomes the app's one live socket (`/api/live`), adding tab `presence` and the attention summary. FR9: offline, one pending message is held in memory only, shown as "Sends when back online · Cancel", lost on reload and never stored. §12.3: Enter sends whenever a hardware keyboard is in use, whatever the width (§9.4). §12.4: ⌘K opens the global palette scoped to sessions. FR25's tab title becomes "(2) Sessions · <name>". The session ⋯ menu adds "Notify when done". `panes` routes are full width (§9.2). `/admin/sessions/share` takes shared images. Requests and failed turns feed the attention service. Q11 and Q14 are answered here. |
| A6 | Settings §15, FR19, §11.4 | Settings sits under Menu on phones, one row per tab. "Effective settings" is a pushed screen on phones, not a sheet. Data takes today's Storage section and is the Locked or Frozen banner's target. The policy editor is a `task` route on phones. FR19's relaxing changes and entering Bypass require re-auth, from W2. Retention adds devices (90 days after last seen) and notification history (30 days). |
| A7 | Account Pool §13; Secrets & env §12, A7 | Their pages become the Pools hub's Accounts and Secrets tabs; `/admin/accounts` redirects. Account problems feed the attention service and the Account push kind. Secrets enter attention at 14 days (Monitoring FR28) and the Expiring digest at 3 days. The Secrets set editor is a `task` route on phones. SecretInput comes from W1. |
| A8 | Skillset A8, Persona §15, MCP set §15 | Accepted with tab ids `skills`, `personas`, `mcp` and `browser`. MCP set's Catalog becomes its own route, `/admin/pools/mcp/catalog`, like Skillset's Library, and its set editor is a `task` route on phones. Persona's TextArea props ship upstream (§14). |

## 20. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | Answered by the owner: this app is the full web frontend for desktops and phones, and agents also get a browser and desktop through the [Browser & desktop pool](browser-desktop-pool.md) (§2, A1). | — |
| Q2 | App hostname and front: Cloudflare Tunnel and Access on a first-level name such as `cpapp.isnan.me` (proposed), or Tailscale only? Must Access always be in front? Option: "Trust the Access identity for sign-in", with an email allowlist, so the installed app signs in once, keeping the code for re-auth. Depends on where the portal runs (Portal MCP Q1). | Operator |
| Q3 | Lifetimes: 12 h, or 30 days unused and 90 days at most when kept; re-auth lasting 10 minutes. Right? | Operator |
| Q4 | Quiet hours off by default, since phones' Focus modes cover most needs, or 22:00–07:00 on new devices? Keep the one offline summary, or nothing? | Product |
| Q5 | 🔬 Behind Access, with the static paths bypassed, does the installed app install, update its worker and recover from an expired Access session on iOS and Android? Does Renew restart the month? | Device test |
| Q6 | Home screens will show the app's name next to Anthropic's Claude app. Check "pilot" against Anthropic's trademark guidelines, then fix one display name and one short name (Chat Q13). | Operator |
| Q7 | 🔬 Do high-urgency pushes reach an iPhone within seconds after days unopened? Does Apple's push service collapse by `Topic`? Does Safari hand `mutable` declarative pushes to the worker? | Device test |
| Q8 | Passkeys in W6 or later? Should notifications ever show session titles (proposed: never)? | Product |
| Q9 | 🔬 Under `focus-existing`, does Chrome on Android open the share target's POST in a new window or hand it to the open one? | Device test |
