# PRD: GitHub Codespaces as a workspace target (POC)

| | |
| --- | --- |
| Status | **Draft v0.1, POC.** **Built** (server, K1): GitHub connections by token or by the OAuth device flow with a client ID only, the token sealed in Secrets & env, the real "connected" check, the Codespaces lifecycle provider (repos, devcontainers, machines, create, poll, start, stop, delete, attach, detach), audit rows, a fake GitHub for tests. **Not built**: the devcontainer side and the workspace lifecycle in the portal (K2), the UI (K3). **Nothing was run against real GitHub with a token**: every API fact is from GitHub's documentation and OpenAPI description (📄) or seen against the stand-in (✅ stand-in); what needs a real account is 🔬 (§16). |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Secrets & env](secrets-env-pool.md) (the token is a sealed secret), [Targets and Connect](targets-connect.md) (the agent inside the codespace, K2), [Claude Code version pinning](claude-version-pinning.md) (the pinned Claude Code inside, K2), the authorization seam (`apps/server/src/authz/seam.ts`) |
| Related | [Built-in MCP catalogue](mcp-builtin-catalogue.md) and [MCP providers](mcp-providers.md) (GitHub's MCP template stays token-only; this device flow is a different, portal-side thing) |

Marks: ✅ observed here (how), ✅ stand-in (behaviour of our fake, not GitHub's), 📄 documented (source, read 2026-10-12), 🔬 unverified (needs a real account).

## 1. Summary

A person connects their GitHub account to the portal, once: by pasting a fine-grained token, or by signing in with GitHub's device flow (a code and a link, no client secret in the portal). The token becomes an ordinary sealed secret in a Secrets & env set. With it the portal lists the person's repositories and their devcontainer configurations and machine types, creates a codespace (repository, branch, machine, devcontainer, idle timeout, retention), follows its state, starts, stops and deletes it, and remembers which codespaces it is responsible for (attached). Detach makes the portal forget a codespace and leaves it at GitHub; Delete deletes it at GitHub after the person types its name.

The codespace then becomes a workspace through a devcontainer that installs the Connect agent and a pinned Claude Code (K2, not in this document's build scope). Cost and quota are not exposed by the Codespaces API and are shown as unavailable, with the reason.

## 2. The request, and how this PRD reads it

The owner (2026-10-12, translated): *"Not an integration of the GitHub Copilot CLI, but GitHub Codespaces as a workspace target (a devcontainer), with Claude Code still inside. Reuse the device flow with a client ID only and storing the GitHub token in the Secrets store. First verify the permissions the Codespaces API needs."*

| The owner said | Read as |
| --- | --- |
| "manual: a fine-grained token with the Codespaces permission, stored as a secret" | `POST /api/codespaces/connections {method:'token'}`: checked at GitHub first, then sealed in a new set "GitHub <login>" (§8.1). Or point at a secret that already exists. |
| "OAuth device flow, client ID from an env var, no client secret" | `PORTAL_GITHUB_CLIENT_ID`; unset = the path is unavailable and says so (§8.2). There is no client-secret setting anywhere. |
| "GitHub App as a next step, its secret in the Secrets store" | §17 N1. |
| "first verify the permissions/scopes" | §6, every row marked. |
| "lifecycle through the REST API ... cost/quota if the API provides it" | §7 and the provider (§12); cost is 📄 not exposed (§6 F17). |
| "Detach vs Delete, Unreachable, Start, idle timeout, keep-alive" | Detach/Delete/attach built here (§7); Unreachable and Start in the workspace list are K2's (§13). Keep-alive: not built, and not planned without evidence (§7.3). |
| "who may create with whose token" | §10: the connector only, unless the token's set is explicitly shared through the authorization seam. |

## 3. Goals and non-goals

| ID | Goal |
| --- | --- |
| G1 | Connect GitHub without the portal ever holding a client secret. |
| G2 | The token is a Secrets & env secret like any other: sealed, versioned, rotatable, deletable; never in a log, a response, an argument list, an audit row or a file of ours. |
| G3 | "Connected" is a real check against GitHub, cached with its time, never a flag. |
| G4 | Every GitHub codespace state maps to one portal phase; nothing unknown is ever shown as running. |
| G5 | A person can only use a GitHub token they connected (or one explicitly shared with them). |

Non-goals (POC): GitHub Enterprise Server; GHE.com data residency (the client accepts `*.ghe.com` hosts, the service is wired for one configured host); creating from a pull request; export and publish; changing a codespace's machine; Codespaces secrets management (K2 may need user secrets for enrollment, §13); a chat engine on GitHub's side.

## 4. Scope boundary with K2 and K3

| Package | Owns |
| --- | --- |
| K1 (this build) | Contracts (`packages/contracts/src/codespaces.ts`), GitHub auth (token and device flow), the lifecycle provider, the stand-in, this PRD. |
| K2 | The devcontainer.json / Dev Container Feature (Connect agent + pinned Claude Code, auto-update off), the real `devcontainer` CLI run in DinD, the transport comparison (reverse connect vs `gh codespace ssh`), the workspace lifecycle in the manager (Unreachable when stopped, Start, Detach and Delete on the workspace), the manual checklist. Uses `Codespaces.start/stopCodespace/get/waitFor/attached` from K1. |
| K3 | The UI: connect dialog (Token \| Sign in), device code + link, status chip, repo/branch/machine/devcontainer picker, Start/Stop/Detach/Delete with confirms. |

## 5. Background: what exists that this extends

- Secrets & env stores values in `secret_values`, sealed under the portal key and bound to their row; a set is a pool of type `secrets` with versions, rotation, revocation and deletion. Tool logins (a GitHub login kind) are designed in that PRD (§10.2) but **not built**, so this POC stores the token as a plain secret entry, `GITHUB_CODESPACES_TOKEN` ✅ (code read).
- The built-in MCP catalogue's GitHub template is token-only (GitHub's authorization server has no dynamic client registration and its web flow needs a client secret). The device flow needs only a client ID 📄, so it is usable from the portal; it is NOT used for MCP here.
- The stand-in provider pattern (`apps/server/src/mcp/builtin/testkit`) is reused for the fake GitHub (§14).
- The account pool is for Anthropic credentials only: a GitHub token never goes there.

## 6. Findings: the Codespaces API and its permissions

Sources: S1 = docs.github.com/en/rest/codespaces/codespaces (apiVersion 2022-11-28); S2 = docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens; S3 = the OpenAPI description `github/rest-api-description` main, `api.github.com.json` v1.1.4, downloaded unauthenticated ✅; S4 = docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps (device flow); S5 = …/scopes-for-oauth-apps; S6 = docs.github.com/en/codespaces/…/setting-your-timeout-period-for-github-codespaces; S7 = …/configuring-automatic-deletion-of-your-codespaces; S8 = docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth. All read 2026-10-12.

| # | Fact | Mark |
| --- | --- | --- |
| F1 | Endpoints used: `GET /user/repos`, `GET /repos/{o}/{r}`, `GET /repos/{o}/{r}/codespaces/devcontainers`, `GET /repos/{o}/{r}/codespaces/machines` (`ref`, `location`), `GET /repos/{o}/{r}/codespaces/new` (defaults: location, devcontainer_path, billable owner), `GET\|POST /user/codespaces`, `GET\|PATCH\|DELETE /user/codespaces/{name}`, `POST /user/codespaces/{name}/start`, `…/stop`. Not used: create in repo or from a PR, export, publish, `permissions_check`, `/user/codespaces/{name}/machines`. | 📄 S1, S3 |
| F2 | Create body: `repository_id` (or `pull_request`), `ref`, `location` (deprecated in favour of `geo`: `EuropeWest`, `SoutheastAsia`, `UsEast`, `UsWest`), `client_ip`, `machine`, `devcontainer_path`, `multi_repo_permissions_opt_out`, `working_directory`, `idle_timeout_minutes`, `display_name` (48 characters), `retention_period_minutes` (0 to 43200). Answers 201 or 202. | 📄 S1, S3 |
| F3 | Start answers 200, 304, 400, 401, **402** (payment), 403, 404, **409** (conflict), 500; delete answers **202**. | 📄 S1 |
| F4 | States: `Unknown, Created, Queued, Provisioning, Available, Awaiting, Unavailable, Deleted, Moved, Shutdown, Archived, Starting, ShuttingDown, Failed, Exporting, Updating, Rebuilding` (17). | 📄 S3 |
| F5 | A codespace carries `git_status` (ahead, behind, has_uncommitted_changes, has_unpushed_changes, ref), `idle_timeout_notice` (org policy overrode it), `last_known_stop_notice` (example: "you've used 100% of your spending limit for Codespaces"), `retention_period_minutes`, `retention_expires_at`, `pending_operation` (then only delete is possible), `billable_owner`, `web_url`. | 📄 S3 |
| F6 | **Classic and OAuth-app tokens need the `codespace` scope** for these endpoints ("Grants the ability to create and manage codespaces"). S1 does not state a scope for `GET …/codespaces/new`. | 📄 S1, S5 |
| F7 | **Fine-grained tokens**, repository permissions: **Codespaces** read = list and get (`GET /user/codespaces`, `/user/codespaces/{name}`, `/repos/…/codespaces`); **Codespaces** write = create (both forms and from a PR), `PATCH`, `DELETE`, `GET …/codespaces/new`, `permissions_check`, publish. **Codespaces lifecycle admin** write = start, stop, export. **Codespaces metadata** read = devcontainers, machines. Account permission **Codespaces user secrets** = `/user/codespaces/secrets/*`. Least privilege for this POC: Codespaces (write), Codespaces lifecycle admin (write), Codespaces metadata (read), on the selected repositories; Metadata (read) is implied for `GET /user/repos`. | 📄 S2 |
| F8 | GitHub App **installation** tokens cannot use `/user/codespaces*` (`enabledForGitHubApps: false`) but can use devcontainers, machines, `new`, `permissions_check`. GitHub App **user** tokens (`ghu_`): S1 says the endpoints work "for authenticated users, OAuth apps, and GitHub Apps"; whether a user-to-server token with the Codespaces permissions creates a codespace is not observed. | 📄 S1, S3 · 🔬 user tokens |
| F9 | Device flow: `POST https://github.com/login/device/code` (`client_id`, `scope`) and `POST https://github.com/login/oauth/access_token` (`client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code`). "The `client_secret` is not needed for the device flow." Must be enabled in the app's settings (`device_flow_disabled` otherwise). User code 8 characters with a hyphen; verification at `https://github.com/login/device`; codes last 900 s by default; `interval` minimum; `slow_down` adds 5 s; 50 code submissions per hour per app; errors `authorization_pending`, `slow_down`, `expired_token` (the page also says `token_expired`: both handled), `unsupported_grant_type`, `incorrect_client_credentials`, `incorrect_device_code`, `access_denied`. JSON with `Accept: application/json`. | 📄 S4 |
| F10 | A device-flow token from **our own** OAuth App, with the `codespace` scope, can call the Codespaces API. Plausible by F6 (OAuth-app tokens with `codespace`), not observed. | 🔬 |
| F11 | Without the `repo` scope an OAuth token lists only public repositories in `GET /user/repos`; whether `codespace` alone can create a codespace for a private repository the user can push to is not stated. | 🔬 |
| F12 | OAuth App access to an organization's repositories is subject to the organization's third-party application policy (the org must approve the app); fine-grained tokens on org repositories are subject to the org's fine-grained token policy (approval may be required). Not re-read this round. | 🔬 |
| F13 | Idle timeout: default 30 min, 5 to 240 min; an organization's lower maximum wins and the person is told after creating. Billing covers the whole active time. | 📄 S6 |
| F14 | Retention: stopped codespaces are deleted after 30 days by default (0 to 30 days); reset on every connection; **deleted irrespective of unpushed changes**; an org's shorter period wins; an email one day before deletion when the period exceeds a day. | 📄 S7 |
| F15 | A "maximum lifetime of 12 hours" for a running codespace was reported by the reader of S6; not confirmed in a second source. | 🔬 |
| F16 | `X-OAuth-Scopes` lists a token's scopes (classic and OAuth); fine-grained tokens carry no scope header, so their permissions cannot be read back; the portal infers "limited" from a 403 on `GET /user/codespaces`. | 📄 S5 · ✅ stand-in |
| F17 | **Cost and quota are not in the codespace API.** User billing usage exists at `GET /users/{username}/settings/billing/usage` ("only available to users with access to the enhanced billing platform"); the permission it needs for a user token and whether it breaks Codespaces out per codespace are not checked. The panel shows "unavailable" with the reason. | 📄 S3 · 🔬 billing API |
| F18 | Copilot SDK docs accept `gho_`, `ghu_` and `github_pat_` from "your own" OAuth App or GitHub App; relevant only to the superseded Copilot scope (Appendix A). | 📄 S8 |

## 7. Lifecycle

### 7.1 States to phases

| GitHub state | Phase | Portal shows / allows |
| --- | --- | --- |
| Created, Queued, Provisioning, Awaiting | `creating` | spinner; Delete |
| Starting | `starting` | spinner; Delete |
| Available | `running` | Stop, Detach, Delete |
| ShuttingDown | `stopping` | spinner |
| Shutdown, Archived | `stopped` | Start, Detach, Delete; retention date |
| Exporting, Updating, Rebuilding, Moved | `busy` | wait; Delete |
| Unavailable, Failed | `error` | GitHub's stop notice; Delete |
| Deleted, or 404 | `removed` | Detach clears it |
| Unknown, or any new string | `unknown` | never treated as running |

Settled phases (a poll stops): running, stopped, error, removed. `waitFor` polls `GET /user/codespaces/{name}` from 2 s backing off to 15 s, with a 3 s cache shared by callers, up to 10 min ✅ stand-in.

### 7.2 Attach, Detach, Delete

- Create attaches the new codespace. **Attach** adopts one made elsewhere (in the browser).
- **Detach** forgets it in the portal; the codespace stays at GitHub, untouched (✅ stand-in: still listed there). K2 adds: revoke its Connect enrollment.
- **Delete** calls `DELETE /user/codespaces/{name}` after the person types its name; uncommitted and unpushed work in it is lost (F5 tells the dialog whether there is any).

### 7.3 Idle timeout and keep-alive

Idle timeout and retention are set at create within F13/F14's limits, shown from GitHub's answer, with GitHub's org-policy notice when it overrode them. **No keep-alive**: GitHub bills active time (F13) and nothing documented says activity from an agent connection counts; a keep-alive would burn quota silently. Whether a Connect agent's or `gh codespace ssh` traffic resets the idle timer is 🔬 (K2 checklist).

## 8. Flows

### 8.1 Manual token

1. Person pastes a token (20 to 255 printable characters). 2. The portal calls `GET /user` (401: refused, nothing stored) and `GET /user/codespaces?per_page=1` (403/404: stored, state `limited`). 3. Sealed into a new set "GitHub <login>" (entry `GITHUB_CODESPACES_TOKEN`), or as the next version of the same entry when that person connects the same GitHub account again (one connection per account). 4. Audit `codespaces.connected`. Alternative: point at an existing secret (`{method:'secret', poolId, entryName}`), which needs `operate` on that set.

Token types: `github_pat_` preferred; `ghp_` (classic) accepted with the `codespace` scope (F6) and reported as `tokenType: ghp`; `gho_`/`ghu_` accepted. ✅ stand-in.

### 8.2 Device flow

```
Browser            Portal (server)                               GitHub
  | POST /device ->  | POST /login/device/code {client_id,scope} -> |
  | <- code, link    | <- device_code (kept in memory), user_code     |
  |   (dialog may    | every interval: POST /login/oauth/access_token |
  |    be closed)    |   pending -> wait; slow_down -> +5 s           |
  |                  | <- access_token -> sealed secret, connection   |
  | GET /device/:id  | state: connected / denied / expired / failed   |
```

One pending flow per person (a second start returns it), 10 starts per person per hour, the device code never leaves the server process and is cleared when the flow ends, the user code is hidden once it ends, finished flows are forgotten after 10 minutes. Cancel stops polling; a token that arrives after cancel is dropped. ✅ stand-in (success, denied, cancel, expiry, slow_down, device flow disabled, unknown client ID, no client secret ever sent: the stand-in refuses one).

### 8.3 The "connected" check

On connect and on demand (`POST …/check`); a 401 on any call turns the connection `invalid`. States: `connected` (both calls 200), `limited` (signed in, cannot list codespaces), `invalid` (401, or the secret was deleted), `unknown` (rate limit, network: the last state is not assumed). Checked-at time shown. ✅ stand-in, ✅ scratch portal.

## 9. Data and storage declaration

| What | Where | Size, rate | Retention | Trust | On delete / detach / unreachable |
| --- | --- | --- | --- | --- | --- |
| GitHub token | Secrets & env: `secret_values` in `portal.db`, AES-GCM under the portal key, bound to its row; set "GitHub <login>" | < 1 KB per version; one write per connect | Secrets & env rules (versions, revocation, purge) | secret | Disconnect keeps the set unless `deleteSecret` (refused while a workspace has the set); deleting the set makes the connection `invalid` |
| Connections, attachments | `<data>/codespaces.json`, file mode 0600, atomic write | about 1 KB per connection (max 5 per person), 200 B per attachment; written on change only | until Disconnect / Detach / Delete | names, ids, login, scopes; no token, no hint | GitHub unreachable: kept; a codespace deleted at GitHub stays attached until Detach (K2 shows "gone") |
| Device flows | process memory | < 1 KB each | 10 min after the end; lost on restart (the person starts again) | device code secret (never leaves memory) | n/a |
| Codespace views | process memory cache | per codespace, 3 s | 3 s | untrusted text from GitHub, clipped and stripped of control characters | n/a |
| Audit | `platform_audit` (PlatformAudit) | one row per act | 90 days | kinds, ids, names only | n/a |

Backup: `portal.db` is covered by the portal's backups; whether `codespaces.json` is copied with them is 🔬 (losing it loses only which codespaces were attached and the connection pointers; tokens survive in Secrets & env). Multi-user: `ownerId` on each connection, `by` on each attachment.

## 10. Who may use a token (multi-user)

- A connection belongs to the person who made it (`ownerId`). It is usable when **both**: the seam allows `operate` on the secret set that holds the token (`pool`, poolType `secrets`), **and** the asker is the owner — or, once the real authorization layer runs (`authzMode() === 'multi-user'`), the seam's decision on that set, which is how an explicit share works. Taking the set away takes the connection away.
- Lists show only usable connections; anything else answers 404 (no existence leak). ✅ test with two fake users (`u_a`, `u_b`).
- **Persons only**: agents and Portal MCP tokens get 403 on every route (POC decision O3).
- Billing: whoever owns the token is the billable owner GitHub reports (F5), so a shared token makes its owner pay for others' codespaces: sharing stays explicit.

## 11. Security and threat model

| Threat | Mitigation | Status |
| --- | --- | --- |
| Token in logs, responses, audit, files, argv | Header only; errors are fixed messages mapped from status (a GitHub body is never echoed); audit `detail` is ids and names; no child process is spawned (fetch only). A canary test drives every route and greps responses, console, audit, `codespaces.json` and the stand-in's log. | ✅ test, ✅ scratch portal (grep of portal log and data dir: 0 hits) |
| Client secret | No setting exists; the stand-in refuses one if sent. | ✅ |
| SSRF / wrong host | The client only talks to `github.com`, `api.github.com` or `*.ghe.com`; any other origin needs `PORTAL_GITHUB_STANDIN_URL`, ignored when `NODE_ENV=production` and logged loudly otherwise; `redirect: 'error'`; 15 s timeout; 2 MB body cap. | ✅ code |
| Path injection | Repo `owner/name`, codespace names, refs, devcontainer paths, machine names validated by pattern before any URL is built. | ✅ test |
| CSRF | The portal's Origin check on mutating requests. | ✅ foreign Origin → 403 on the scratch portal |
| Phishing with the device code | The verification URI must be on the configured GitHub web origin, or it is refused. | ✅ code |
| Leaked token | Fine-grained, repository-scoped, short expiry recommended; rotation through Secrets & env; revocation is at GitHub (§12 Disconnect note). | documented |
| Rate limits | 403/429 with `x-ratelimit-remaining: 0` or `retry-after` → 429 `RATE_LIMITED` with `retryAt`; no retry loop. | ✅ stand-in |

## 12. API

All under the session guard (`/api/codespaces`), declared in `codespaces/authz.ts`. Types: `packages/contracts/src/codespaces.ts`.

| Route | Does |
| --- | --- |
| `GET /api/codespaces` | `CodespacesStatus`: device flow available (and why not), usable connections, the asker's pending flow |
| `POST /connections` | `{method:'token', token}` or `{method:'secret', poolId, entryName}` → `GitHubConnection` (201) |
| `POST /connections/:id/check` | re-check → `GitHubConnection` |
| `DELETE /connections/:id` | `{deleteSecret?}`; the token stays valid at GitHub: a device-flow token cannot be revoked without the client secret (`DELETE /applications/{client_id}/token` needs it), so the UI links to the person's GitHub settings |
| `POST /device`, `GET\|DELETE /device/:flowId` | start, read, cancel a device flow (`DeviceFlowView`) |
| `GET /connections/:id/repos?q=` | up to 50 repositories |
| `GET /connections/:id/repos/:owner/:repo/options?ref=` | devcontainers, machines, defaults, limits |
| `GET /connections/:id/billing` | `{available:false, reason}` (F17) |
| `GET\|POST /connections/:id/codespaces` | list (with `attached`) / create (`CodespaceCreateRequest`, 201) |
| `GET /connections/:id/codespaces/:name` | one `CodespaceView` (3 s cache) |
| `POST …/:name/start`, `…/stop`, `…/attach`, `…/detach` | lifecycle and the portal's record |
| `DELETE /connections/:id/codespaces/:name` | `{confirm: name}`; deletes at GitHub |

Errors: 401/403 from GitHub → 403 `FORBIDDEN` with `details.github`; 402 → 403 with the spending-limit message; 404 → 404; 409 → 409; 429 → 429 `RATE_LIMITED` (`details.retryAt`); network or 5xx → 503. Validation → 422. Device flow off or refused by GitHub → 409 with the reason.

Configuration (read by `codespaces/index.ts`, not `config.ts`): `PORTAL_GITHUB_CLIENT_ID`, `PORTAL_GITHUB_SCOPES` (default `codespace`), `PORTAL_GITHUB_STANDIN_URL` (non-production only).

## 13. What K2 needs from this

- `Codespaces.attached(actor)`, `get`, `start`, `stopCodespace`, `waitFor`, `detach`, `remove` (service.ts) — server-side, so the workspace manager can map a codespace to a workspace without HTTP.
- Enrollment token into the codespace: Codespaces **user secrets** (`PUT /user/codespaces/secrets/{name}` with `selected_repository_ids`, account permission "Codespaces user secrets" write, F7) need the value encrypted with libsodium's sealed box to the account's public key (`GET /user/codespaces/secrets/public-key`); Node has no sealed box built in, so this needs a dependency or a small implementation (📄 S2 for the permission; the encryption requirement is from the secrets API docs, not re-read this round 🔬). Alternative: a create-time `working_directory`/devcontainer that fetches a one-time plan URL.
- `gh codespace ssh` needs a token on the portal side with the same permissions plus whatever the SSH tunnel needs 🔬.

## 14. Testing

- `apps/server/src/codespaces/codespaces.test.ts` (17 tests, 3 runs agree): state mapping (every state), create limits, manual token (connected, refused, limited, classic scopes, re-check to invalid, deleted secret, disconnect and delete the set, from an existing secret), device flow (unavailable without client ID, success with sealed token and no client secret sent, denied, cancel, expiry, slow_down, disabled, a flow belongs to its starter), lifecycle (options, create → running → stop → stopped with retention date → start → detach keeps it at GitHub → attach → delete with confirm), refusals (missing lifecycle permission, spending limit 402, rate limit, bad input), multi-user (two fake users, agent and token actors), canary (every route; responses, console, audit, file, stand-in log).
- The fake GitHub `standin.ts` (and `standin-cli.ts` for a scratch portal): device flow with its errors, REST with the F7 permission model per token kind, a state machine with a movable clock, quirks (rate limit, spending limit, device flow disabled), a request log that keeps keys only.
- Scratch portal (port 3341, clean environment `env -i`, private HOME, Kubernetes off) with the stand-in on 3342: device flow approved through the stand-in's control endpoint → connected `gho_` connection, set "GitHub octocat" with hint `gho_…`; options; create → Queued/creating → Available/running; stop → Shutdown/stopped with retention date; delete refused without the name, then deleted; manual fine-grained token → connected, `scopes: null`; bogus token → 422; no client ID → device unavailable (409 with reason); foreign Origin → 403; no session → 401; the token found 0 times in the portal log and in the data directory ✅.

## 15. Owner decisions (taken provisionally, listed for review)

| ID | Decision |
| --- | --- |
| O1 | Default device-flow scope is `codespace` only, not `repo` (least privilege); the repo picker then shows public repositories for OAuth tokens and accepts a typed `owner/name` (F11 🔬). `PORTAL_GITHUB_SCOPES` can add `repo`. |
| O2 | No migration: metadata in a JSON file next to the database. |
| O3 | Persons only: agents and tokens cannot use a GitHub connection in the POC. |
| O4 | One connection per (person, GitHub account): connecting again replaces the token as a new version. At most 5 connections per person. |
| O5 | No keep-alive (§7.3). |

## 16. Unverified (manual checklist with a real account)

F8 (user-to-server tokens), F10 (our OAuth App's device token creates codespaces), F11 (`codespace` without `repo` for private repos), F12 (org policies), F15 (12-hour lifetime), F17 (billing API), whether agent traffic resets the idle timer (§7.3), the sealed-box requirement for Codespaces secrets (§13), the error bodies GitHub really sends for 402/409 on start, and `codespaces.json` in backups (§9).

## 17. Risks (CS7)

| Risk | What it means | What the portal does |
| --- | --- | --- |
| Cost and quota | Codespaces bill per core-hour and per GB-month to the billable owner (personal or org); spending limits stop codespaces (F5 example notice); the API exposes no cost (F17). | Shows machine size, idle timeout and retention at create; shows GitHub's stop notice; billing "unavailable" with the reason; no keep-alive. |
| Token permissions | A leaked token can create, start and delete the person's codespaces (and read code through them). | Fine-grained, repository-scoped tokens recommended (F7 list); sealed storage; rotation through Secrets & env; no portal-side revocation of device tokens (§12). |
| Organization policy | Orgs restrict machine types, idle timeout, retention, who may create on their repos, OAuth App access and fine-grained tokens (F12, F13, F14). | Shows GitHub's notices (`idle_timeout_notice`, stop notice); maps 403 to "a permission or an organization policy". |
| Non-root image | Codespaces images run as `vscode`/`codespace`; installing the agent and Claude Code must work without root at start. | K2. |
| Retention and deletion | Stopped codespaces are deleted after the retention period **even with unpushed changes** (F14). | Shows `retentionExpiresAt` and `git_status` (uncommitted, unpushed) on stopped codespaces; Delete confirms by name. |
| Multi-user | Whose token creates, who pays, who may use a codespace. | §10: connector only, explicit share through the seam; persons only. |
| Data handling | Code, the agent's work and any credentials delivered into the codespace live in GitHub's cloud. | Documented; Secrets & env delivery into a codespace is K2's and follows the same rules. |
| Availability | Reverse connect needs the portal reachable from GitHub's cloud; a local portal is not. | K2's transport comparison. |
| Device flow tokens | A device token from our OAuth App may not reach org repositories until the org approves the app (F12). | Fine-grained token path stays available. |

## 18. Milestones

| Milestone | Status |
| --- | --- |
| CS-A API and permissions verified from docs | **Built** (§6), with 🔬 rows |
| CS-B Connections: token and device flow, sealed token, real check | **Built**, ✅ stand-in and scratch portal |
| CS-C Lifecycle provider and attach/detach/delete | **Built**, ✅ stand-in and scratch portal |
| CS-D Devcontainer, agent, pinned Claude Code, transports | **Not built** (K2) |
| CS-E Workspace lifecycle in the manager (Unreachable, Start, Detach/Delete) | **Not built** (K2) |
| CS-F UI | **Not built** (K3) |
| CS-G Real-account checklist (§16) | **Not done** |

## 19. Next steps

- N1 **GitHub App** (instead of an OAuth App): fine-grained permissions per installation and user-to-server tokens (`ghu_`, expiring, with refresh tokens). Refreshing a `ghu_` token needs the app's client secret: it would live in the Secrets store (a sealed secret the server opens for the refresh call only), which this POC avoids. Web flow and issue/PR access come with it.
- N2 Portal-side revocation of device tokens: needs the client secret (`DELETE /applications/{client_id}/token`): only with N1's secret.
- N3 GHE.com data residency: the client already accepts `*.ghe.com`; a per-connection host choice in the service and the UI.
- N4 Portal MCP read tool (`codespaces_list`) once K2 maps codespaces to workspaces (not built: K2's mapping decides what it should return).
- N5 Billing usage (F17) if the owner's account has the enhanced billing platform.

## 20. Runner targets: a Codespace as a burst runner (T-557)

A second use of the same provider, separate from the workspace target of K2: a Codespace that runs one heavy job and goes away. The seam is `RunnerTarget` in `apps/server/src/ci/runnerTarget.ts` ([local-git-ci.md](local-git-ci.md) §23 has the contract and how a target is picked).

**What a runner target is.** Where a heavy job (a typecheck, a suite, a build) executes: `cluster` today (a Kubernetes Job made by `scripts/job-run.sh`), `codespace` next. The caller asks for "run this command on this pushed ref" and gets a log and an exit code, whatever the target.

**Lifecycle for a burst job** (never a 24/7 codespace):

1. **Create or start**: a stopped codespace the portal made for this purpose (name prefix `pilot-runner-`) is started; otherwise one is created (smallest machine that fits, `idle_timeout_minutes` set to the lowest GitHub allows, retention 1 day). The target waits for `Available` up to the start timeout.
2. **Run**: the command runs inside, from a clean checkout of the pushed ref. Output streams back; the exit code is the command's.
3. **Collect** log and rc (and artifacts the caller named), before anything is stopped.
4. **Stop** when the run ends, in every case (pass, fail, timeout, cancel).
5. **Delete when idle**: a runner codespace unused for the idle-delete period (default 30 minutes) is deleted by the target's sweep; a runner that is not in a settled state past its deadline is deleted at once. Stopped codespaces would otherwise cost storage until retention ends.

**Limits per run.** The deadline (default 3600 s, at most 5400, the same as `job-run`) and a cost cap: `maxMinutes × machine core-hours` is computed before the run from the machine type and refused when over the owner's per-run cap. GitHub's API shows no cost (F17), so the cap is an estimate and is labelled so; GitHub's own spending limit is the hard stop.

**Credentials.** The GitHub token is the sealed secret of a connection (§8), read by name through the Secrets pool by the server only. It never appears in a command line, a log, an audit row or an error text; the log passes the same mask as `job-run`'s. The repository token for the checkout is delivered the same way as for the cluster Job (a secret file, not an argument).

**Failure modes.**

| Failure | Behaviour |
| --- | --- |
| Start timeout (not `Available` in 10 minutes) | Run fails with `start_timeout`; the codespace is deleted. |
| Quota or spending limit (402, 403, 409 on create/start) | Run fails with `quota`, GitHub's notice shown; nothing is retried; no codespace left. |
| Stuck codespace (state `Unknown`, `Failed`, or no progress past the deadline) | Deleted, never left to retention; the run fails with `runner_error`. |
| Command timeout | Process stopped, log and rc collected as far as they go, codespace stopped. |
| Portal restarts mid-run | The sweep finds `pilot-runner-*` codespaces past their deadline and deletes them. |
| Delete itself fails | Retried by the sweep; reported on Needs you after 3 tries (an unattended paid resource). |

**What S2 adds** (real Codespaces; needs a GitHub account the owner chooses and a spending limit): the `codespace` target on top of `CodespacesProvider`, the in-codespace command runner (SSH or the codespaces exec endpoint, 🔬), the devcontainer for runner use, the sweep job, and the real-account checklist for this section (start time, idle timer behaviour, costs per minute). Until then only the fake target exists, and the portal never calls GitHub for this.

**Open questions for the owner** (each with the default that is built unless told otherwise):

| ID | Question | Default |
| --- | --- | --- |
| R1 | Which GitHub account pays (personal or an org), and what monthly spending limit? | None chosen: S2 is not started. |
| R2 | Machine type for runners? | The smallest with 4 cores and 8 GB that the account offers. |
| R3 | Per-run cost cap? | 2 core-hours (4 cores, 30 minutes). |
| R4 | Idle-delete period? | 30 minutes. |
| R5 | Which jobs may go to a codespace (all `job-run` work, or only opt-in `--runner codespace`)? | Opt-in only; the cluster stays the default. |
| R6 | May a runner codespace see the same repository tokens as the cluster Job? | Only the clone token, not the npm token, unless the owner says. |

## Appendix A. GitHub Copilot CLI findings (superseded scope)

`@github/copilot` 1.0.95 (npm loader + native package, 172 MB on linux-arm64), run in a clean environment with bogus tokens only ✅: token variables in order `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`; none set: "Error: No authentication information found." (exit 1).
`ghp_` is refused locally: "Classic Personal Access Tokens (ghp_) are not supported by Copilot." (exit 1); bogus `github_pat_`/`gho_`/`ghu_`: "Authentication token found but could not be validated … (401): GitHub returned: Bad credentials" (exit 1); its logs did not contain the token.
`copilot login --help` accepts fine-grained PATs with "Copilot Requests" and OAuth tokens of the Copilot CLI and gh apps; a third-party OAuth App's token is not listed (the SDK docs, F18, say it works: 🔬).
`copilot login --device-code` prints github.com/login/device and a code; credentials go to the system keychain, else `~/.copilot/`; `--acp` runs it as an Agent Client Protocol server (the protocol a chat adapter would use).
