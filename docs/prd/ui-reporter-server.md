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

## Pages and files under /reporter/v1

| Route | What |
| --- | --- |
| `GET /reporter.js` | `vendor/reporter.js` (placeholder in this slice; the integration step vendors the real SDK and `vendor/VERSION`), `text/javascript`, 5 minutes cache, ETag, `Cross-Origin-Resource-Policy: cross-origin`. |
| `GET /axe.js` | `vendor/axe.min.js` when vendored (pinned axe-core), else 404: the SDK then records `checks.ran = false` with the reason. |
| `GET /embed?bucket=&origin=` | The panel: `apps/web/dist/embed.html` (a placeholder when the web app was built without it). CSP `frame-ancestors <origin>` exactly, when the origin is a site of that enabled bucket. Otherwise an empty page with `frame-ancestors 'none'` and `X-Frame-Options: DENY`. |
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

Rate limits: 30 tickets per token per hour (`REPORTER_LIMITS.ticketsPerHour`), 120 per origin per hour, 6 direct-to-session reports per token
per hour.

## What is filed

- A ticket in the token's bucket, filed as a token caller labelled `Reporter: <origin>`, type `bug` by default, tag `ui-report`.
- Captures in `reporter_ticket_captures`; files as ticket attachments named by capture id (`<id>.png`, `<id>.evidence.json`) plus
  `repro.spec.ts` from the first capture's interaction trail.
- Validation: screenshots by magic bytes (PNG, JPEG, WebP) within 8 MB; the evidence parsed against `ReporterEvidence` (schema version, list
  caps refused, strings capped), every string redacted with `chat/redact.ts` plus JWTs and long `prefix_<base62>` keys; query values replaced;
  input values always `[masked]`; app state keys that look secret are redacted.
- The description is written by the server: the reporter's words on top, then where (site, environment, repo, domain, path, route, build
  commit, branch, version, device), a section per capture (URL, device, area and element, console errors, failed requests, LCP, UI check
  findings, attachment ids), steps to reproduce, and a deployment footer that the server rewrites when the state changes.

## Direct to a session

`target: { kind: 'session', sessionId }` (one of the bucket's `sessionTargets`, live): the ticket is filed anyway (urgent, tag `ui-urgent`,
assigned to that session), then posted into the session's chat as the ticket (`ticket:T-n`): summary, a section per capture, up to 4
screenshots within the chat's image limits, the key and "reply on the ticket". It is sent when every capture has its files, or after 20
seconds with what arrived. A failure keeps the ticket, adds a comment saying so, and the panel shows `target.status = 'delivery-failed'`.

## Deployments

- Recorded per (repo, environment): by a signed-in panel (`POST /reporter/v1/observed-build`, for the SITE's repo and environment, never the
  page's claim), by a pipeline (`POST /api/reporter/deployments` with a Portal MCP token, operate, on a bucket whose site serves that repo
  and environment), or by an agent (`reporter_record_deployment`).
- Konfersi stg, after a deploy (the token in a CI secret, never in the file):

  ```sh
  curl -fsS -X POST https://pilot.ai.isnan.me/api/reporter/deployments -H "Authorization: Bearer $PILOT_TOKEN" -H 'content-type: application/json' \
    -d "{\"repo\":\"platform/konfersi-landing-page\",\"environment\":\"stg\",\"commit\":\"$CF_PAGES_COMMIT_SHA\",\"branch\":\"stg\",\"label\":\"cf-pages stg\"}"
  ```

- Fix commits per ticket: `ticket_close` with `fix_commit`, a `Ticket: <KEY>` (or `T-n`) trailer found by `git log` in a workspace checkout
  of the repo, or a closing summary naming one ("commit abc1234", "fixed in abc1234").
- State per environment of the ticket's repo (every site of the bucket with that repo): `deployed` when the live commit is a fix commit, or
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

- The real SDK and axe-core are not vendored yet (placeholders; the integration step does it).
- Knowledge and session reads use the owner's access (single owner today); the multi-user layer narrows them to the token's person.
