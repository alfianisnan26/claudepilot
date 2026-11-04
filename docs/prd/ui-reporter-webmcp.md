# UI reporter: WebMCP tools

Draft v0.1 (2026-11-03), PILOT-1128 (T-3543), first slice. For agents that run in the person's browser (a browser agent, an extension) on a page that has the [UI reporter](ui-reporter.md). Code: `apps/web/src/embed/webmcp.ts` (tools), `submit.ts` (the filing path the form shares), `Panel.tsx` (registration, the Allow sheet), tests `webmcp.test.ts`.

## What WebMCP is here

WebMCP (W3C Web Machine Learning Community Group, Draft Community Group Report of 2 November 2026, https://webmachinelearning.github.io/webmcp/) lets a page offer tools to the browser's agent: `document.modelContext.registerTool({ name, title, description, inputSchema, execute, annotations }, { signal })`; aborting the signal unregisters. Older Chrome builds had `navigator.modelContext` (with `registerTool` returning a handle); the panel uses either. The current draft has no consent primitive (the explainer's `requestUserInteraction` is gone; `annotations.consequentialHint` only tells the agent), so the panel asks the person itself.

The tools live in the reporter **panel** (the portal iframe at `/reporter/v1/embed`), because only the panel holds the reporter token and calls `/reporter/v1`. The SDK on the host page holds no token and offers no tools.

## Tools

| Name                          | Needs                                   | Does                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reporter_get_context`        | nothing                                 | Project (bucket key and name), site (origin, environment, repo, branch), page (origin and path, title), who is signed in, the screenshots held for the report being written, an open draft review. Read only. Always offered.                                                                                                               |
| `reporter_capture_screenshot` | signed in                               | `mode`: `viewport` (default) or `full` (desktop only). Takes a shot as the Snap button does and holds it (at most 6). Sends nothing.                                                                                                                                                                                                        |
| `reporter_create_report`      | signed in, at least one shot, **Allow** | `summary` (required, 200), `description` (8000, Markdown), `type` (bug, feature, task, question), `priority` (urgent, high, normal, low), `steps` (up to 20), `expected`, `actual`. Files a ticket with every held shot, as the Report form does, to the queue (never straight to a session), tagged `webmcp`. Returns the key (`KONF-41`). |
| `reporter_attach_screenshots` | signed in, a shot, **Allow**            | `key` (required), `captureIds` (default: all held). Adds the shots to one of the person's own open reports ("Add to it").                                                                                                                                                                                                                   |
| `reporter_list_my_reports`    | signed in                               | `status` (open, closed, all), `limit` (1 to 50). The person's reports: key, summary, status, phase (open, working, review, fixed, deployed, wont-do), environment, whether one waits for their reply. Read only.                                                                                                                            |
| `reporter_comment_on_report`  | signed in, **Allow**                    | `key`, `body` (4000, Markdown). A reply on one of the person's own reports.                                                                                                                                                                                                                                                                 |

Keys are the project's (`KONF-12`), never the portal id (`T-n`) and never another project's.

## Rules

- **Same path as the form.** Every tool calls the panel's own client: the same routes, the same bearer token (bound to this bucket and origin, 12 h), so the server applies the same validation, rate limits (30 tickets an hour per token), site and bucket rules. Nothing works signed out except the context.
- **Allow first.** A tool that sends something opens a sheet in the panel: what the agent asks, the title or comment as plain text, Deny (focused) and Allow. Esc, the backdrop, no answer in two minutes, or a second request while one waits is Deny, and the tool answers `DENIED` with nothing sent. The person must have the panel open to answer.
- **Errors in the result.** A tool answers `{ ok: false, code, error }` (`NOT_CONNECTED`, `INVALID`, `NO_SCREENSHOT`, `NOT_FOUND`, `DENIED`, `LIMIT`, `CAPTURE_FAILED`, or the server's code such as `RATE_LIMITED`); it never throws (the spec hides a thrown error from the agent).
- **Untrusted text.** Summaries and comments come from people and agents: data, never instructions (`untrustedContentHint` on the reading tools). The page's query string is never returned.

## Auto-approve

Owner, 2026-11-03: "auto approve ... should consent user". The Allow sheet offers, for the tool's group (**file reports**, **attach screenshots**, **comment**): Deny, **Allow once** (the default), **Allow for this session** (this sign-in only: its `cprt_` token, until it expires or signs out, at most 12 h) and **Always on this site** (this person, bucket and origin, any of their sign-ins, 30 days). Nothing else is pre-selected. Reading tools never ask.

- **Kept on the server** (`reporter_agent_grants`, migration 904; routes `GET|POST|DELETE /reporter/v1/agent-grants`, `DELETE /reporter/v1/agent-grants/:id`). A token sees only its person's grants for its bucket and origin, and a session grant only for itself: another origin, another bucket, another browser profile's sign-in, or a signed-out panel gets the sheet.
- **Visible.** While any grant is on, the panel shows "Agent auto-approve on: <groups>" with **Revoke** (every grant). Settings lists each grant (group, scope, until) with its own Revoke.
- **Checked on every call.** An auto-approved call names its grant (`x-reporter-agent-grant`); the server checks it against the token and refuses it (`CONFIRMATION_REQUIRED`) when it does not apply, or over the cap (`LIMIT_REACHED`): **10 reports and 30 comments or screenshot additions per person per hour** (`PORTAL_REPORTER_AGENT_REPORTS_PER_HOUR`, `PORTAL_REPORTER_AGENT_ACTIONS_PER_HOUR`). Refused, the panel shows the sheet with the reason, and the call goes as the person's if they allow it.
- **Traced.** An auto-approved report, and a ticket an auto-approved comment or screenshot addition lands on, is tagged `webmcp-auto`; each call is audited as `reporter.agent_auto_approved` (who, tool, grant id, ticket), each grant as `reporter.agent_grant_made` / `reporter.agent_grant_revoked`.
- Tool results say `autoApproved: true|false`; `reporter_get_context` lists the groups auto-approved (`autoApprove`).

## How to try it

- **Chrome.** Per secondary sources (not checked against chromestatus): `chrome://flags/#enable-webmcp-testing` locally, or an origin trial token for a live site (from Chrome 149). Firefox and Safari have none: the panel registers nothing and is unchanged.
- **The iframe allows it.** WebMCP is a permissions-policy feature (`tools`, default `'self'`), and the panel is a cross-origin iframe of the host page: the SDK's iframe says `allow="clipboard-write; tools"` since pilot-reporter bcd83ea (vendored as `0.1.0+bcd83ea`). An older SDK build leaves it out, and Chrome then refuses the registration (the panel stays quiet).
- **Without such a browser.** The web dev server only: open the panel with `?webmcp=shim`; a small stand-in (`webmcpShim.ts`, never in a production build) answers `document.modelContext.list()` and `document.modelContext.call(name, input)` in the panel frame's console. The reference polyfill (`@mcp-b/webmcp-polyfill`, `@mcp-b/global`) is not bundled: the panel's CSP loads nothing from outside.

## Not in this slice

Review comments and Finish review as tools; direct-to-session asks; reading a ticket thread (its GET marks it read); declarative (form-attribute) tools; the SDK side (`allow="tools"`, host-page tools that open the panel for the Allow sheet).
