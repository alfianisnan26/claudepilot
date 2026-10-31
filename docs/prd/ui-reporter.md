# UI reporter

Draft v0.1 (2026-10-31). The build started on the owner's word WITHOUT a prior PRD review (D-105); this PRD records what the build is meant to do, and the owner's review can still change it. Nothing here is verified yet: every checklist item in §14 is open. Contract (fixed): `packages/contracts/src/reporter.ts` (commit `caca8c39`, branch `feat/ui-reporter`). No portal ticket exists; commits carry `Ticket: none (owner request 2026-10-31, docs/prd/ui-reporter.md)`.

## 1. Summary

An embeddable UI/UX reporter for web apps. One script tag adds a floating button. A person on the page takes a screenshot (full page or a crop), comments it, and files it as a portal ticket, or sends it straight to a session. The report carries the evidence an agent needs: console, network, components, performance, page, device, state, build (commit, branch, environment), repro steps, UI checks. Open tickets show back on the page as callouts, with their live phase up to "deployed". First site: the Konfersi landing page on STG (`https://stg.konfersi.com`, behind Cloudflare Access).

## 2. Problem

- A UI bug seen on a page reaches an agent as a screenshot in chat, with no page, no build, no console, no device. The agent guesses which commit and which page.
- Nothing says whether a fixed ticket is live on the environment where it was seen.
- The same repo runs on several domains and environments (stg, uat, prod). A ticket must always know where it belongs.
- On a phone the snapshot and crop flow is tight.

## 3. Users

| Who | Need |
| --- | --- |
| Owner and testers (signed in to the portal) | Report fast from phone or laptop, see what is already reported on the page, know if it is fixed and deployed. |
| Agents (sessions) | A ticket they can act on from the description alone: page, commit, device, steps, errors. |
| The lead | Urgent reports land in its chat at once. |
| Another project's owner | Turn the reporter on for a bucket with a script tag and a settings page. |

## 4. Goals and non-goals

Goals: one script tag, no change to the app code; report in under a minute on a phone; every ticket traced to a site, repo, environment and build; deployment state always shown, never guessed; the host page never sees a portal token.

Non-goals (this build): anonymous reporters (everyone signs in to the portal); a second UI in the SDK repo; session replay, verify loop, device matrix, source maps, AI triage, live CSS tweaks (Phase 2, §13).

## 5. Architecture

| Part | Where | Holds |
| --- | --- | --- |
| SDK: the tool and the widget | new private repo `alfianisnan26/pilot-reporter` | One script, no runtime framework. Widget, recorders, capture, callouts, hotkeys, the bridge. No token, no portal API call. |
| Panel | the portal, `apps/web` (separate Vite entry, `embed.html`), served at `/reporter/v1/embed` in an iframe | All UI and data access. The token, in the iframe's own storage. |
| Server | `apps/server/src/reporter` | Routes, tokens, tickets, evidence, deployments, repro, checks. |
| Owner UI | `apps/web`: bucket "Reporter" settings; Evidence viewer on the ticket page next to Attachments | Config and review. |

The portal serves the SDK build it pins at `/reporter/v1/reporter.js` (from `apps/server/src/reporter/vendor/`, with `VERSION`). The SDK repo builds it; `scripts/vendor-reporter.sh <sdk commit>` vendors it (and a pinned axe-core for `/reporter/v1/axe.js`), with `VERSION` = `<package version>+<short commit>` (first vendored: `0.1.0+05cdcb2`; now `0.1.0+1a3631b`, with the capture toolbar Ticket | Session switch). The panel is the web app's second Vite entry: `apps/web/embed.html` builds to `apps/web/dist/embed.html` (assets under `dist/assets`), which the server reads for `/reporter/v1/embed`. Additive contract types from the build: `ReporterCreateTicketResponse`, `ReporterSessionDelivery`, `ReporterMe`, `ReporterObservedBuildRequest`, `ReporterSessionTargetStatus`, `ReporterNote`, and an optional `sessionDelivery` on `ReporterSubmitReviewResponse`. Product changes land in pilot; the SDK stays small.

**The bridge.** Host page and panel talk only by `postMessage` (`ReporterHostMessage`, `ReporterPanelMessage`, `REPORTER_BRIDGE_VERSION` 1). Host to panel: hello, navigated, capture-result (screenshot as a transferred `ArrayBuffer`), capture-cancelled, capture-started, panel-opened, callout-clicked, focus-changed, focus-ended, focus-missing. Panel to host: ready, capture-request, callouts, settings, highlight, focus, focus-clear, tray, close.

**Startup.** The SDK creates the iframe hidden. If no valid `ready` arrives in about 8 s, or `ready.status.enabled` is false, the SDK removes everything and renders nothing: no console noise, no layout change. `data-enabled="false"` patches and renders nothing at all.

## 6. Sites, buckets, environments

A bucket (for example `KONF`) has **sites**: `{ origin, environment, repo, label, branch }`. They replace "allowed origins" and "repos".

- An origin is unique across the whole portal. `PUT /api/reporter/buckets/:key/config` refuses an origin used by another bucket (409).
- A page resolves to one bucket, one repo and one environment through its site. Embed `frame-ancestors`, token scope and status all resolve through the site.
- A ticket's repo and environment come from the SITE record, frozen on the ticket (`ReporterTicketSite`). What the page declares (`build.repo`, `build.environment`) is untrusted: compared only, a mismatch is stored and shown as a warning.
- Callouts and the "This page" list show tickets of the SAME REPO from any of its environments (path match), each marked "reported on <env>" with THIS environment's deployment state. Never tickets of another repo or bucket.
- First site: `https://stg.konfersi.com`, `stg`, `platform/konfersi-landing-page`, branch `stg`.
- Limits: 20 sites per bucket.

## 7. Flows

**Connect.** The panel has no token at first. It opens `/reporter/v1/connect?bucket=&origin=&nonce=` as a popup. The popup needs the portal cookie; signed out, its "Sign in" goes to `/login?next=<this connect URL>` and comes back to it after sign-in (the login page follows `next` only for a `/reporter/v1/connect` path). Approve is a same-origin POST with the usual CSRF. The server mints a `cprt_` token for (bucket, origin) and the popup posts `ReporterConnectMessage` to `window.opener` with `targetOrigin` = the portal origin. The panel keeps the token in its own storage. Lifetime 12 hours.

**Browse.** One header row: the environment chip and Context (the bucket name only for screen readers). The SDK draws its one Close over the panel's top-right corner on phones and desktop, so no view puts a control in the top-right 48 px. The widget button's badges come from the panel's `pilot-reporter:tray`: draft comments (`count`) and the person's open tickets waiting for their reply (`replies`). Tabs: Tickets, Report, Sessions, Knowledge, Settings; the active tab shows its word (every word from 768 px). A ticket card or a chat hides the header and the tabs: its own back · title · open row is the only header. Tickets opens on "This page" with open tickets, sorted by position; an empty page says "No open tickets here" with "Show N closed" when closed ones exist. Scope This page / All; Sort is a small popover (updated, created, priority, position on This page, most captures; order; Group by page); Filter is a bottom sheet (status, priority, type; tags and Mine when there is data) with Apply; active filters are one row of removable chips; the last choice is remembered per viewer. Counts come with the list. A row is a meta line (key, priority only for Urgent and High, the status chip, a "Reply" badge or an unread dot) and the title on two lines (a bracketed prefix as a small tag); a thumbnail on the left only when the ticket has a screenshot. The list pages by cursor as it scrolls, renders only the rows near the screen for long lists, keeps unchanged rows from re-rendering on a change event, and is where it was when coming back from a ticket. Sessions: the bucket's sessions ("Lead" first), each opening the chat in the panel. Knowledge: search and read a note in the bucket's vault.

**Report, two paths.**

- Quick path: capture, Report form, submit: a ticket with its shots. The form is one screen: a strip of shots (tap opens the viewer, × removes one, + adds another as Screen or Crop), a title suggested from the anchored element's text or id and the page title, Details collapsed to one line until tapped, type as chips and priority as one control (Bug, Normal), a slim "Looks like KONF-12 · Add to it" line above the send area (never a blocker), then the destination switch and the button. Filing to the queue shows a compact "Filed KONF-n" row (copy, View, Report another); the callout is on the page at once.
- Review path (the default once started): "Start review" creates a server-side DRAFT. It is visible only to its author in this bucket, from any device. It is not a ticket: no queue, agent or notification sees it. Each comment is a capture plus a Markdown body, written right after the crop. The reviewer keeps browsing and adding comments; comments can be edited, reordered, deleted. Draft comments show on the page as PENDING callouts (dashed, muted). The widget badge shows the comment count. "Finish review": summary, overall comment, type, priority, tags, and a mode: one ticket, one ticket per page, one per comment, or add to an existing open ticket. Submit is one transaction; on failure nothing is created. Discard asks for confirmation inside the panel. A draft untouched for 30 days is discarded with its files.

**Direct to session.** A Queue | Ask lead now switch right above the button on the report form and the review submit form (the capture toolbar's Ticket | Session switch follows it through `pilot-reporter:target`, and the last choice is remembered per bucket). Queue = a ticket ("File ticket"). Ask lead now = urgent, straight to one of the bucket's session targets ("Send to <lead>" in the urgent colour; the target with its live state, a picker when there are several, and "A ticket is created for tracking"; disabled with a reason when none). In this mode Details becomes "Your question", focused and required. After sending, the panel opens the chat with that session: the delivered message with its screenshots, the reply streaming in, the ticket key as a chip; a failed delivery stays visible there with Retry (it sends the question and the first shot as a chat message).

- A session report is a ticket anyway: priority urgent, tag `ui-urgent`, assigned to that session, target stored. It is traced and deployment-tracked.
- Plus an immediate message into that session's chat through the chat controller, as the owner's delegate: summary, a section per capture (page, environment, commit, device), the screenshots as chat images within the chat image limits, the ticket key, "reply on the ticket".
- The panel then shows the session's live status (working or idle) and the ticket thread.
- If delivery to the session fails, the ticket stays and the panel says so plainly.
- Session reports are rate limited tighter than tickets.

**Duplicates.** Before filing (quick path) and on each review comment the panel calls `POST /reporter/v1/duplicates`. The server scores open tickets of the bucket: same path plus rectangle overlap (IoU), same selector, or same error signature. Up to 5 candidates come back as "Looks like KONF-12" cards with thumbnail and reasons. Actions: "Add to it" (adds the capture to that ticket) or "Still new".

**Callouts and showcase.** The panel sends the callouts for the current path; the SDK draws a marker and an outlined box (selector plus relative position, else the stored rectangle). Hover or tap shows a card: key, summary, phase, "reported on <env>", deployment state, "open in pilot". Callouts are per capture and show "2 of 5". They re-place on resize, scroll, SPA navigation (`pushState`, `replaceState`, `popstate`; the SDK sends `navigated`), orientation change and visual viewport zoom. Tapping a ticket or a callout starts the showcase: the area scrolls into view, the rest of the page dims (spotlight, no layout change), the box pulses, a caption card shows key, summary, phase, "2 of 5", comment excerpt, with Prev / Next, Close, swipe on phones, arrow keys and Esc on desktop. A capture on another page gives `focus-missing` and the panel offers "Open that page" (same-tab, stored path, this origin only). "Play all" steps through every open ticket's captures in position order. Reduced motion is respected.

**Live status.** Phases: open, working (an assigned session is active, or status in progress), review (in review), fixed (done with a fix commit), deployed, wont-do. Updates arrive through a streamed response (`GET /reporter/v1/events`, fetch with the bearer token) within seconds; polling every 30 s is the fallback; the panel re-sends callouts. A phase change to deployed also goes out on the events stream.

**Replies.** The ticket card is one meta line (key · priority · status), the deployments (one grey line when none is known), shots, steps, then the thread, with the composer pinned to the bottom. The thread is compact: author and relative time on one line, consecutive comments by one author grouped, a body clamped to about four lines with More, an agent marked by a small icon and tint, long code or log blocks collapsed, newest at the bottom with "Latest". A reply is a ticket comment labelled with the reporter's person and origin. A callout whose ticket has a comment by an agent or a person after the reporter's last reply gets a badge; opening the thread marks it read. The composer (shared with the chat) is one line growing to five, the send button inside it, Enter sends and Shift+Enter breaks the line on desktop (the button sends on touch), lifted over the phone keyboard (visual viewport).

**Chat in the widget.** A session of the bucket opens as a chat in the panel (Sessions tab, a ticket's "Chat", or after a direct ask): the newest messages first, older ones on scroll up, the person's and the assistant's text as bubbles, a tool call as one line, images small and tappable, live while open (the session's stream, a poll while it is down). The header shows its state (Working, Needs approval, Idle, Ended) and a link to pilot; an approval is a banner with "Answer in pilot", never answered here. The composer sends as the person through the reporter and can attach the current shot. Details: ui-reporter-server.md, "Chat in the widget".

**Screenshot viewer.** Tapping a shot (report form, review comment, ticket card, chat image) opens it full screen over the panel (the SDK raises its phone sheet to full height: `pilot-reporter:expand`): fit to screen, pinch and wheel zoom, drag to pan, double-tap or double-click for 100%, the crop drawn, Esc, X or a swipe down closes it, "Open in a new tab" as the secondary action. Opening a ticket from the list highlights only its pin on the page (no spotlight); Play all still dims the page.

**Annotate.** A shot of the report being written (the pencil on its thumbnail in the report form or the comment form, or Annotate in the viewer) opens the annotation editor full screen: pen, line, arrow, rectangle, ellipse, text (tap to place, edit inline, Enter or a tap elsewhere ends it), highlighter (translucent), blur (pixelates a rectangle: for secrets and personal data), numbered steps (1, 2, 3...), and select to move, resize (44 px handles) or delete a mark. Five fixed colours (red first) and S / M / L; a colour or size picked with a mark selected restyles it. Undo and redo (buttons, Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z), Clear all with an inline confirm, Cancel and Done. One finger draws with the tool; two fingers pinch and pan and drop a mark in progress (a pinch never draws). Phone: Cancel, Undo, Redo, Clear and Done on top, the tools and the style pinned at the bottom in the safe area, scrolling sideways; desktop: one top bar and the keys P pen, L line, A arrow, R rectangle, O ellipse, T text, H highlight, B blur, N number, V select, Delete removes the selection, Esc drops the mark in progress (it never closes the panel). Marks are vector data in the screenshot's pixels. Done flattens them into a PNG of the screenshot's size (a blur changes the real pixels). Without a blur the original is uploaded as the screenshot and the flattened image beside it (kind `annotated`); with a blur the flattened image IS the screenshot and the original never leaves the panel (the editor says "Blurred areas are removed from the uploaded image"; it stays in the panel only to annotate again). Filed shots show the marked image, with Original / Marked to switch (panel ticket card, the owner's evidence card). A shot over 16.7 megapixels (browsers' canvas cap) cannot be annotated. Already filed shots and posted review comments are not edited.

**Context.** The header's info button opens a Context sheet with copyable rows and Copy all: Site (domain, origin, environment, repo, branch from the site record, a warning when the page declared something else), Page, Build (commit copied whole), Client (browser, OS, device, touch, screen, viewport, orientation, locale, timezone, connection, CPU, memory), Network (the address the portal sees and its family), Session (who, token expiry, SDK versions; the portal release shows "unknown" until the panel can read it). "What a ticket carries" lists what the next report from this page includes: the context above plus live counts from the SDK (`pilot-reporter:context`: console entries and errors, network requests and failures, interactions), UI checks and vitals at capture, and the redaction rules in one line each. "What's sent" on the report form opens it there. Every value has a source; "unknown" when there is none.

**Capture modes.** Screen (only what is on screen, the default), Whole page (desktop only) and Crop, as one compact group.

**Hotkeys (desktop).** Defaults, changeable in Settings: Alt+Shift+R report, Alt+Shift+C crop and report, Alt+Shift+H callouts, Alt+Shift+P panel. None on touch.

## 8. Deployment state

Fundamental: for every ticket, know whether its fix is live in each environment of its repo.

- **Fix commit.** The newest commit carrying `Ticket: <KEY>` in a trailer, found by the server in a checkout of the repo (the repos module or a workspace that has it; read-only git, no credential printed); or the commit an agent sets when closing (optional `fixCommit` on the ticket close and the Portal MCP tool); or a commit the ticket's closing summary names.
- **Current build per (bucket, repo, environment): two sources of different trust** (PILOT-1111). Deployments are kept per bucket, so a token of one bucket never writes what another bucket reads.
  - (a) **Pipeline, authoritative.** `POST /api/reporter/deployments` with a portal token that may operate on the bucket (optional `bucket`; else every bucket the token may operate on whose site serves that repo and environment), and the Portal MCP tool `reporter_record_deployment`, after a deploy. The Konfersi stg workflow gets a one-line `curl` (documented in the integration step, not in this PRD).
  - (b) **Observed, lower confidence.** A signed-in panel posts the page's build once per page load (`POST /reporter/v1/observed-build`); the server records it for the SITE's repo and environment (never the page's claim), source `widget`. The page declares that commit about itself (a stale tab, a wrong meta tag, a rollback), so it is `verified` only when the commit exists in a checkout of the repo the server can read (`git rev-parse --verify`); an unverified one is kept as history and never decides anything.
  - **The live commit** of an environment is the bucket's newest pipeline deployment there. Only while the bucket has no pipeline deployment for that environment yet, it is the newest verified observed build, and every state built on it carries `confidence: 'observed'`, shown with a lower-confidence marker (`✓*`, "seen by the widget, no pipeline yet") in the panel, the callout card data, the ticket page and the description footer. Once a pipeline reports, observed builds are history only.
- **State per environment** (`ReporterDeploymentState`): `deployed` (the live commit is the fix commit or contains it), `not-deployed` (proven absent), `unknown` with a reason (`no-fix-commit`, `no-build-seen`, `ancestry-unchecked`); `confidence` says whether the live commit is a pipeline's or an observed one. Ancestry is proven with `git merge-base --is-ancestor` in the checkout. Otherwise unknown. Never guessed.
- **Phase `deployed`** only when the state for THIS site's environment is deployed. A ticket reported on stg and viewed on uat shows uat's state.
- **Where shown.** Panel list rows (an environment strip such as "stg ✓ · uat – · prod –"), the callout card, the showcase caption, the ticket page header, the Evidence viewer, the ticket description footer (updated on change), the Portal MCP ticket detail.

## 9. Data captured and redaction

| Data | Content | Caps and masking |
| --- | --- | --- |
| Screenshot | Full page or crop, DOM rasterization; precise mode with `getDisplayMedia` on desktop only. Widget and callouts hidden from the shot. | png, jpeg or webp, magic bytes checked, 8 MiB. |
| Anchor | Selector, relative position, rectangle, path. | |
| Console | `console.*`, window error, unhandled rejection. | 200 entries, 2000 characters each; JWTs, bearer tokens and `prefix_<long>` keys masked. |
| Network | Method, URL, status, duration, size, error. | 200 entries; query VALUES redacted; never bodies or headers. |
| Components | React fiber tree around the point (minified names noted; framework null without React). | 400 nodes. |
| Performance | Navigation timing, LCP, CLS, INP, FCP, long tasks, memory. | |
| Page | URL (query values redacted), origin, host, path, route, title. | Hash kept, capped. |
| Device | UA Client Hints, else UA parsing; viewport, pixel ratio, connection, memory, cores, timezone, locale. | |
| State | Scroll, visibility, online, color scheme, reduced motion, focused selector, storage KEY NAMES only (local, session, cookies readable by script). App state only through `init({ getState })`. | Capped and redacted; null when the app gives none. |
| Build | Config, else meta tags, else null. | Never guessed. |
| Repro trail | Last 50 interactions: click, input, change, submit, navigate, a few keys (Enter, Escape, Tab, arrows), scroll; selectors and accessible labels. | Input values never recorded (`[masked]`; option label for a select; checked or unchecked); key characters never recorded. |
| UI checks | axe-core (loaded from `/reporter/v1/axe.js` only at capture time) on the elements in the crop, plus targets under 44x44 px, contrast (WCAG AA), horizontal overflow, text cut off. | 100 findings. If the checks cannot run: `ran=false` with an error, never an empty list. |

The server builds the repro steps and a Playwright test (`repro.spec.ts`: the capture's viewport and user agent, starting at the first page of the trail, ending with an expect on the anchored element) from the trail, so it can improve without an SDK release.

**Server re-validation.** The page is untrusted. The server parses evidence against `ReporterEvidence` (schema version 1 only, 2 MiB, caps, truncation), checks screenshot type and magic bytes, and re-redacts with `chat/redact.ts`.

**Ticket text.** Tag `ui-report`, reporter kind `token` labelled "Reporter: <origin>", default type bug. The Markdown description opens with the overall comment, then per capture: domain, path, route; device and browser; build version, commit, branch, environment; repo; console error count; failed requests; LCP; repro steps; UI check findings; links to the attachments. An agent can tell the commit and the page from the description alone. The Portal MCP ticket tools say the evidence exists and how to read the attachments.

## 10. Security model

- **Token only in the iframe.** The `cprt_` token is hashed at rest, bound to one bucket and one origin, expires in 12 hours, can be revoked. It lives in the panel's own storage. The SDK holds no token and calls no portal API.
- **Framing.** `/reporter/v1/embed` sends `Content-Security-Policy: frame-ancestors <the requested origin>` only when that origin is a site of an enabled bucket; otherwise a page that cannot be framed and shows nothing useful. No `X-Frame-Options: DENY` on it.
- **Capture toolbar target.** `capture-result` and `capture-started` may carry `target` (`ReporterReportTarget`; `sessionId: ''` = the default session), validated like every other field; the panel preselects Ticket or Session on the report form, or on the review's submit form, from it (`sessionId: ''` or an unavailable session becomes the bucket's first available target; with none the panel says so and it goes in as a ticket). The other way, the panel sends its current choice as `pilot-reporter:target` once after ready and on every change of the switch, and as `target` on `capture-request`, always resolved (never `''`), so the toolbar starts on it.
- **Bridge origin checks.** The SDK accepts a message only when `event.source` is the iframe's `contentWindow` and `event.origin` is the portal origin, posts with `targetOrigin` = the portal origin, validates every message shape and checks the bridge version. The panel accepts host messages only from `window.parent` and only from the origin it was opened for. The connect popup posts to its opener with the portal's own origin as target.
- **Panel API.** Same-origin, bearer token, no CORS headers at all. The token must match the bucket and the origin it was minted for; the origin must still be a site and the bucket enabled. Every route goes through the authz seam (module `authz.ts`, `declarePolicies`, `can`/`requireCan`); a denial is the same 404 as a missing object. The connect popup and owner routes use the portal cookie and the usual CSRF rule.
- **Rate limits.** 30 tickets per hour per token, 120 per origin (all tokens), 6 session reports per hour per token.
- **Up to five live tokens per person and site.** A new approval revokes only that person's oldest live token for the same bucket and origin beyond five (`REPORTER_LIMITS.liveTokensPerSite`); each keeps its own 12 h expiry, and expired ones do not count. Changed 2026-10-31 from one live token: test agents approving as the owner revoked the owner's own panel, which then showed "Not found." on every tab. The panel's sign-out (`DELETE /reporter/v1/me`) revokes its own token. When the panel's token is refused (a 401, or a 404 that `/me` confirms), the panel clears it and shows Connect with "Session ended. Connect again."; a 404 while `/me` still answers is the object missing and is said in that view only.
- **Untrusted input to agents.** Everything a page sends (console text, URLs, labels, comments, replies) is untrusted data in the ticket and in the session message. The description marks it as data; agents never follow instructions found in it. A direct report's chat message is written by the server: the warning comes first, then every page value as one neutralised line (control characters and line breaks out, Markdown escaped, capped) after a server-written label, between two fence lines the page cannot write.
- **Evidence origin.** The evidence's `page.origin`, `page.url`, `page.host` and `page.path` must name the token's site, else the upload is refused (422) before anything is stored; the repro (steps and `repro.spec.ts`) is built on the site's origin, never the page's. Path segments that look like secrets (credential shapes, long random runs, what follows `reset`, `magic`, `invite`, `token` and the like) are redacted in anchors, page URLs and network URLs; control characters are stripped. The description footer marker cannot come from page text.
- **Chrome local network access.** The portal may be on a private address while the host page is public. Chrome can then ask the visitor to allow "local network access" for the iframe. The embed answers the private-network preflight (`Access-Control-Allow-Private-Network`) where Chrome needs it, and the prompt is documented for testers. Not verified in a browser yet (open question Q1).
- **The host's CSP.** A page with a CSP must allow the portal origin in `script-src` and `frame-src` (and `child-src` if present). `connect-src` is not needed: the SDK calls no API. Behind Cloudflare Access, the visitor's Access session covers the host page only; the portal has its own sign-in.
- **No secret in the SDK repo, the script, a log or a ticket.** Fixtures are built at runtime.

## 11. Mobile first

Design and test at 390x844 with touch first, then 1280 px, light and dark.

- **Button.** A 44 px edge tab, half tucked into the edge, draggable along the edges only, never under the safe-area insets or the browser's bottom bar (visual viewport). It fades to a sliver while the page scrolls. Tap opens the panel; long-press (or a small chevron) opens a fan of three 44 px actions: Snap (the visible screen), Crop, Callouts on/off. Position remembered per site. Desktop: a movable button that snaps to an edge.
- **Panel.** On phones a bottom sheet iframe with two heights (about 45% and 92% of the visual viewport), a grab handle as the only drag target, backdrop tap or swipe down closes, follows the on-screen keyboard, locks the host scroll while open and restores it exactly. Desktop: a docked card (about 400x640) near the button, resizable and movable.
- **Snap and crop.** Starting a capture collapses the sheet and hides the button and callouts, takes the shot, shows the FROZEN image full screen. One-finger drag draws the crop; the box has four 44 px corner handles and can be moved; pinch-zoom and two-finger pan; "Tap an element" crops to the element's box and picks the anchor selector; bottom toolbar inside the safe area: Cancel, Retake, Full screen, Use. After "Use" the sheet reopens on the Report form at 92%, the crop as a thumbnail, summary focused, type and priority as chips, submit sticky above the keyboard. Full page is desktop only; on phones Snap captures the viewport. Marking up a shot is the panel's annotation editor (section 7, Annotate).
- **Callouts.** No hover. Markers at least 28 px with a 44 px hit area; a tap opens a compact card; overlapping markers cluster with a count.
- **Host safety.** No horizontal scroll on the host; the button can be moved off the host's fixed bottom navigation; works in installed PWAs and Safari iOS (no API Safari lacks without a fallback).

## 12. Limits

From `REPORTER_LIMITS`: 20 sites per bucket; 10 session targets; screenshot 8 MiB; evidence 2 MiB; 200 console and 200 network entries; 50 interactions; 100 check findings; 5 duplicate candidates; 400 component nodes; 2000 characters per console line; token 12 h; 30 tickets per hour per token; 20 captures per ticket; 50 comments per review; 4000 characters per comment; 10 draft reviews per person per bucket; drafts expire after 30 days; 6 shots on one quick report; 20 chat messages per token per 10 minutes, 8000 characters each; 40 chat lines a page; 200 marks per capture, 2,000 points per mark, 20,000 per capture, 300 characters per text mark.

## 13. Rollout

**Konfersi stg first.** The SDK is injected at the edge with no app code change, by the landing repo's Pages middleware (`functions/_middleware.js`), only when `PILOT_REPORTER` is `on` (stg only). Environment: `PILOT_REPORTER_PORTAL` (default `https://pilot.ai.isnan.me`), `PILOT_REPORTER_BUCKET` (default `KONF`), `PILOT_REPORTER_ENV` (`stg`). The script tag carries repo `platform/konfersi-landing-page`, commit from `CF_PAGES_COMMIT_SHA`, branch from `CF_PAGES_BRANCH`, version only when the build has one. The middleware extends the HTML response CSP for the portal origin (`script-src`, `frame-src`, and `child-src` if present). The bucket needs the site above, the reporter enabled, and a session target for direct reports.

**Another project.** (1) Make a bucket or use an existing one. (2) Bucket settings, Reporter: enable, add sites (origin, environment, repo, branch, label), pick session targets, set callouts default, copy the script tag. (3) Add the tag to the app, or inject it at the edge; pass the build (commit, branch, environment, version) by `data-*` or `window.PilotReporter.init({ ..., getState, route })`. (4) Allow the portal origin in the app's CSP. (5) After each deploy, post the build (`POST /api/reporter/deployments`) so deployment state is known even when nobody has the page open. An origin that belongs to another bucket is refused (409).

**Phase 2 (planned, NOT built in this run).** Verify loop with the pilot browser (re-capture the same area at the same device after a fix, before/after view, Accept or Reopen on the page); device matrix capture; source maps to file and line at the commit; AI triage in the panel; short session replay (rrweb, inputs masked); live CSS tweaks attached as suggested changes.

## 14. Open questions

- Q1. Does Chrome's local network access prompt appear for the embed iframe from a public page, and does the preflight answer clear it? Test with the real portal address.
- Q2. Cloudflare Access on stg: does the iframe, loaded from the portal, work in a third-party-storage-partitioned browser (Safari)? The token's storage in a partitioned iframe is untested.
- Q3. Where does the server find a checkout of `platform/konfersi-landing-page` for ancestry (the repos module or a workspace)? If none, the state stays `unknown` with `ancestry-unchecked`.
- Q4. Pipeline recording for Konfersi stg: who adds the `curl` step to the stg workflow?
- Q5. The review of this PRD is still owed (D-105).

## 15. Done criteria (QA)

All open until QA checks them. Mark each with the evidence (command, screenshot, ticket key).

Sites and buckets
- [ ] A site origin used by another bucket is refused with 409 (test).
- [ ] Embed `frame-ancestors` equals exactly the requested origin when it is a site of an enabled bucket; otherwise the page cannot be framed.
- [ ] A token minted for one origin or bucket is refused on another (404).
- [ ] A ticket from stg shows repo and environment from the site record; a page that declares another repo or environment stores a mismatch warning.
- [ ] Two environments of one repo: a ticket reported on stg shows on uat's page "reported on stg" with uat's deployment state; a ticket of another repo or bucket never shows.

Widget and panel
- [ ] Off-network, or `enabled=false`, or `data-enabled="false"`: nothing rendered, no console output, no layout change.
- [ ] Bridge: a message from another window or origin is ignored on both sides (test).
- [ ] The host page cannot read the token (no token in the host's DOM, storage or messages).
- [ ] 390x844 touch: the button, the fan, the sheet at both heights, the keyboard behaviour, host scroll lock and exact restore; snap, crop with handles, tap an element, pinch; no horizontal scroll; 44 px targets. Light and dark.
- [ ] 1280 px: docked card, hotkeys, full page capture.

Reporting
- [ ] Quick path: one ticket with one capture; tag `ui-report`; description names domain, path, commit, branch, environment, repo, device.
- [ ] Review path: draft visible only to its author, from two devices; not in the queue; pending callouts; one ticket, one per page, one per comment, add to existing; a failed submit creates nothing; discard confirms; an expired draft is swept with its files.
- [ ] Direct to session: the switch works before sending, on the form, the submit form and the capture toolbar; the ticket is urgent, tagged `ui-urgent`, assigned; the message reaches the session's chat with screenshots; a failed delivery keeps the ticket and says so; with no targets the option is disabled with a reason; the rate limit holds.
- [ ] Duplicates: a same-page, same-area report offers the existing ticket; "Add to it" and "Still new" work.
- [ ] Repro: steps and `repro.spec.ts` attached; no input value or typed character appears anywhere.
- [ ] UI checks: findings listed; when they cannot run the evidence says so.
- [ ] Redaction: JWT, bearer and key-shaped text in console, query values in URLs and a secret-looking app state value are masked in the stored evidence (fixtures built at runtime).
- [ ] Server rejects: a wrong magic byte, an oversize screenshot, an evidence file of another schema version.

Showcase and status
- [ ] This page opens by default; filters, counts, sort and the remembered choice work; the phone Filter and Sort sheets.
- [ ] Showcase: scroll, spotlight, pulse, caption, Prev/Next, swipe, keys, Esc, focus-missing with "Open that page", Play all; reduced motion.
- [ ] Deployment state: deployed, not-deployed and unknown (each reason) in tests; ancestry by `git merge-base --is-ancestor`; observed build recorded for the site's repo and environment, not the page's claim, and live only when its commit is verified in a checkout and the bucket has no pipeline deployment for that environment (`confidence: 'observed'`, marked); a pipeline deployment wins; deployments are per bucket; the pipeline route and the MCP tool record a build; shown in every place listed in §8.
- [ ] Phase colours open, working, review, fixed, deployed, wont-do; `deployed` only with proof; an update reaches the panel within seconds, and by polling within 30 s when the stream is down.
- [ ] Replies: thread shown, reply posted with person and origin, badge on a new question, cleared on open.

Security and rollout
- [ ] Every `/reporter/v1` and `/api/reporter` route is declared in the authz seam; a denial is the same 404.
- [ ] No CORS headers on the panel API.
- [ ] Konfersi stg: the middleware injects the tag only when `PILOT_REPORTER=on`; the CSP allows the portal; no app code changed; prod and uat unaffected.
- [ ] No token-shaped literal in any file of either repo.
