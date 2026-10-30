# VS Code extension

Draft v0.2 (T-1974, slice 1, after the blind security review: R1 to R5 applied, §14). Plan and principles: `docs/coord/PLAN-18.md` (VC1 to VC6). Sign-in model: [Identity and onboarding](identity-onboarding.md) FR51 to FR53. Access: [Authorization](authorization.md) and the seam (`apps/server/src/authz/seam.ts`).

## 1. Summary

ClaudePilot inside VS Code: the agents (leads and their workers), the tickets, the workspaces, the active Claude's usage and what needs you, approvals with their whole text, and a chat with one agent. The extension signs in with a device flow and holds a revocable token in VS Code's SecretStorage. It talks to the portal only through a small API under `/api/vscode`, and every object goes through the same authorization seam as the web. It does not open a remote workspace: that is the editor PoC of PLAN-18 §3 (options a to e), a separate piece of work.

## 2. Slice 1: what is built

| Part | Where | State |
| --- | --- | --- |
| Contracts (`VSCODE_API`, the wire types, the user-code alphabet, the version) | `packages/contracts/src/vscode.ts` (self-contained: the extension bundles it as it is) | built |
| Device flow, the person's approval, the bearer routes | `apps/server/src/vscode/{device,routes,authz}.ts`, mounted in `app.ts` under `/api/vscode` | built, tested |
| The approval page | `apps/web/src/features/vscode/VscodePage.tsx`, route `/admin/vscode?code=` | built, typechecked; not looked at in a browser yet |
| Extension: sign-in, Agents, Tickets, Workspaces, status bar, approvals, Chat | `tools/vscode/` | built, unit tested, web smoke passed |
| Packaging | `tools/vscode/scripts/package.sh` (`npm run package` → `tools/vscode/claudepilot.vsix`) | built; not wired into `.pilot` yet |

One migration, **49** (additive): `pmcp_tokens.client` (`'vscode'` or NULL) and `pmcp_tokens.client_instance`. The review asked for a dedicated `purpose`; that column's CHECK allows only `user` and `workspace`, and changing a CHECK means rebuilding the table (a data rewrite, which needs the owner), so the marker is a column of its own with the same effect. The device flow keeps its pending codes in memory (ten minutes; a restart means "sign in again").

### 2.1 Layout

`tools/vscode/` has its own `package.json` and lockfile and is NOT in the root workspaces (`apps/*`, `packages/*`): the root Dockerfile copies each workspace's `package.json` by hand, so a new workspace would break `docker build`; the gate and the server suite do not see it. Dev dependencies only (`@types/vscode` 1.95.0, `@vscode/vsce`, `@vscode/test-web`, `esbuild`, `typescript`, `tsx`, `@types/node` for the tests). The bundle has no runtime dependency.

- One bundle, `dist/extension.js`, built by esbuild for a neutral platform (CommonJS, `vscode` external), is both `main` (desktop and remote extension host) and `browser` (the web host). Its `tsconfig.json` has no Node types (`lib: ES2022 + WebWorker`), so a Node-only API in the shared code fails the typecheck; the bundle's only `require` is `vscode` (checked).
- Stable API only (`engines.vscode ^1.95.0`), no proposed API.
- `extensionKind: ["workspace", "ui"]`: in a remote window (this devcontainer) it runs in the remote extension host, next to the `kubectl port-forward` at `127.0.0.1:3400`.

Commands (from `tools/vscode/`): `npm ci`, `npm test` (unit), `npm run typecheck`, `npm run package` (→ `claudepilot.vsix`), `npm run test:web` (the web smoke, §9). In the cluster: `scripts/job-run.sh --ref <pushed commit> --steps none --artifacts tools/vscode/claudepilot.vsix --out job-out/vsix -- 'tools/vscode/scripts/package.sh'`. Install: `code --install-extension tools/vscode/claudepilot.vsix`.

## 3. Settings

| Setting | Default | Rule |
| --- | --- | --- |
| `claudepilot.portalUrl` | `http://127.0.0.1:3400` | `https://` anywhere; `http://` ONLY for this machine (`localhost`, `127.x.x.x`, `::1`): a token over plain http to another host could be read on the way. No user name, password or path. Scope `machine`: a folder's `.vscode/settings.json` cannot change it. |
| `claudepilot.pollSeconds` | 15 | 5 to 300: how often the views, the status bar and the approvals refresh. The Chat view polls every 2.5 s while it is visible. |

## 4. Sign-in: the device flow (RFC 8628)

1. The extension calls `GET /api/vscode/version` and stops with a clear message when the API versions do not fit (§8).
2. `POST /api/vscode/device { client }` → `{ deviceCode, userCode, verifyUrl, verifyUrlComplete, expiresIn: 600, interval: 5 }`. `client` is the window's name (`Visual Studio Code (dev-container)`): one line of plain text, at most 40 characters, with control, format (bidi overrides, zero-width, soft hyphen), private-use and unassigned characters dropped, so a name can't be made to read as another. `instance` is the installation's own id (a UUID it made once, kept in its global state; not a secret).
3. VS Code shows the code (`BCDF-GHJK`) with Open Portal and Copy Code. The link is built from the address in the settings plus `/admin/vscode?code=`, never from what the server answered, so it always opens the portal you set (through `asExternalUri`, which maps a remote `127.0.0.1` to a forwarded port).
4. The person opens `/admin/vscode` signed in (any device: the phone works too). A link with `?code=` looks nothing up by itself: the page shows the code large and the person types its **last 4 letters** from their own VS Code (without a link, the whole code). Only then do the client's name, the time and, prominently, the **address the request came from** show, with a warning when it is not the address the person's own browser comes from. Then Approve or Deny.
5. On Approve the portal makes the token **then**, with the person as its creator (MCP audit `token_created` by `user:<id>`, platform audit `vscode.approved` with the token id). If making it fails, the code stays pending and the person can approve again. A token nobody picks up before the code expires is revoked.
6. The extension polls `POST /api/vscode/token { deviceCode }`: `pending`, `slow_down` (the wait grows by 5 s), `denied`, `expired`, or once `ok` with the token. The code is gone after that answer.

**Codes.** Both public calls take 4 KiB at most (like sign-in), refused before anything reads the body; the address's limit is checked before the body is parsed (the workspace-id rule runs after it). The device code is 256 random bits, kept as its SHA-256. The user code is 8 letters from `BCDFGHJKLMNPQRSTVWXZ` (no vowels, no look-alikes; RFC 8628 §6.1), about 2.6e10 values; at most 20 codes wait at once, they last ten minutes, and only a signed-in person can try one (30 tries per 10 minutes per person). Starts are limited to 10 per 10 minutes per address, polls to 60 a minute.

**The token.** A Portal MCP personal token (`cpat_`, 256 bits, SHA-256 at rest), scope `operate`, 30 days, label `VS Code · <client>`, marked `client = 'vscode'` with its `client_instance`. Issued through `PortalMcpModule.createToken`: signing in again from the SAME installation revokes that installation's previous token; another client with the same name keeps its own. The MCP audit has `token_created` / `token_revoked`. `/mcp` refuses a `vscode` token with the same 401 as an unknown token: it opens `/api/vscode` only. It is listed and revocable in Access → MCP tokens; Sign Out in VS Code revokes it at the portal (`POST /api/vscode/logout`). Why this and not a new table: the machinery (hashing, expiry, revocation, last use, audit) exists and fits; FR51's `login_sessions.client = 'vscode'` row waits for the identity work (multi-user), which will move these tokens there.

**In VS Code** the token lives in SecretStorage only (the OS keychain on the desktop; the host's secret store on the web), under a key that names the portal's origin (`claudepilot.token:<origin>`): changing the address never sends an old token to the new one. Never in settings, global state, a file or a log.

## 5. Auth model on the wire, and why it is safe

The web app is a cookie (`portal_session`, `HttpOnly`, `SameSite=Strict`) plus the Origin rule on every non-GET `/api` call: a page on another site cannot make the browser send a request that the portal accepts, because the cookie is sent automatically and the Origin check is what stops cross-site requests (CSRF).

The extension has no cookie. Its requests carry `Authorization: Bearer <token>` and nothing else, so:

- **CSRF does not apply**: a browser never attaches a bearer token by itself; a hostile page cannot make one appear. A request that carries BOTH a cookie and a bearer is refused (`400`, FR51), so no page can ride a person's cookie into the bearer routes.
- **Only device-flow tokens open them**: the token must be live (not revoked, not expired) and marked `client = 'vscode'` (a label proves nothing: a token made in Access → MCP with the same label gets `401`). Any other Portal MCP token, even an admin one, gets the same `401` as an unknown one.
- **The Portal MCP switches hold**: with the Portal MCP off (Access → MCP) every bearer route is refused (`403`); with session control off, send and deny are refused.
- **Capped at operate**: the request's actor is a token actor (`{ kind: 'token', scope: 'operate' }`); the seam caps it at `operate` whatever the token's scope. It can read what the person sees, send to a session and answer an approval; it cannot manage anything, touch settings, sharing, tokens or Bypass, and it never reaches a route that needs a password check.
- **The same seam**: every list is filtered with `visible()`, every session is checked with `can(actor, view | operate, session)`, a ticket with its bucket's `view`; a refusal is the same `404` as a missing object (tested with a resolver that hands a session to another user).
- **The other `/api` rules hold**: `Cache-Control: no-store`, the body size limits, and the workspace-id rule (QA-032: a hostile `workspaceId` in a body or query is `422` before a handler runs; `qa/workspacepaths.test.ts` covers these routes too). The global Origin check still runs: a desktop or remote extension host sends no Origin, so it passes; a cross-site page is refused as before.
- **Per token**: 600 calls a minute at most.
- **Declared**: every route is in `vscode/authz.ts`; the bearer ones as `bearer: true` (`kind: 'bearer'` for `me` and `logout`, `signed-in` with a filter or `objects` checks for the rest), so the real layer's default deny will know them.

What a token does is written down: `vscode.token_issued`, `vscode.approved` / `vscode.denied` (the person), `vscode.sent` (a character count, never the text), `vscode.answered`, `vscode.signed_out` in the platform audit, actor `portal-mcp:<token id>`. No row holds the token, the device code or message text (tested).

**Messages and denials are the token's, not the person's** (review R3). A message is sent as `portal-mcp:<token id>` with the label `VS Code · <client>`, like a Portal MCP tool: the transcript shows who sent it, and Claude reads the portal's frame (it never reads as something the person typed in the web app). A deny is recorded with the same actor. The slash rule of a token applies (only `/compact`, `/context`, `/reload-plugins`).

## 6. Approvals: the whole text, deny only (decided)

**Decision (coordinator, security review R2, option a): in slice 1 VS Code never allows.** The extension offers **Deny** and **Open in Portal**; the person allows in the web app, with its own card and rules, as over the Portal MCP for a token without admin. The earlier Allow path (operate plus a hash of the shown text) is removed.

- `GET /api/vscode/approvals` lists the open requests of the sessions the person may OPERATE, each with `full` (exactly what is asked, up to the portal's 8,000-character cap) and `fullCut`.
- A new one arrives as a notification: `<agent>: <what it asks> (<tool>)`, with Review, Deny and Open in Portal.
- Review opens the WHOLE text read-only (a `claudepilot-approval:` document), then a modal with Deny and Open in Portal.
- `POST /api/vscode/sessions/:id/respond { requestId, decision: 'deny', note? }`. `decision: 'allow'` is refused (`403`, "Allow it in the portal"). Deny needs session control on; the first answer wins.

A later slice may bring Allow back only with a decision on the record (a fresh portal sign-in or a second factor, and the hash of the shown text).

## 7. Chat view

A WebviewView with one agent's transcript and a message box. Rules (VC4):

- CSP: `default-src 'none'; style-src <webview>; img-src <webview>; font-src <webview>; script-src 'nonce-<128 random bits>'; connect-src 'none'; form-action 'none'; base-uri 'none'`. One script, from a file, by nonce; no inline script or handler; no remote anything; the page makes no network call (the extension does every call).
- The HTML holds no data from the portal. Everything arrives by `postMessage` and is set with `textContent` (`media/chat.js`): an agent's text can never become markup, a link or a script.
- The transcript is the main thread only: messages, tool NAMES (not their input or output), approvals, errors and turn ends; sub-agents' lines stay in the portal. At most 200 events a call, 20,000 characters an event.
- The page may ask one thing: send a message (a string up to 50,000 characters); anything else is ignored.

## 8. Version compatibility

The API is versioned (`VSCODE_API_VERSION = 1`). `GET /api/vscode/version` answers `{ api, minApi }`, and EVERY `/api/vscode` answer (refusals too) carries `X-Pilot-Vscode-Api: <api>`. The extension refuses to sign in when it is older than `minApi` ("Update the extension") or the portal is older than its own API ("Update the portal"), and warns once when a later answer's header shows a mismatch. A portal without the API answers `404`: "The portal has no VS Code API here. Is the address right, and is the portal up to date?"

## 9. Tests (what ran, 2026-10-21)

| What | Command | Result |
| --- | --- | --- |
| Server: device flow, and the routes THROUGH `createApp` (cross-site approve 403, the 4 KiB limits, `/mcp` refuses the token, a label alone opens nothing, the same-installation replace, the MCP switches, deny only, the token as the chat actor, the seam, the declarations, migration 49) | `node --import tsx --test src/vscode/vscode.test.ts` (apps/server) | 17 pass |
| Running portal (scratch, clean environment) | `QA_PORT=3351 QA_CODE=<code> node tools/qa/vscode-auth.mjs` | 11/11 pass |
| Neighbours of the changes | `qa/workspacepaths`, `qa/auth`, `qa/static`, `qa/emailLogin`, `qa/idcheck`, `qa/migrations`, `store/store`, `platform/platform`, `notify/routes`, `appports/routes`, `authz/contracts`, `authz/seam`, `portalmcp/{portalmcp,tools,toolPolicy,managers,tokenLabel,tokenRules,tokenLease,tokenHeal,tokenDefaultWorkspace}` | all pass (workspacepaths failed with 240 hostile ids before the id rule covered these routes) |
| Typecheck server + contracts, web | `scripts/job-run.sh ... npm run typecheck -w ...` | rc 0 |
| Extension unit tests (API client against a fake portal over real HTTP, tree models, status bar, approval text, CSP, redaction) | `npm test` (tools/vscode) | 15 pass |
| Extension typecheck (shared code without Node types; tests with them) | `npm run typecheck` | clean |
| Web smoke: VS Code for the Web (stable), headless Chromium 154 at `/usr/bin/chromium`, the extension under development, the FAKE portal | `npm run test:web` | PASSED (203 s with the first download, 19 s after): a plain-http remote address refused, device sign-in, views and status bar filled (`$(dashboard) 61%  $(bell-dot) 2`), Chat opened, sign-out; 31 calls to the fake, none with a cookie |

The fake portal (`tools/vscode/test/fake-portal.mjs`) is the API with fixed data; its token is made at run time. No real portal, Claude or credential is used by any test.

## 10. Unverified

- **A real desktop VS Code** (Electron, the OS keychain behind SecretStorage, native notifications and the modal) and **this devcontainer's remote extension host**: not run here. Manual check: install the `.vsix`, sign in against a portal that has this API, approve on the phone, see Agents and the status bar, open Chat and send, review an approval, sign out and see the token revoked in Access → MCP tokens.
- **The real portal end to end**: the API is not deployed. Until this branch is released, the cluster portal behind `127.0.0.1:3400` answers `404` and the extension says so.
- **The approval page**: checked in a browser on 2026-10-21 (390 and 1280, light and dark): PASS (code large, no lookup until the last 4 letters, requester address with a warning, Approve/Deny 44 px).
- **The web host against the real portal**: untested. The portal sends no CORS headers and its CSRF layer refuses a foreign Origin, so a web-hosted VS Code on another origin will most likely be refused (the smoke used a fake that allows any origin). Slice 2.
- **Marketplace or Open VSX** publishing, and `@vscode/test-electron`: not tried.
- **Multi-user**: today every token is the founding user's (the single-owner seam). With accounts, the token must be bound to its person (FR51's `login_sessions.client`).

## 11. Threats and abuse cases

| ID | Abuse | Control | Test |
| --- | --- | --- | --- |
| V1 | A hostile page uses the person's cookie on the bearer routes | bearer routes refuse any request with a cookie; the Origin rule stays on `/api` | cookie + bearer → 400 |
| V2 | A token stolen from a log or output | the token is in SecretStorage only; `redact()` hides token shapes, bearer headers and `token=`/`deviceCode` values in every message the extension writes; the server logs none | redact unit test; audit rows hold no token or code |
| V3 | A stolen token used elsewhere | 30-day life, operate cap, opens `/api/vscode` only (`/mcp` refuses it), off with the Portal MCP switch, revocable in the portal and by Sign Out; a sign-in from the same installation replaces it | revoked and replaced tokens → 401; `/mcp` → 401 |
| V4 | Phishing: someone gets the person to approve THEIR code | a link looks nothing up; the person types the last 4 letters from their own VS Code; the requester's address shows prominently with a warning when it is not theirs; invisible and bidi characters are dropped from the name; nothing is approved by the link | name cleaning test; page logic; browser check pending |
| V5 | Guessing a user code | 8 of 20 letters, at most 20 pending, 10 minutes, only signed in, 30 tries per 10 minutes per person | rate-limit code; unknown code → 404 |
| V6 | Flooding starts | 10 starts per 10 minutes per address, 20 pending in all | PENDING_MAX test |
| V7 | Allowing something from the editor that should be looked at in the portal | no Allow over `/api/vscode` at all (R2); the person allows in the web app | `decision: 'allow'` → 403 |
| V13 | One client's sign-in revoking another's token by sharing its name | replace only the same installation (`client_instance`) | two installations, one name: both live |
| V14 | A token made but never received | made at approval, handed over once, revoked when the code expires unclaimed | device unit test |
| V8 | Agent text turns into markup or a link | tree labels, tooltips and notifications are plain strings; the webview sets `textContent`; strict CSP | CSP test; text kept as `<b>` literally |
| V9 | A folder's settings point the extension at another portal | `portalUrl` is machine-scoped; tokens are stored per portal origin; http only for loopback | address tests |
| V10 | Reading or answering what the person may not | the seam on every object; the same 404 | resolver test with another user's session |
| V11 | A token sends a terminal-only slash command | the token's slash rule (as over MCP) | `/clear` → 403 |
| V12 | A version skew breaks silently | version endpoint and header, clear messages | compat unit test |

### Residual risk after the review (accepted, 2026-10-21)

- **Phishing of the device flow.** A hostile agent (or anyone) can start a flow and put the code in front of the owner. Typing the last 4 letters only proves the person has the code in front of them; the real signal is the requester address and its warning, which is noisy on mobile data and silent behind a proxy without `trustProxy`. What a phished token can do is bounded: read agents, tickets, usage and transcripts; with session control on, send portal-framed messages (labelled "VS Code · <client>") and deny requests. It can never Allow, and it is refused on `/mcp`. Revoke in Access → MCP tokens.
- **Failed bearer attempts** are not rate-limited; acceptable with 256-bit secrets.

## 12. Slice 2 (suggested)

1. Deploy the server part and run the manual check of §10 in this devcontainer; then wire `package.sh` into `.pilot` (a job that uploads the `.vsix` as an artifact).
2. Live updates instead of polling: a bearer-authenticated SSE stream of the glance/live topics for the trees, the status bar and the chat.
3. CORS for the bearer routes (an allow-list of web editor origins, no credentials), so the web host works against the real portal.
4. The session diff (a `claudepilot:` read-only scheme and the diff editor), a terminal (a Pseudoterminal over the portal's terminal socket with a bearer handshake), Stop for an agent, and starting a session from a ticket.
5. When identity lands: move the tokens to `login_sessions.client = 'vscode'` (FR51 to FR53), bind them to their person, show them under Devices, a 30-day sliding life, and the `user via client` actor capped at operate in the seam.
6. A browser check of `/admin/vscode` (phone first) by the UI check.

## 13. Owner decisions

- **Decided by the coordinator (2026-10-21, D-62 defaults):** publisher id `claudepilot`; distribution as a `.vsix` built by pilot CI (no Marketplace or Open VSX for now); licence as the repository (`UNLICENSED`, private package); slice 1 has no Allow (Deny and Open in Portal).
- Whether a later slice brings **Allow** back to VS Code, and with what (§6).

## 14. Security review (2026-10-21): what changed

The blind review found the device flow sound and asked for R1 to R5. R1: tokens are marked `client = 'vscode'` (migration 49); `/api/vscode` requires the marker, `/mcp` refuses it as unknown. R2 (decided by the coordinator): no Allow from VS Code; Deny and Open in Portal; send and deny honour the Portal MCP switches. R3: messages and denials are the token's (`portal-mcp:<id>`, labelled), not the person's. R4: the approval page needs the last 4 letters and shows and compares the requester's address; client names lose invisible and bidi characters; 4 KiB on the public calls with the rate limit before the body; the approver is the token's creator and the approval's audit names the token; replace only the same installation; a failed issue leaves the code pending. R5: the server tests go through `createApp`, and `tools/qa/vscode-auth.mjs` checks a running portal.
