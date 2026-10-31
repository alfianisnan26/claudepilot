# UI reporter: the portal server

Owner request 2026-10-31. The product document for the whole feature is `docs/prd/ui-reporter.md`; the wire contract is
`packages/contracts/src/reporter.ts`. This page says what the server does, so agents and the web slice can rely on it.

Code: `apps/server/src/reporter/` (`service.ts`, `routes.ts`, `validate.ts`, `describe.ts`, `pages.ts`, `git.ts`, `portalTools.ts`,
`authz.ts`, `vendor/`). Migration 900 (block 900-909).

## Sites, config and tokens

- A bucket's reporter config: `enabled` (off until turned on), `sites` (origin, environment, repo, label, branch), `sessionTargets`,
  `calloutsDefault`. `GET/PUT /api/reporter/buckets/:key/config` (view / manage on the bucket).
- An origin is unique across the portal (table `reporter_sites`, primary key `origin`). A PUT that lists an origin another bucket has is
  refused with 409. Origins are exact (scheme, host, optional port), no wildcard, no path.
- The site record decides a report's repo and environment. What the page declares (`ReporterBuildInfo.repo`/`environment`) is stored next to
  it and shown as a warning when it differs (`ReporterTicketSite.declaredMismatch`), never used.
- `cprt_` tokens: minted by `POST /reporter/v1/connect` for (bucket, origin, person), 12 hours, only the SHA-256 is stored. Every panel call
  re-checks: not revoked, not expired, the origin still a site of that bucket, the bucket still enabled, the person still allowed on the
  bucket. The panel may also send `x-reporter-bucket` and `x-reporter-origin`; when present they must match the token. Any failure answers
  the same 404 as a missing object; a call without a token answers 401. `DELETE /reporter/v1/me` revokes the panel's own token (sign out;
  not in the contract's route table).
- Up to `REPORTER_LIMITS.liveTokensPerSite` (5) live tokens per person, bucket and origin: minting a sixth revokes the oldest live one
  (`revoked_reason` "replaced by a newer connect"); each keeps its own 12 h expiry and expired ones do not count. Until 2026-10-31 a new
  approval revoked all the person's older tokens there, and test agents approving as the owner signed the owner's panel out. The panel
  treats a 401, or a 404 that `GET /me` confirms, as "session ended" (clears the token, shows Connect); a 404 while `/me` answers is a
  missing object, shown in that view only.

## Pages and files under /reporter/v1

| Route | What |
| --- | --- |
| `GET /reporter.js` | `vendor/reporter.js`, the SDK build vendored by `scripts/vendor-reporter.sh <sdk commit>` (clones alfianisnan26/pilot-reporter at that commit, `npm ci`, builds, checks the build equals the committed `dist/reporter.js`; `vendor/VERSION` = `<package version>+<short commit>`), `text/javascript`, 5 minutes cache, ETag, `Cross-Origin-Resource-Policy: cross-origin`. |
| `GET /axe.js` | `vendor/axe.min.js`, axe-core pinned by the same script (`vendor/AXE_VERSION`, licence in `vendor/axe-core.LICENSE`); 404 if it is missing: the SDK then records `checks.ran = false` with the reason. |
| `GET /embed?bucket=&origin=` | The panel: `apps/web/dist/embed.html` (a placeholder when the web app was built without it). CSP `frame-ancestors <origin>` exactly, when the origin is a site of that enabled bucket, with `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: cross-origin` so a site that isolates itself (COEP require-corp, the Konfersi Lab) can frame it (the panel loads only its own origin; `/assets/*` also answer `Cross-Origin-Resource-Policy: cross-origin`). Otherwise an empty page with `frame-ancestors 'none'` and `X-Frame-Options: DENY`. |
| `GET /status?bucket=&origin=` | `ReporterStatus` for the panel's `ready`; every refusal reads the same (disabled, no site, no name). |
| `GET /connect?bucket=&origin=&nonce=` | The popup. Not signed in: a sign-in link. Signed in and allowed: what is approved (bucket, site, environment, repo, person) and Connect. Its script POSTs same-origin and posts `ReporterConnectMessage` to `window.opener` with targetOrigin = the portal's own origin. |
| `POST /connect` | Needs the portal cookie, `Origin` of the portal, JSON; refuses an origin not on the list (404). Rate limited per person. |

The portal's usual secure headers stay on every other path; `/reporter/v1/*` sets its own CSP, framing and resource policy (app.ts).

Chrome's Private Network Access (and the newer "local network access" permission prompt): when the portal is on a private address and the
host page is public, Chrome may ask the person to allow the site to reach the local network, and sends a preflight with
`Access-Control-Request-Private-Network: true`. Only `reporter.js`, `axe.js` and `embed` answer it (`Access-Control-Allow-Private-Network:
true`, the asking origin); the panel API never does. The owner's portal (`pilot.ai.isnan.me`) is public, so this applies only to a portal on
a LAN address.

## Panel API (bearer `cprt_`, same-origin, no CORS)

Every route of `REPORTER_ROUTES` under `/reporter/v1` from `me` down. No `Access-Control-*` header is ever set; a request with a foreign
`Origin` or `Sec-Fetch-Site: cross-site` is refused (404). Per token: 900 requests per 10 minutes, 3 open event streams.

- `GET /tickets`: `ReporterTicketQuery` (status open/closed/all/one, type, priority, tags, q, path, mine, sort updated/created/priority/
  position/captures, order, cursor, limit). With `path`: tickets of the SAME REPO as the token's site, from any of its environments, with a
  capture on that path; never another repo's or bucket's. Counts are over the scope before the status, type, priority and tag filters.
  `?as=callouts&path=` returns `{ path, callouts }`: one `ReporterCallout` per capture on that path, plus the viewer's own draft comments as
  `pending` callouts.
- `POST /tickets` (quick path), `POST /tickets/:key/captures`, `POST /tickets/:key/attachments` (raw body, `x-reporter-capture`,
  `x-reporter-kind: screenshot | evidence`), `GET /tickets/:key/captures/:captureId/screenshot`.
- Reviews: `GET/POST /reviews`, `GET/PATCH/DELETE /reviews/:id`, comments, attachments, `POST /reviews/:id/submit` (single, per-page,
  per-capture, or `targetTicketKey`). A draft is visible only to its author in that bucket. Submit creates every ticket in one transaction;
  a failure creates nothing and leaves the draft as it was. Drafts untouched for 30 days are discarded with their files (sweep every 6 hours).
- `GET/POST /tickets/:key/comments` (reading marks the thread read; a reply is labelled `<person> (reporter, <origin>)`), `POST /duplicates`,
  `GET /session-targets`, `POST /observed-build`, `GET /sessions`, `GET /knowledge`, `GET /knowledge/note`.
- `GET /events`: NDJSON lines `{"type":"hello"|"changed"|"ping"}`; checked every 2 s, closed after 10 minutes or when the token stops being
  valid. The panel re-reads on `changed` and polls every 30 s when the stream fails.
- `GET /me` also returns `clientIp` and `clientIpFamily` (4 or 6): the request's address as the portal sees it, by the app's one rule
  (`clientAddress.ts`): the trusted proxy's LAST `X-Forwarded-For` entry when `PORTAL_TRUST_PROXY=true`, else the socket; a header a client
  sets is never believed. The same address is stored as `reporter_ip` on each widget ticket's evidence record (migration 902), named in the
  description's "Where" section ("Reporter IP") and in the owner's Evidence viewer. The page never sends it. A private, loopback or cluster
  address (10/8, 172.16/12, 192.168/16, 127/8, fc00::/7, ::1; `isInternalIp` in contracts) is labelled "<ip> (internal: behind the cluster
  proxy)" in the Context view, the description and the Evidence viewer: in k3s the service load balancer rewrites the source before
  Traefik, so the portal sees a pod address, never presented as the reporter's public IP.
- `GET /me` also returns `portalRelease`: the image's release tag (`PORTAL_RELEASE`, baked in by `deploy/k3s-build` from the build's
  tag; only a plain tag is believed), null when the server does not know it (the panel then says "unknown").

### Chat in the widget (PILOT-1111)

`GET /sessions/:id/messages` (`?before=&limit=` a page counted back from the newest, or `?after=`), `POST /sessions/:id/messages`
(`ReporterChatSendRequest`), `GET /sessions/:id/stream?after=` (NDJSON `ReporterChatStreamLine`: hello, update with new lines and the state,
ping, gone; checked every second, closed after 5 minutes, at most 2 per token), `GET /sessions/:id/blobs/:blobId` (images only, sandboxed).
The session state (`ReporterChatState`) carries `runtime` (`ReporterChatRuntime`): model, effort, mode, the Claude's display name (an email in
it is cut, never an account id, plan id or credential), context, cost, copied from the portal's own session record, and the Claude's plan
windows (session, week: percent and reset) from the usage snapshot the Usage page shows (`planOf`; read through a 30 s cache, never a
probe); null where the portal has none. A runtime change is pushed on the stream like a state change.

- **Which sessions.** Only a session of the token's bucket: one of its direct-report targets, linked to one of its tickets, or in its default
  workspace; and one the token's person may `view` (reads) or `operate` (send) through the seam. Anything else, an unknown id or no chat is
  the same 404, checked before any count.
- **What it shows: never more than the portal shows the owner.** The person's and the assistant's text (redacted when stored, and again on the
  way out with `chat/redact.ts`), a tool call as its name and one line of its input (a command, a path; else the line the portal's row shows, such as an Agent call's description; at most 120 characters) with its call
  id, a tool result as `tool_result` with that id and `ok` (a failure carries its first two non-empty lines, so "Exit code 2" comes with its reason, redacted, at most 160 characters; a success
  carries nothing), an approval as one line, an error as one line, images by reference. Sub-agent lines, thinking, tool output, costs,
  system notes, a move's context and side questions are left out (`reporter/chat.ts`).
- **Sending.** The chat controller's own `send` (the path the portal's composer uses), as `portal-mcp:<token id>` named
  `<person> (reporter, <origin>)`: the transcript and Claude see that the message came through the widget on that site, not typed in the
  portal. Decided on the record (2026-10-31): the panel runs inside someone else's page, so its messages are framed like the reporter's
  ticket replies rather than as the owner at the keyboard. Text up to 8000 characters, optionally the current capture as one png, jpeg or
  webp image within the model's image limit. 20 messages per token per 10 minutes, every attempt counted. An ended session refuses (409).
  Approvals are never answered from the widget: the panel links out to pilot. Audited as `reporter.chat_sent`.

Rate limits: 30 tickets per token per hour (`REPORTER_LIMITS.ticketsPerHour`), 120 per origin per hour, 6 direct-to-session reports per token
per hour, 20 chat messages per token per 10 minutes.

Capture modes: `viewport` (only what was on screen; "Screen", the default), `full` (the whole page; desktop) and `crop`. `viewport` is
additive and accepted everywhere `full` is; the description says "screen (what was visible)".

## What is filed

- A ticket in the token's bucket, filed as a token caller labelled `Reporter: <origin>`, type `bug` by default, tag `ui-report`.
- Captures in `reporter_ticket_captures`; files as ticket attachments named by capture id (`<id>.png`, `<id>.evidence.json`) plus
  `repro.spec.ts` from the first capture's interaction trail.
- Validation: screenshots by magic bytes (PNG, JPEG, WebP) within 8 MB; the evidence parsed against `ReporterEvidence` (schema version, list
  caps refused, strings capped), every string redacted with `chat/redact.ts` plus JWTs and long `prefix_<base62>` keys; query values replaced;
  input values always `[masked]`; app state keys that look secret are redacted. The optional `captureGaps` (what the DOM screenshot
  could not draw, at most 10, one line of 200 characters each) is kept when present; older SDKs send none.
- The description is written by the server: the reporter's words on top, then where (site, environment, repo, domain, path, route, build
  commit, branch, version, device), a section per capture (URL, device, "Not captured: ..." when the shot has gaps, area and element,
  console errors, failed requests, LCP, UI check findings, attachment ids), steps to reproduce, and a deployment footer that the server rewrites when the state changes.

## Annotations

- A capture (ticket or review comment) may carry `annotations`: `ReporterAnnotation[]` (pen, highlight, line, arrow, rect, ellipse, blur,
  text, step) in the screenshot's pixels. `validate.ts` `cleanAnnotations` refuses an unknown type, a colour off
  `REPORTER_ANNOTATION_COLORS`, a wrong point count, a coordinate out of range (+-100,000) and anything over the caps (200 marks, 2,000
  points per mark, 20,000 per capture); text loses control characters, is cut at 300 characters and redacted like every string.
  Stored as JSON in `annotations` (migration 903, `reporter_ticket_captures` and `reporter_review_comments`).
- `x-reporter-kind: annotated`: the flattened image, PNG or WebP by magic bytes, within the screenshot cap, one per capture, only when the
  capture has marks, and REFUSED when a mark is a blur: the panel then uploads the flattened (blurred) image as the screenshot and never
  sends the original, so no un-blurred copy is stored. Kept as a ticket attachment `<id>.annotated.png` (`annotated_attachment`); review
  files move with the submit.
- Reads: `GET .../captures/:captureId/annotated` and `.../comments/:captureId/annotated` (bearer, declared in `authz.ts`); the panel's
  capture and comment views carry `annotatedUrl` and `marks`; the owner's evidence `annotatedAttachmentId` and `annotations`; the agent's
  evidence `annotated_attachment_id`, `marks`, `blurred`. Duplicate thumbnails and the direct-to-session chat images use the annotated image.
- The description's capture section says `Annotated (N marks)`, adds "blurred areas are removed from the screenshot (no original was
  uploaded)" with a blur, and names the annotated attachment.

## Direct to a session

`target: { kind: 'session', sessionId }` (one of the bucket's `sessionTargets`, live): the ticket is filed anyway (urgent, tag `ui-urgent`,
assigned to that session), then posted into the session's chat as the ticket (`ticket:T-n`): summary, a section per capture, up to 4
screenshots within the chat's image limits, the key and "reply on the ticket". It is sent when every capture has its files, or after 20
seconds with what arrived. A failure keeps the ticket, adds a comment saying so, and the panel shows `target.status = 'delivery-failed'`.

## Deployments

- Recorded per (bucket, repo, environment) (migration 901 adds `bucket_key` and `verified`): by a pipeline (`POST /api/reporter/deployments`
  with a Portal MCP token, operate, for each bucket it may operate on whose site serves that repo and environment, or only `bucket`), or by an
  agent (`reporter_record_deployment`): AUTHORITATIVE. By a signed-in panel (`POST /reporter/v1/observed-build`, for the token's bucket and
  the SITE's repo and environment, never the page's claim): OBSERVED, `verified` only when `git rev-parse --verify --quiet <sha>^{commit}`
  finds it in a checkout. The live commit is the newest pipeline row; only while there is none for that environment, the newest verified
  observed row (`confidence: 'observed'` on the state). Unverified rows are history only. See docs/prd/ui-reporter.md section 8.
- Konfersi stg, after a deploy (the token in a CI secret, never in the file):

  ```sh
  curl -fsS -X POST https://pilot.ai.isnan.me/api/reporter/deployments -H "Authorization: Bearer $PILOT_TOKEN" -H 'content-type: application/json' \
    -d "{\"repo\":\"platform/konfersi-landing-page\",\"environment\":\"stg\",\"commit\":\"$CF_PAGES_COMMIT_SHA\",\"branch\":\"stg\",\"label\":\"cf-pages stg\"}"
  ```

- Fix commits per ticket: `ticket_close` with `fix_commit`, a `Ticket: <KEY>` (or `T-n`) trailer found by `git log` in a workspace checkout
  of the repo, or a closing summary naming one ("commit abc1234", "fixed in abc1234").
- State per environment of the ticket's repo (every site of the bucket with that repo), from the live commit above: `deployed` when it is a fix commit, or
  `git merge-base --is-ancestor <fix> <live>` says so in a checkout; `not-deployed` when git says none is in it; else `unknown` with
  `no-fix-commit`, `no-build-seen` or `ancestry-unchecked`. Never guessed. A checkout is a repository the workspace-git scan found whose
  remote names the repo, in a running workspace; git runs read-only, as an argument list, nothing is fetched and no credential is read.
- Shown in the panel list, callouts (`deployment` of the viewed environment, `reportedOn`), `phase` (`deployed` only when proven for the
  viewed environment), the description footer, `GET /api/tickets/:id/reporter-evidence`, `ticket_get` (`reporter` note) and
  `reporter_evidence`.

## Portal MCP

- `ticket_get` carries `reporter: { from, origin, environment, repo, commit, captures, read }` for a reported ticket.
- `reporter_evidence <id>`: site, build, per-capture facts and attachment ids, repro steps, fix commits, deployments; as untrusted text.
- `ticket_close` takes `fix_commit` (7 to 40 hex).
- `reporter_record_deployment { bucket, repo, environment, commit, branch?, label? }`.

## Not built in this slice

- Knowledge and session reads use the owner's access (single owner today); the multi-user layer narrows them to the token's person.
