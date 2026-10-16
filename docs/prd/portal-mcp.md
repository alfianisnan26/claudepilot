# PRD: Portal MCP server

| | |
| --- | --- |
| Status | **v0.6, partly built** (2026-10-12). Built and checked with Claude Code 2.1.296: the `/mcp` endpoint on SDK v2, admin tokens and per-session agent tokens (§12.6), audit, rate limits, the sanitizer, the tool registry, 35 tools, resources and prompts, and Access → MCP (§13.5, §15). **Not built:** OAuth and the claude.ai connector (MCP4), the public listener, secret links, settings and event tools, the relaxation guard, elicitation (§18). Written from research on the MCP 2026-07-28 spec, the TypeScript SDK v2, Anthropic's connector and Claude Code docs, and this codebase, then revised after review. Items marked 🔬 need a live check against claude.ai, Claude Code or Cloudflare before they become acceptance criteria. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Pools foundation](foundation-pools.md) (storage, encryption, event log, delivery). Each tool group also needs its feature's service: [Account Pool](account-pool.md), [Settings & policies](settings-policies.md), [Monitoring dashboard](monitoring-dashboard.md), [Chat sessions](chat-sessions.md). |
| Related | [Multi-user](multi-user.md) and [Authorization](authorization.md) (token binding, tool declarations), [Skillset pool](skillset-pool.md), [MCP set pool](mcpset-pool.md), [Persona pool](persona-pool.md), [Secrets & env pool](secrets-env-pool.md), [Browser & desktop pool](browser-desktop-pool.md) (planned) |

## 1. Summary

The portal gets its own MCP server, so an admin can manage workspaces, pools, chat sessions,
settings and monitoring by asking Claude in claude.ai (web or phone), Claude Desktop or Claude Code.
It's one stateless Streamable HTTP endpoint, `/mcp`, inside the existing Hono server, built on the
official TypeScript SDK v2.

Claude Code and scripts connect with personal access tokens (PATs) made in the portal. claude.ai
custom connectors, which also serve Desktop and mobile, sign in through a small OAuth 2.1 server in
the portal. Tokens carry one of three scopes (read, operate, admin), and every authenticated call is
audited. Secrets never pass through chat, destructive actions are confirmed, changes that relax
security are refused, workspace text is treated as untrusted, and steering agents stays off until an
admin turns it on. Reachability: §11.3.

Agents inside a workspace use a narrow part of the same endpoint (tickets, proposals for review, who-am-I)
with a token minted for one chat session (§12.6): the owner asked for "internal mcp access", and this is
the one place a portal token enters a workspace.

## 2. Background and problem

- All management happens in the web UI, and Claude, where the admin already works (often on a
  phone), can't see or change anything. `/api/*` is browser-only (a `SameSite=Strict` cookie plus
  CSRF checks) and plain HTTP on the admin's machine, while claude.ai calls from Anthropic's cloud.
- A claude.ai connector also loads in any Claude Code signed in with the same claude.ai account,
  including an "own login" workspace, whose agent would then hold the admin tools (§10.1).
- **One shared server code, no per-user identity.** Everyone signed in is "Admin", so every token
  acts as "the admin", and audit can name a token, a client and an IP, never a person (§12.5).

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Manage almost everything from Claude:** workspaces, all seven pool types (policies included; account pools through their own tools), chat sessions, settings and monitoring, from claude.ai, Desktop, mobile and Claude Code. The exceptions are listed in §13.4. |
| G2 | **Native connection:** claude.ai's custom-connector flow works without workarounds. Claude Code connects with one command. |
| G3 | **Least privilege:** scoped tokens. claude.ai starts at read and operate, admin needs a step-up, and session control is off until enabled. No scope can relax security (§6). |
| G4 | **Safe by construction:** destructive actions confirmed, no secrets in chat, text from workspaces and third parties sanitized and labeled untrusted. |
| G5 | **Accountable:** every authenticated call and every sign-in event audited. Any token or connection can be revoked in the UI, and all of them at once over MCP, effective on the next request. |
| G6 | **Small public surface:** a separate loopback listener serves only the MCP and OAuth paths and two small pages, and the tunnel publishes nothing else. |

## 4. Non-goals

- **MCP for agents inside workspaces.** This server is for people; agents must not get it (§10.1).
- **A proxy.** It's a tool server Claude calls, never a hop between Claude Code and the Claude API.
- **A shell over MCP.** No tool takes a shell command. Session tools direct an agent that runs
  commands, so they count as code execution by proxy: admin scope, off by default (§13.3).
- **Per-user identity and roles.** A later PRD; v1 reserves `owner` columns.
- **The deprecated HTTP+SSE transport**, protocol sessions, the Tasks extension, MCP Apps (Q14).
- **Claude.ai subscription credentials.** The OAuth server issues the portal's own tokens for its
  own API and never sees a Claude.ai login.

## 5. Users and stories

**Admin**: holds the server code (today, everyone who signs in) and uses claude.ai, Desktop, Claude
Code or scripts. **Workspace user**: runs `claude` inside a workspace.

| ID | Story |
| --- | --- |
| US1 | As an admin, I connect claude.ai once: I add a custom connector with the portal's URL and client ID, enter the server code on the consent page, and the tools appear in claude.ai, Desktop and the mobile app. |
| US2 | As an admin, I create a token (read-only for a script) and add the server to Claude Code with one copied command. |
| US3 | On my phone, I ask what's running and whether anything is broken, and get an answer from live portal data. |
| US4 | I ask Claude to create a workspace with the "team" account pool and a persona. It reports progress until the workspace runs. |
| US5 | I ask Claude to delete a workspace. I see what will be lost (home volume, running sessions) and confirm first. |
| US6 | I ask what an agent is doing and interrupt it. With session control on, I answer its question or steer it; steering needs admin scope. |
| US7 | I ask Claude to add an API key. It gives me a link, I paste the key on the portal's page, and the key never appears in the chat. |
| US8 | I see every MCP call (when, which token or connection, which tool, outcome) and revoke any token or connection. From my phone, I can revoke all of them at once. |
| US9 | As a workspace user signed in with my own claude.ai account, my agent doesn't get the portal's tools by default. Where the portal can't ensure that, the workspace shows "Not protected". |

## 6. Scope boundary

The MCP server makes the portal a control plane reachable from the internet. A stolen token or a
prompt-injected model must not be able to widen its own access, weaken security or hide its tracks.

| Allowed over MCP | Never over MCP |
| --- | --- |
| Read what the UI shows, with secrets masked (read). | Read or accept a secret value (API keys, tokens, secret env values, the server code). Tools return a link instead (§14.3). |
| Start, stop and resync workspaces; check accounts; interrupt or end a chat session, answer its question or deny its request; revoke every token and connection with `mcp_lockdown` (operate). | Pass a shell command to a workspace. No tool takes one. |
| Create and delete workspaces; manage pools, account pools and accounts; change settings; start, steer and reconfigure chat sessions and approve their permission requests (admin). | Changes that [Settings & policies](settings-policies.md) FR1 flags as relaxing security (allowing Bypass or Auto, removing a deny rule, turning off the sandbox, a managed-only lock or an allowlist), through any tool (FR13). Lowering a retention period. |
| Read the audit log. | Import, approve, reject or revoke a skill version, approve an MCP catalog entry, or publish a persona. Each needs a person reading the content in the UI. |
| | Create or reveal tokens, revoke a single one, rotate the server code, switch sign-in, turn MCP on or change its settings (`mcp_lockdown` only turns it off), delete audit records. |
| | Put a portal token into a workspace, or touch a workspace user's own Claude.ai login. |

## 7. Solution overview

```
 claude.ai web, mobile, Desktop              Claude Code, scripts
 (Anthropic cloud)                           (portal machine)
   │ https://cp.example.com/mcp                │ http://localhost:3000/mcp
   ▼                                           │ Bearer cpat_…
 Cloudflare edge → tunnel → cloudflared        │
   │ 127.0.0.1:3001 (public listener)          │ main listener
 ┌─▼───────────────────────────────────────────▼────────────────────────────────────────┐
 │ Public paths only (§11.2)                   UI, /api/*, terminal; /mcp for PATs      │
 │ Trusts CF-Connecting-IP                     on loopback; ignores CF-* headers        │
 │ Host gate · Origin check · per-IP limits                                             │
 │ /.well-known/*, /oauth/*: authorization server    /connect/*: consent, secret entry  │
 │ /mcp  SDK v2, stateless: auth → scope → limits → tool → guards → services → audit    │
 │ services shared with /api/*: workspaces, pools, sessions, settings, monitoring       │
 │ delivery engine ── push ──▶ every workspace: deny entry for the portal connector     │
 └── Portal: one Node process, Hono ────────────────────────────────────────────────────┘
```

Tools are a thin adapter over the same services as `/api/*`, with the same validation, side effects
and events. MCP adds only auth, scopes, guards (confirmation, relaxation, review), sanitizing, rate
limits and audit.

## 8. Functional requirements

### Endpoint and auth

- **FR1** One stateless Streamable HTTP endpoint, `/mcp`, in the existing Hono app (§11).
- **FR2** MCP is off until an admin enables it, which needs `PORTAL_SECRET_KEY` and a stable server
  code (§12.5). While off, `/mcp`, `/oauth/*`, `/connect/*` and `/.well-known/oauth-*` return 404.
- **FR3** `PORTAL_PUBLIC_URL` (an `https://` origin) and the public listener enable OAuth and
  claude.ai (§11.2). Without them, `/mcp` takes PATs on loopback only: on the main listener, from a
  loopback socket, with a loopback Host. Changing the URL revokes all connections.
- **FR4** Only the public listener trusts `CF-Connecting-IP`, and it serves only §11.2's paths. The
  main listener ignores `CF-*` and `X-Forwarded-*` headers and rejects the public hostname.
- **FR5** Only the UI creates PATs; it lists and revokes PATs and grants. The consent page requires
  the server code. `mcp_lockdown` revokes everything at once.
- **FR6** Rotating the server code offers "Also revoke MCP tokens and connections", on by default
  (pending Q4). A restart never revokes anything.
- **FR7** Three hierarchical scopes are checked on every call (§12.4). Annotations enforce nothing.

### Tools and results

- **FR8** Every tool in §13 has a `title`, a description of what it does (at most 1,000 characters,
  no instructions to Claude), all four annotations, and input and output schemas. Results carry
  `structuredContent` plus one text block: a one-line summary and the JSON once.
- **FR9** Lists page with `cursor` and `limit` (default 25, max 100); cursors are HMAC-signed, bound
  to the filter, and expire after an hour. Each block stays under 20,000 characters (`truncated`).
- **FR10** OAuth tokens: a missing or invalid token gets HTTP 401; insufficient scope gets 403
  `insufficient_scope`. PATs: an invalid token gets 401; insufficient scope gets the tool error
  `SCOPE_REQUIRED` naming the scope, because a PAT can't step up (§12.4). Other fixable problems
  (validation, conflict, not found, rate limit, Locked, Frozen, `UI_ONLY`) are tool errors
  (`isError: true`) with a code and field details.
- **FR11** Links into the admin UI and terminal use `PORTAL_UI_URL` (default
  `http://localhost:3000`) and say "Opens on the portal machine"; only `/connect/*` links use
  `PORTAL_PUBLIC_URL`. Every `UI_ONLY`, `needs_restart`, `SCOPE_REQUIRED` and `truncated` result says
  in one line what to do there, so it's useful without the link.

### Safety and audit

- **FR12** Destructive tools are confirmed (§14.1), long operations return at once (§14.2), no secret
  goes in or out (§14.3), untrusted text is labeled (§14.4), and rate limits apply (§14.5).
- **FR13** **Relaxation guard.** Every write that can change effective settings (`settings_update`,
  `pool_update`, `pool_delete`, `pool_assign`, `pool_unassign`, `workspace_create`) is first resolved
  as a dry run for every affected workspace; a new workspace compares against Global. If any would
  relax a key Settings & policies FR1 flags, including by losing a stricter workspace override or a
  pool's policy requirement, or the change lowers a retention period, the call returns `UI_ONLY`
  naming the workspaces and keys, and changes nothing. Rules a pool adds for its own tools leave
  with those tools and don't count.
- **FR14** **Review gate.** `pool_create` and `pool_update` may reference approved skill versions and
  MCP catalog entries only; others are refused by name. A revision that still needs review
  ([Skillset](skillset-pool.md) A3) returns `status: waiting_review` and isn't delivered. Persona
  revisions saved over MCP stay drafts until published in the UI (§13.2).
- **FR15** Session write tools are listed only while "Allow session control over MCP" is on (off by
  default, §13.3).
- **FR16** Every workspace gets the portal connector deny entry whenever `PORTAL_PUBLIC_URL` is set,
  and shows whether it's Blocked, Pending or Not protected (§10.1).
- **FR17** Every authenticated request is audited; rejected ones are counted per IP and minute (§17).

## 9. Data model

Stored in the portal database ([Pools foundation](foundation-pools.md) §4). Tokens are stored as
SHA-256 hashes; a generated server code and a refresh retry pair use the foundation's encryption.
`owner` stays null until per-user identity. **Multi-user (PLAN-10):** `pmcp_tokens` gain `owner_id` (the creator, `u_owner` for existing tokens) and `token_epoch`, `pmcp_agent_tokens` gain `token_epoch`, and `pmcp_audit` gains `actor_user`; migration block 400-459, see [Authorization](authorization.md) §11.

| Table | Key fields |
| --- | --- |
| `portal_state` | sign_in_enabled, server_code (encrypted; only for a generated code), code_updated_at |
| `mcp_settings` | enabled, session_control (false), allow_dcr (false), cimd_hosts (default `["claude.ai"]`), extra_origins, confirm_above (5), audit_days (90), auth_event_days (365), audit_max_mb (512), auth_event_max_mb (64) |
| `mcp_pats` | id, label, token_hash, last4, scope, owner, created_at, expires_at, last_used_at, last_used_ip, revoked_at |
| `oauth_clients` | client_id, kind (`preregistered` \| `cimd` \| `dcr`), name, redirect_uris, metadata, fetched_at, blocked |
| `oauth_grants` | id, client_id, scope, resource, owner, consent_ip, created_at, expires_at (90 days), last_used_at, revoked_at, revoke_reason |
| `oauth_tokens` | token_hash, kind (`access` \| `refresh`), grant_id, scope, expires_at, used_at, replaced_by, retry_pair (encrypted, cleared 60 s after rotation), revoked_at |
| `mcp_confirmations` | token_hash, principal_id, tool, args_hash, target_ref (ID plus created_at or revision), preview_hash, preview, expires_at, used_at |
| `secret_links` | id_hash, purpose, target, principal_id, expires_at, used_at |
| `mcp_audit` | id, at, request_id, principal_kind (`pat` \| `oauth`), principal_id, client_id, client_info (unverified), era, ip, user_agent, method, tool, args (redacted, ≤ 2 KB), outcome, error_code, duration_ms, affected |
| `mcp_auth_events` | id, at, kind, principal_id, client_id, ip, count, first_at, last_at, details (redacted) |

Pending authorization requests (10 minutes) and codes (60 seconds) live in memory, so a restart
mid-sign-in means signing in again. Grants, refresh tokens, PATs and the sign-in switch survive
restarts. A daily job deletes expired rows and audit past retention; size caps prune oldest first.

**As built (v0.6).** The tables are `pmcp_settings` (enabled, session control, confirm-above, retention),
`pmcp_tokens` (admin tokens `cpat_`: SHA-256, scope, expiry, last used), `pmcp_agent_tokens` (per-session
tokens `cpst_`, §12.6: hash, workspace, session, expiry, revoke reason), `pmcp_agent_access` (the
per-workspace opt-in), `pmcp_audit` (the row above plus `actor`: `session:<id>` or `portal-mcp:<token id>`)
and `pmcp_auth_events`. Confirmations (`cfm_`, single use, 5 minutes) are in memory, hashed: a restart just
asks again. `oauth_*`, `secret_links` and `mcp_confirmations` do not exist. Migrations 40 to 45.

## 10. Delivery into Claude Code

### 10.1 Into workspaces: keep the admin tools out

Claude Code fetches claude.ai connectors only while signed in with a claude.ai subscription, never
while `apiKeyHelper` or an API key is active ([MCP docs](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claude-ai)).
Pool workspaces never load them; an own-login workspace ([Account Pool](account-pool.md) US8)
signed in with the account that holds the portal connector would give its agent the admin tools.

| Aspect | Requirement |
| --- | --- |
| File | `/etc/claude-code/managed-settings.d/00-claudepilot-base.json` (`root:root 0644`), in every workspace with or without pools, next to the marketplace registration ([Skillset](skillset-pool.md) A2). Owner: Foundation (A1, A2). |
| Content | `{"deniedMcpServers": [{"serverUrl": "*://cp.example.com:*/*"}, {"serverName": "claude.ai pilot"}]}`, built from `PORTAL_PUBLIC_URL`. A hostname written out in full matches only the default port, so scheme and port are wildcards. The name entry is a backup: display names can change and gain a ` (N)` suffix, so Connect asks the admin to name the connector `pilot`. |
| What it blocks | The connectors Claude Code fetches itself, by URL or by name. Nothing overrides a deny match, and deny lists merge from every scope ([managed MCP](https://code.claude.com/docs/en/managed-mcp)). From Claude Code 2.1.273 the entry applies from any admin source, so it holds when the user's claude.ai organization pushes server-managed settings ([managed settings](https://code.claude.com/docs/en/managed-settings#keys-read-from-every-admin-source)). |
| What it misses | Connectors the desktop app delivers in-process to its local and SSH sessions, and cloud sessions, whose proxy rewrites connector URLs. Workspaces run terminal and Agent SDK sessions, where it applies. Policy is checked when a server loads, reconnects or is turned back on; 🔬 whether a running session drops a loaded connector is Q8. |
| Not a boundary | Workspace users and agents have passwordless `sudo` and can delete the file (foundation §2). Reconcile restores it within 60 s, Monitoring raises "Settings tampering" (its §12), and only the locked image makes it binding ([Settings & policies](settings-policies.md) §14). The real control is the account: Connect requires confirming that the claude.ai account adding the connector is never used inside a workspace, for `/login` or for a Claude Desktop SSH session (§15). |
| Delivery | Whenever `PORTAL_PUBLIC_URL` is set, with MCP on or off; before a new workspace first starts; exempt from the rollout limit, like revocations (foundation §6.3, A2). A new URL changes every desired hash. |
| Status | Blocked, Pending, or Not protected with the reason: a Kubernetes workspace awaiting "Enable pools", a recorded `claude_version` (foundation §9) below 2.1.273, or a failed, Locked or Frozen delivery. Workspaces with a delivered account pool never show Not protected. Connect → claude.ai stays disabled while any workspace is Pending. An own-login workspace that gets the entry after the connector exists (a repaired delivery, a new URL) lists its earlier sessions under "Restart these sessions". |
| Detection | [Monitoring](monitoring-dashboard.md)'s MCP hooks (its FR16) see every tool name. A portal tool called through a claude.ai connector (`mcp__claude_ai_<name>__<portal tool>`, 🔬 Q15) raises a High security event, "Portal connector used in a workspace". |
| Plan B | If Q8 shows the entry doesn't hold, own-login workspaces get `disableClaudeAiConnectors: true`, which also applies from any admin source, with a per-workspace opt-out, since it drops the user's own connectors too. |
| Never delivered | An admin's or OAuth token: the compiler rejects any fragment containing `cpat_`, `cpoa_`, `cpor_` or `cpst_`. The MCP set catalog refuses URLs under `PORTAL_PUBLIC_URL` ([MCP set pool](mcpset-pool.md)). The one token that does enter a workspace is the per-session agent token `cpst_`, only in the environment of that session's Claude Code process, never in a file, a fragment or a pool (§12.6). |

### 10.2 Into the admin's own Claude Code

The portal never writes to the admin's machine. After creating a token, it shows two user-scope
setups. The second uses a [`headersHelper`](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication),
run at each connection and after a 401 or 403, reading a file the UI copies
(`{"Authorization": "Bearer cpat_…"}`, saved with mode 0600).

```
# Quick: the token goes into ~/.claude.json
claude mcp add --transport http --scope user pilot https://cp.example.com/mcp \
  --header "Authorization: Bearer cpat_…"
# Or: the token stays in ~/.config/pilot/mcp-headers.json
claude mcp add-json --scope user pilot \
  '{"type":"http","url":"https://cp.example.com/mcp","headersHelper":"cat ~/.config/pilot/mcp-headers.json"}'
```

`http://localhost:3000/mcp` works on the portal machine without a tunnel. OAuth works from Claude
Code through the public URL, with its client ID `https://claude.ai/oauth/claude-code-client-metadata`.

**When changes apply:** a revoked token fails on its next request. The stateless server sends no
`list_changed`, so Claude Code picks up tool changes (the session-control switch included) on `/mcp`
reconnect or in a new session; how claude.ai refreshes its tool list is 🔬 (Q6). claude.ai caches
OAuth discovery metadata for about 5 minutes.

## 11. Transport and reachability

### 11.1 Mounting

- `@modelcontextprotocol/server` 2.3.1 (implements 2026-07-28, brings zod 4): `createMcpHandler`
  with `legacy: 'stateless'` (so `initialize`-era clients work too) and `responseMode: 'auto'`,
  mounted as `app.all('/mcp', …)`. Not the v1 SDK or the frozen `server-legacy` package.
- Per request: Host gate → Origin check → per-IP limit → bearer auth → per-token limit →
  `handler.fetch(c.req.raw, { authInfo, parsedBody })` → audit. State across calls lives in
  handles (workspace IDs, cursors, confirm tokens), always checked against the caller.
- The public listener is a second Hono app with only the public routes. On the main listener, `/mcp`
  sits outside `/api` (whose `csrf()` rejects form POSTs) and before the `/api/*` 404 and the SPA
  fallback, and dev mode routes it to Hono, not Vite.
- Responses are JSON, upgraded to SSE only when a tool sends progress first (`X-Accel-Buffering:
  no`, keep-alive every 15 s). `GET` and `DELETE` return 405. `/mcp` never redirects (Claude drops
  `Authorization` on a cross-host redirect). Bodies are capped at 1 MB. Server `instructions` (at
  most 2,048 characters) describe the portal's domain and never contain workspace text.
- The esbuild script externalizes or bundles `@modelcontextprotocol/*`. 🔬 The SDK asks for
  TypeScript 6; the repo has 5.9 (Q11).

### 11.2 Listeners and public paths

| Listener | Address | Serves | Client IP from |
| --- | --- | --- | --- |
| Main | `PORTAL_HOST:PORTAL_PORT` (today `0.0.0.0:3000`) | Admin UI, `/api/*`, terminal, `/mcp` (PATs, loopback only), `/connect/*` | The socket. `CF-*` and `X-Forwarded-*` are ignored. |
| Public | `127.0.0.1:PORTAL_PUBLIC_PORT` (default 3001), never forwarded | Only the paths below | `CF-Connecting-IP` |

| Path (public listener) | Purpose |
| --- | --- |
| `/mcp` | MCP endpoint, for PATs and OAuth tokens |
| `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource` | RFC 9728 metadata |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata. Other `/.well-known/*` paths get a JSON 404. |
| `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/register` (DCR only) | Authorization server |
| `/connect/*`, with assets under `/connect/assets/` | Consent and secret-entry pages |

- **Only the tunnel reaches the public listener.** cloudflared runs next to the portal (in the
  devcontainer, or as a sidecar in its pod; Q1). The devcontainer sets `onAutoForward: ignore` for
  that port: a VS Code forward would let Docker workspaces reach it through `host.docker.internal`
  and forge `CF-Connecting-IP`. The tunnel guide forbids `httpHostHeader` rewriting.
- **Host and Origin:** the public listener accepts only the public hostname; the main listener
  accepts loopback names and `PORTAL_ALLOWED_HOSTS`, never the public hostname, so a misrouted tunnel
  can't reach the UI. A present `Origin` must be the portal's own, a loopback origin,
  `https://claude.ai` or in `extra_origins`, else 403. 🔬 Record claude.ai's real `Origin` before
  tightening (Q6); Anthropic warns that strict checks reject its requests.
- **`PORTAL_PUBLIC_URL`** builds the issuer, `resource`, metadata URLs and `/connect/*` links, since
  `c.req.url` starts with `http://` behind the tunnel. The main listener's 401 carries no
  `resource_metadata`, so local Claude Code reports a missing PAT instead of starting OAuth.

### 11.3 Reachability

- Claude's connectors call from Anthropic's cloud (`160.79.104.0/21`) over IPv4, and reject
  hostnames that resolve to private, CGNAT or loopback addresses
  ([troubleshooting](https://claude.com/docs/connectors/building/troubleshooting),
  [IP addresses](https://platform.claude.com/docs/en/api/ip-addresses)).
- **Recommended:** an operator-run, named Cloudflare Tunnel (for example `claudepilot.isnan.me`),
  the setup `desktop-mcp.isnan.me` appears to use (Cloudflare addresses, no Ingress). 🔬 Its ingress
  also publishes only §11.2's paths, with a catch-all `http_status:404` (Q12). HSTS on; the tunnel
  token stays out of the repo. Optional: Cloudflare Access on `/oauth/authorize` and `/connect/*` (Q3).
- **Bot Fight Mode can't be skipped with WAF rules**
  ([Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)). Choose one
  (Q12): an IP Access rule (Allow) for `160.79.104.0/21`, which also bypasses custom, rate-limiting
  and managed WAF rules for that range, shared by every claude.ai user, on the whole zone; Bot Fight
  Mode off for the zone; or Super Bot Fight Mode with a Skip rule. A WAF custom rule skips managed
  rules on the public paths only.
- Cloudflare cuts responses at 100 s (error 524). Anthropic's own MCP tunnels are Enterprise-only.
  Local Claude Code needs no tunnel, and nothing needs the cluster to reach the portal.

## 12. Authentication and scopes

### 12.1 Personal access tokens

A PAT is `cpat_` plus 43 base64url characters (256 random bits), stored as SHA-256 and shown as
`cpat_…3f9a`. It's accepted only as `Authorization: Bearer`, never in a query string, on the public
listener and on the main listener's loopback `/mcp`. It expires after 15 minutes, 1 hour, 1 day, 7, 30,
90 (default) or 365 days (§12.1b) and is shown once. PATs serve Claude Code, scripts and MCP Inspector. Claude Desktop can send a
static token only through the unsupported community `mcp-remote` bridge, so it uses OAuth.

### 12.1b Short lifetimes, one label one client, the cap and bulk revoke (T-258, built)

Found 2026-10-13: a coordinator's helper minted a new 7-day admin token on every message, and 13 live `coordinator` admin tokens piled up.
As built:

- **Lifetimes.** `POST /api/portal-mcp/tokens` takes `expiresIn`: `15m`, `1h`, `1d`, `7d`, `30d`, `90d` or `365d`
  (`PORTAL_TOKEN_LIFETIMES`); the older `expiresInDays` (7, 30, 90, 365) still works; both at once, or any other value, is `422`. Neither
  is 90 days. Expiry is checked on every request where it already was (`PortalTokens.verify`): a 15-minute token answers 401 from its
  fifteenth minute (tested on a fake clock). The picker offers all seven; its ⓘ says automation should mint one token per run, valid
  1 hour, and revoke it at the end. A token's time left reads in minutes, hours or days.
- **One label, one client.** Minting with a label that has live tokens (any scope; exact label after trimming) is refused:
  `409 TOKEN_LABEL_IN_USE` with `details: { label, live, newest: { id, expiresAt } }`, never a secret or its last four. The request
  says what to do instead: `replace: true` revokes every live token with the label (one `token_revoked` audit row each, `by` the caller,
  `replacedBy` the new id) and mints the new one; `addAnother: true` keeps them. Both at once is `422`. The New token dialog shows
  "N live with this label" with Replace and Add another.
- **The cap.** With `addAnother`, an admin-scope token is refused once the label has as many live admin tokens as the setting
  `mcp.tokens.maxActivePerLabel` (Settings → MCP, "Admin tokens per label", default 3, 1 to 20, read on every mint):
  `409 TOKEN_CAP` with the same details plus `max`. Read and operate tokens are not capped; `replace` always fits.
- **Agents' per-session tokens (`cpst_`, §12.6) are exempt** from the label rule and the cap: they are another table, have no label, and
  are minted per session by `AgentAccess.mint`, one live per session already.
- **Bulk revoke.** `POST /api/portal-mcp/tokens/revoke-label` `{ label, keepNewest? }` revokes the label's live tokens, or all but the newest
  ("Revoke older"), and answers `{ revoked }`; one `token_revoked` audit row per token, each with `by` (`user:<id>`). A single revoke and a
  mint now carry `by` too (the mint also its `expiresAt`).
- **Access → MCP, Tokens:** grouped by label. A label with one token is its row as before; a label with more shows the live count, its scopes,
  the newest expiry and the last use of any, opens to the tokens (each with Revoke), and its Menu has "Revoke older (N)" and "Revoke all
  (N)", each behind a ConfirmDialog that names how many.
- **Authorization:** the token routes ask the seam for `manage` on the person's tokens (`personal`, `pmcp_token:*` or `pmcp_token:<id>`) and
  are declared in `portalmcp/authz.ts` (with the rest of `/api/portal-mcp`): a read or operate token is below it, an agent's token is boxed
  out, nobody signed in is 401. No migration: the rules read `pmcp_tokens` as it is.
- **The repository's own helpers** (`tools/coordinator/portal.mjs`, `docs/dev-sessions/supervisor.mjs`) hold one token per run through
  `tools/coordinator/tokenLease.mjs`: admin scope, `expiresIn: 1h`, `replace: true` (so a crashed run's leftover is revoked, never a 409),
  reused while more than 5 minutes are left, renewed with `replace` after that, revoked at the end of the run (also when the call fails,
  and on SIGINT or SIGTERM). The secret stays in the process's memory; an error names the code, never the token. Before this,
  `portal.mjs` revoked `tokens/undefined` (the mint answer is `{token, secret}`), so each call's 7-day token stayed live until the next call.
  Tested against the real routes and endpoint in `portalmcp/tokenLease.test.ts`, including the twin that an expired, a revoked and an
  unknown token get the same 401.

### 12.1a The client's name: every token has a label (T-6, built)

A token's **label** is typed by the owner when the token is made (Access → MCP): required, trimmed, 1 to 60 characters, one line of plain
text (no line breaks, control characters, quotes or angle brackets). The API refuses a token without one with a message that says what the
label is for. The label is **the name of that client wherever it acts**, so nothing is "an anonymous MCP client":

- Tools get it as `ctx.actorLabel` next to `ctx.actor` (`portal-mcp:<token id>`); every tool that sends or starts something passes it on:
  a chat message and the first message of a started session (the transcript reads "From MCP client “relay”", and so does the frame Claude
  reads), a CI run (run page: "started by MCP client “relay”"), a repository worktree (repository timeline), a ticket (timeline names the token, also when
  it acts for a session).
- The label is stored **with** what it did, as it was then: the chat event (`actorLabel`), the ticket event and reporter, `ci_runs.actor_label`,
  `repo_events.actor_label` (migration 711), the Portal MCP audit row (`token_label`), the chat audit and the platform audit (`actorLabel` in
  the row's detail). A later change or revoke of the token changes none of them. Labels are redacted like any actor label.
- A per-session agent token (`cpst_`) has no label: it is shown as its session, as before.
- **When MCP clients register through OAuth (§12.2: client registration or a dynamic client name) or an API-key integration, the client name
  or the key's label must fill this same label field** (same limits, same cleaning; a name that does not fit is shortened, never blank).
  **Not built now:** OAuth and keys are MCP4 and later; the field is the seam.

### 12.2 OAuth for the Claude apps

claude.ai, Desktop, mobile and Cowork share one connector system
([authentication](https://claude.com/docs/connectors/building/authentication)). Its static "Request
headers" option is a beta for some organizations, so the portal runs its own authorization server;
the SDK only verifies tokens (`requireBearerAuth`).

- **Issuer** is the origin of `PORTAL_PUBLIC_URL`; grants are `authorization_code` and
  `refresh_token`, for public clients only. **Access tokens** (`cpoa_`) are opaque, last 60
  minutes, are bound to the grant and to `<PORTAL_PUBLIC_URL>/mcp`, and work only on the public
  listener.
- **Refresh tokens** (`cpor_`) rotate on every use. One presented again within 60 s of its rotation,
  while its successor is unused, returns the same successor pair, kept encrypted for those 60 s.
  Reuse after the successor was used, or after 60 s, revokes the grant and logs a security event.
  They expire after 30 days unused or 90 days after consent; Access → MCP warns 7 days before.
- **Clients:** pre-registered `claude-ai` (redirect `https://claude.ai/api/mcp/auth_callback`), which
  Connect tells the admin to enter, so connecting doesn't depend on the unpublished CIMD URL (Q6),
  and `claude-code` (loopback `/callback` on `localhost` or `127.0.0.1`, any port). CIMD from
  `cimd_hosts` (default `claude.ai`) serves admins who pick "Use Claude's published identity":
  HTTPS from public addresses (5 s, 64 KB, cached 24 h), `client_id` equal to its URL, exact
  redirect URIs. Dynamic Client Registration is off by default (deprecated in 2026-07-28).
- **Consent page:** asks for the server code itself, because the `SameSite=Strict` cookie isn't
  sent on the navigation from claude.ai, and shows the redirect host. Loopback-only clients such as
  `claude-code` get "Continue only if you started this sign-in from Claude Code on this computer", as
  the MCP spec recommends. Unknown clients or redirect URIs get an error page naming the rejected
  `client_id` host and the Connect instruction, never a redirect.

### 12.3 What the Claude apps require

| Requirement (connector docs, MCP spec) | Portal |
| --- | --- |
| A 401 starts sign-in; `WWW-Authenticate` on a 200 is ignored | 401 with `WWW-Authenticate: Bearer resource_metadata="<public>/.well-known/oauth-protected-resource/mcp", scope="pilot:read pilot:operate"` |
| RFC 9728 metadata whose `resource` equals the URL the user entered; only the first `authorization_servers` entry is used | `resource: "<PORTAL_PUBLIC_URL>/mcp"`, one server. The UI shows the exact URL to paste. |
| RFC 8414 metadata; PKCE `S256`; RFC 8707 `resource` on authorize and token requests | `code_challenge_methods_supported: ["S256"]`; a different `resource` is `invalid_target` |
| CIMD only with `client_id_metadata_document_supported: true` and `"none"` in `token_endpoint_auth_methods_supported`, else DCR | Both advertised |
| `/token` is form-encoded and answers within 10 s (30 s for refresh); refresh tokens rotate; a dead one returns `invalid_grant` | Under 1 s, `Cache-Control: no-store`, rotation with reuse detection |
| `iss` in the authorization response (RFC 9207), advertised as `authorization_response_iss_parameter_supported: true`; Claude Code v2 rejects an unexpected issuer | Both |
| Scopes from the 401, else the protected resource metadata's `scopes_supported`; `offline_access` added if the authorization server lists it | Protected resource metadata lists `pilot:read pilot:operate`; authorization server metadata lists all three, without `offline_access`. Refresh tokens are issued anyway. |
| Refresh on a 401 and up to 5 minutes before expiry; discovery cached about 5 minutes; public IPv4; no redirects | 60-minute access tokens; §11 |

### 12.4 Scopes

| Scope | Allows | Granted |
| --- | --- | --- |
| `pilot:read` | Every read tool, resource and prompt | Always |
| `pilot:operate` | Read, plus starting, stopping and resyncing workspaces, checking accounts, interrupting and ending chat sessions, answering an agent's question or denying its request, and `mcp_lockdown` | claude.ai's first consent; PATs by choice |
| `pilot:admin` | Operate, plus creating and deleting workspaces, managing pools, account pools and accounts, changing settings, secret links, and session control (start, send, configure, allow a request) | OAuth by step-up only; PATs by choice |

- The server applies the hierarchy itself, and no scope reaches §6's right-hand column. It never
  accepts or forwards tokens it didn't issue.
- **Step-up:** a call that needs more scope (a tool, or `decision: allow` in `session_respond`)
  answers HTTP 403 `insufficient_scope`, naming every required scope in one challenge
  ([lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication)), and
  Claude asks the user to authorize again. PATs get `SCOPE_REQUIRED` instead (FR10), so Claude Code
  doesn't start an OAuth flow. 🔬 Claude Code's step-up support is undocumented (Q7).

### 12.5 One shared server code: what it means

> **Superseded by multi-user (PLAN-10, 2026-10-12).** There is no shared server code once accounts land ([Identity and onboarding](identity-onboarding.md)): a token is bound to the person who made it (`owner_id`), carries no more than that person holds **when it is used** (its scope is a cap on the owner's rights, [Authorization](authorization.md) FR12), and dies with the owner (a `token_epoch` bumped by a disable, a reset or a password change that asks for it). Audit names the person (`actor_user`) as well as the token; the token list, `audit_search` and `GET /api/portal-mcp/audit` show a person their own tokens and rows, admins revoke others' tokens through the emergency route. The consent page of the OAuth flow (§12.2) is an ordinary signed-in page of the approving person, not a code on a public page. The bullets below describe the single-owner portal that exists until the multi-user retrofit lands.

- Enabling MCP needs a stable server code: `PORTAL_SERVER_CODE`, or the generated code stored
  encrypted in `portal_state` instead of regenerated at each start. The sign-in switch is persisted
  too, so a restart never reopens a consent page an admin closed, and never revokes tokens.
- Anyone with the code can create a PAT or approve a connection, and every token acts as "the
  admin". Audit names a token (label and ID), a client, an IP and a user agent, never a person. When
  someone who knew the code leaves, the safe step is to rotate it and revoke everything (FR6).
  Turning sign-in off only blocks new consents. Per-user identity, later, fills `owner`.
- The consent page puts the 8-character code (about 40 bits) on a public page. Rate limits make
  guessing impractical (§14.5), and Cloudflare Access is the recommended second factor (Q3).

### 12.6 Agent tokens (`cpst_`): the portal's tools for agents inside a workspace

> **Multi-user (PLAN-10).** An agent token's user is its session's OWNER, read at each call (`chat_sessions.owner_id`), so it holds at most `operate`, only on its own session tree and workspace, never on platform, user, team, target or personal objects, and stops with the session, the owner's right to operate the workspace, or the owner ([Authorization](authorization.md) FR13). Every tool declares the objects it touches (`declareToolPolicies`; Appendix B of that PRD lists the 87 tools) and the registry refuses to start with one that does not. The per-workspace opt-in ("Agent access to portal tools") is a `manage` right on the workspace.

The owner asked for "internal mcp access". §10.1's rule that no portal token enters a workspace stays true
for every admin class; this is a new class with its own limits (decision 2026-10-12, interface I8). It is
also the one exception to the ground rule "workspaces never call back to the portal": the delivery engine
still only pushes, and the agent pulls tickets and posts proposals.

| Aspect | Requirement |
| --- | --- |
| Token | `cpst_` plus 43 base64url characters, SHA-256 at rest in `pmcp_agent_tokens`, minted when a chat session starts (`AgentAccess.mint({workspaceId, sessionId})`), bound to that workspace and session. One live token per session: a new mint (a Claude switch) revokes the old one. It expires after 7 days, a ceiling for a session that outlives it. |
| Delivery | Only in the environment of that session's Claude Code process: `PILOT_MCP_TOKEN`, `PILOT_SESSION_ID`, `PILOT_WORKSPACE_ID`, `PILOT_MCP_URL`; and `--mcp-config` with a JSON that names `${PILOT_MCP_URL}` and `${PILOT_MCP_TOKEN}` and holds no secret. Never a file. Checked with Claude Code 2.1.296 inside a Docker workspace: the expansion works in the url and the Authorization header, and the token is not blanked. |
| Opt-in | Per workspace, off by default (Access → MCP → Agents). Off: `mint` returns null and the session starts without portal tools. Turning it off revokes the workspace's live tokens. |
| Identity | The workspace and session of every call come from the token, never from arguments or headers: a tool sees `ctx.workspaceId`, `ctx.sessionId` and `ctx.actor` (`session:<id>`). Liveness is checked on every call: a session that ended, was archived or deleted, or moved to another Claude has no valid token (the portal revokes on those events and the check catches the rest). The client sees 401. |
| Scope `agent` | A tool opts in with `scope: 'agent'` (older code: `audience: 'both'`). An agent sees and can call only those; they can never be destructive (refused when registered), never approve, publish or deliver anything (they propose), and act only in their own workspace and session. An admin's token reaches them too, at `read` for a read-only tool and `operate` otherwise. |
| Limits | Per token: 60 reads and 20 writes a minute; proposal tools add `rate: { perHour }` and a size cap (`mcp_propose_entry`: 10 an hour, 16 KB); arguments over 32 KB are refused; a secret-shaped value in an argument is refused; every call is audited with its actor. |
| URL | The address of the portal as the workspace reaches it: `PORTAL_INTERNAL_URL` when set (always for Kubernetes); otherwise from the workspace's default gateway (Docker) or 127.0.0.1 (the portal's own machine). The portal listens beyond loopback for this (`PORTAL_HOST`). |
| Tests | The authorization matrix: a token after its session ended, of another workspace or session, on an operate or admin tool, on the admin endpoint, and arguments that claim another identity; and the agent surface of the real tool set (`portalmcp.test.ts`, `agentScope.test.ts`, `tools.test.ts`). |

Checked end to end with the chat launch (mint at every launch, resume, wake and move; the environment on the process's stdin; `--mcp-config` from the grant): a session started from a ticket reached the ticket tools with its own token (Tickets §14, T2). Two results. In Manual mode the first call of each portal tool asks for an approval; the tools are scoped, rate limited and never destructive, so allowing `mcp__pilot__*` for a session that has a grant is an option for the chat launch (open). And with `mcp.poolOnly` on, the allowlist delivered into the workspace names exactly the URL the session uses (`agentMatchers`), and a new session still connected.

## 13. Tool catalog

Hints: **R** readOnly, **D** destructive, **I** idempotent, **O** openWorld. A missing letter means
`false`; every tool sets all four, because the spec defaults (`destructiveHint` and `openWorldHint`
true) make reads look dangerous. **U** adds `_meta["anthropic/requiresUserInteraction"]: true`, so
Claude Code asks on every call, even in bypassPermissions mode
([docs](https://code.claude.com/docs/en/mcp#require-approval-for-a-specific-tool)); every admin
tool marked D has it. **C** is server confirmation (§14.1); **C\*** applies only when a change
reaches more than 5 workspaces. Names are snake_case `<noun>_<verb>` without dots
(`mcp__pilot__<name>` in Claude Code). Items are accepted by ID or by exact name within a
type; an ambiguous name returns `AMBIGUOUS` with the matches, and destructive tools show the resolved
ID in the preview and confirm by it.

### 13.1 Portal, workspaces, settings and monitoring

| Tool | Scope | Hints | Inputs | Output |
| --- | --- | --- | --- | --- |
| `portal_status` | read | R I | none | Version, targets and availability, workspace counts, delivery problems, workspaces not protected, Locked, `you` (token, scope, expiry, session control on or off) |
| `workspace_list` | read | R I | `target`, `status`, `query`, `cursor`, `limit` | id (`target/name`), status, detail, limits, pools per type, delivery and portal-connector status |
| `workspace_get` | read | R I | `id`, `include[]` (`usage`, `configuration`, `files`, `sessions`), `wait_seconds` (0–25) | Workspace, CPU and memory, pools and delivery status, compiled files (secrets redacted), sessions, UI and terminal links |
| `workspace_create` | admin | – | `name`, `target`, `cpus`, `memory_mb`, `pools` (`account`, `policy`, `persona`, `browser`, `skillsets[]`, `mcp_sets[]`, `secrets[]`) | `{id, status: "creating"}` at once. A repeat with identical arguments from the same principal within 10 minutes returns the existing `{id, status}`; other name collisions get `CONFLICT`. |
| `workspace_start` | operate | I | `id` | New status |
| `workspace_stop` | operate | D I | `id` | New status, sessions stopped |
| `workspace_sync` | operate | I | `id` | Reconcile result, or `needs_restart` and how to restart |
| `workspace_delete` | admin | D I U C | `id`, `confirm_token` | Preview (home volume, sessions, assignments), then done |
| `settings_get` | read | R I | `scope` (`global`, `workspace`, `account_pool`, `account`, `target`), `scope_id` | Effective values, where each comes from, which are UI-only |
| `settings_update` | admin | D I U C\* | `scope`, `scope_id`, `changes` (key → value), `confirm_token` | New values, workspaces affected; `UI_ONLY` for relaxing changes (FR13) |
| `monitor_overview` | read | R I | `window` (`1h`, `24h`, `7d`), `workspace_id` | Workspaces by status, top 10 by CPU and memory, agents by state, tokens and estimated cost, failovers, delivery failures, security events, MCP calls; each with its source and time |
| `event_search` | read | R I | `kinds[]`, `workspace_id`, `pool_id`, `actor`, `since`, `until`, `cursor`, `limit` | Shared event log entries with actors |
| `audit_search` | read | R I | `tool`, `principal_id`, `outcome`, `since`, `until`, `cursor`, `limit` | MCP calls and auth events, arguments redacted, no IP addresses |
| `mcp_lockdown` | operate | D I U C | `confirm_token` | Preview (every PAT and connection, the caller's included), then MCP turns off and all are revoked. Only the UI turns it back on. |

### 13.2 Pools, accounts and secrets

Six pool types share the foundation's shape: skillset, persona, browser & desktop, MCP set, secrets &
env, and `policy` ([Settings & policies](settings-policies.md) FR2). One set of tools covers them,
validated by each type's own schema. Account pools extend the foundation's tables with
[Account Pool](account-pool.md)'s own model (ordered members, strategy, caps, no revisions; its §9),
so they get their own tools.

| Tool | Scope | Hints | Inputs | Output |
| --- | --- | --- | --- | --- |
| `pool_types` | read | R I | none | Per type: description, one or many per workspace, content JSON Schema, secret fields |
| `pool_list` | read | R I | `type`, `query`, `cursor`, `limit` | Name, type, revision, review status, used by N |
| `pool_get` | read | R I | `id`, `revision` | Content with secrets masked, last 10 revisions, workspaces |
| `pool_create` | admin | – | `type`, `name`, `description`, `content` (approved versions only, no secret values) | id, revision, status, `secrets_missing[]` |
| `pool_update` | admin | D U C\* | `id`, `base_revision`, `content` or `restore_revision`, `note` | New revision, status (`deliverable`, `waiting_review` or `draft`), rollout plan. A stale `base_revision` gets `CONFLICT`. |
| `pool_delete` | admin | D I U C | `id`, `unassign`, `confirm_token` | Preview, then done. Refused while in use unless `unassign`. |
| `pool_assign` | admin | D I U C\* | `pool_id`, `workspace_ids[]` (up to 50), `pinned_revision` | Per workspace: result, pool replaced, delivery status |
| `pool_unassign` | admin | D I U C\* | `pool_id`, `workspace_ids[]` | Per workspace result |
| `account_pool_list` | read | R I | `query`, `cursor`, `limit` | Name, endpoint, strategy, members in order with state, cap, workspaces, health counts |
| `account_pool_update` | admin | D I U C\* | `id`, `members[]` (account IDs in order), `strategy`, `workspace_cap`, `probe_models`, `hide_login` | The pool, workspaces that move |
| `account_pool_assign` | admin | D I U C | `pool_id` (null for own login), `workspace_ids[]` (up to 50), `confirm_token` | Preview with Account Pool FR9's warnings (the key outranks any sign-in, billing moves to the pool, some features stop), then per workspace: result, previous pool, delivery status. Unassigning follows Account Pool §10.4. |
| `account_list` | read | R I | `pool_id`, `state`, `endpoint_id`, `cursor`, `limit` | Masked key (`sk-ant-…a1b2`), endpoint, state, cooldown, headroom "as of", reset, workspaces; endpoints |
| `account_check` | operate | I O | `id` | Check result ([Account Pool](account-pool.md) §11.2) |
| `account_update` | admin | D I U C\* | `id`, `name`, `notes`, `enabled`, `clear_cooldown` | The account; workspaces moved off it if disabled |
| `account_delete` | admin | D I U C | `id`, `confirm_token` | Preview (workspaces that will move), then done |
| `secret_link_create` | admin | – | `purpose`: `new_account` (`endpoint_id`, `name`), `account_key` (`account_id`) or `pool_secret` (`pool_id`, `field`) | `{url, expires_at}` (§14.3) |

Personas follow [Persona pool](persona-pool.md) §14: `pool_create` and `pool_update` save a draft and
return `{revision, status: "draft", publish_url}`, `restore_revision` accepts only revisions published
before and always needs C, and `pool_delete` archives. Until those rules ship, `pool_types` doesn't
list the persona type.

### 13.3 Chat sessions, resources and prompts

Built on [Chat sessions](chat-sessions.md), whose A10 adopts these tools: states follow its FR3, MCP
text carries no human origin (its FR14), slash commands pass its FR13 allowlist, and `session_start`
runs its credential guard, so own-login workspaces get no sessions. [Settings & policies](settings-policies.md)
caps models, effort and modes; over MCP, `mode` is limited to `plan`, `default`, `acceptEdits` and
`dontAsk`. The write tools direct an agent that runs commands, so they're listed only while "Allow
session control over MCP" is on (off by default); otherwise only `session_list`, `session_get`,
`session_interrupt` and `session_end` exist.

A session's own tools for a crew (agent scope, [Chat sessions](chat-sessions.md) FR51, "Crew over MCP"):
`session_spawn` takes `claude` (`same`, a plan Claude's name, or `auto`: room by a fresh, measured reading, the least
busy first; with none, T-427, another Claude, the least used now of those with more than 10 % left (the auto move's default
threshold), none above ceil((sessions + 1) / Claudes) + 1 sessions not ended (asleep ones count: a message wakes them), why
`no_room_lowest`; its own only when no other qualifies), `role` (the worker runs as `.claude/agents/<role>.md`), `model` (default: the
role's model in the workspace persona, T-490), `why` (T-490, D-63: required on a role whose model is below opus for any model but a sonnet or haiku alias or id (`sonnet`, `claude-haiku-*`, `[1m]` suffix allowed; so opus, fable, `default`, `opusplan`, `best` and an unknown id need it), else
`VALIDATION_FAILED` naming D-63; kept as the worker's `spawnWhy`; the result says `model` and `why`), `effort`, `mode` (`default`, `plan`,
`dontAsk`), `ticket` (`T-<n>`: the worker's ticket, the field usage attribution reads, so its cost counts under that ticket;
none means "No ticket"; a malformed id or a ticket that does not exist is refused as `NOT_FOUND` and starts nothing, T-449;
T-397: while nobody holds that ticket the worker may `ticket_comment` on it, and on its lead's tickets, comment only, audited as the worker:
[Tickets](tickets.md) FR9b),
`max_workers` and `subagents` (the worker's own limits, never wider than the caller's) and `report`
(`idle`, the default: the portal tells the lead in one line when the worker's turn
ends, when it waits on a person and when it ends; `end`: only the end; `none`), `session_message` takes `to`
(`workers` or `crew`) instead of `session_id`, every recipient counted against the hourly limit, and
`session_family` items carry `agent` and `mode`, with how many wait on a person in its summary.

CI for a crew (T-476, [Local git & CI](local-git-ci.md) FR39): `ci_run_trigger` from an agent token lets a lead (a session with no
parent that has started workers) start any pipeline on a `dev/*` or `ticket/*` branch of its program's remote (the remote whose
folder is exactly the lead's folder), matched exactly (no `refs/`, `..`, tag or lookalike prefix; resolved as `refs/heads/<branch>`).
On another program's remote that refusal is the same `NOT_FOUND` as a remote that does not exist. A worker started in a folder that
is a git work tree on a branch owns that branch (recorded once at its start). Deploy pipelines keep the earlier rule and still wait
for a person's approval. Every start writes one `ci.run_started` audit row: actor, session, remote, pipeline, ref and the rule that
allowed it (`own_branch`, `program_branch`, `deployment`, `token`). The rule lives in `ci/authz.ts` (`agentStart`). Reading:
`ci_run_get`, `ci_runs_list` and `ci_run_logs` show a lead every run on its program's remotes, whoever started it (read only; cancel
and bump stay own-only), and a worker's folder branch counts as its own only on that folder's remote as `dev/*` or `ticket/*`; any
other run reads as `No such run.`

| Tool | Scope | Hints | Inputs | Output |
| --- | --- | --- | --- | --- |
| `session_list` | read | R I | `workspace_id`, `state`, `ticket_id`, `parent_id` (T-294: the workers of one session), `include_ended`, `cursor`, `limit` | State (Starting, Working, Needs input, Failed, Idle, Interrupted, Ended), waiting for, model, effort, mode, last activity, estimated cost; T-294: `parent_id`, `agent` and the Claude's name |
| `session_get` | read | R I | `id`, `after_seq`, `max_events` (up to 100), `wait_seconds` (0–25) | State, pending requests, events, `next_seq`; T-294: `parent_id`, `agent`, and its workers, compact (id, title, state, Claude, waiting; at most 20, live ones first) with `workers_total` |
| `session_interrupt` | operate | I | `id` | State; the turn stops and work already done is kept |
| `session_end` | operate | D I | `id` | Final state |
| `session_respond` | operate; `allow` needs admin | D U; C for `allow` | `id`, `request_id`, `answer` or `decision` (`allow`, `deny`), plan `mode`, `message`, `confirm_token` | Accepted; the first answer per `request_id` wins. `allow` covers a tool, a plan, a workflow or an MCP elicitation, and its preview shows the exact request, sanitized. |
| `session_start` | admin | D O U | `workspace_id`, `folder` (default `~/work`), `prompt`, `model`, `effort`, `mode`, `agent` (T-294: the agent it runs as, `claude --agent <name>`), `parent` and `report` (T-336: it starts as the worker of a live session of the same workspace, through the same create as `session_spawn`, so the parent's limits hold (depth, workers at once, an hour's starts) and it shows in the parent's `session_family` and crew; `report` as for `session_spawn`, only with `parent`; a parent that is missing, ended, in another workspace or one the token may not operate is the same not found; T-349: the parent is asked again inside the controller's create, after its last await and right before the row is written, so a parent that ends meanwhile gets no worker and the same not found; a worker's first `prompt` is framed as from its parent session, as `session_spawn` frames it, while `started_by` stays the token). T-349: `workspace_id` takes any form `workspace_get` takes (the `ws_` id, `<target>/<name>`, `<target>/<label>`, a name or label only one workspace has), through the shared resolver, and the resolved workspace is asked of the seam again | Session id and state, `parent_id` |
| `session_send` | admin | D O U | `id`, `text`, `priority` (`next` steers this turn, `later` waits for it to end) | Accepted, message state |
| `session_configure` | admin | D U; C when raising the mode | `id`, `model`, `effort`, `mode`, `max_workers`, `subagents` | Values after policy caps. Modes rank `plan`, then `default` or `dontAsk`, then `acceptEdits` ([Monitoring](monitoring-dashboard.md) §12). T-294, the session's limits ([Chat sessions](chat-sessions.md) FR51, "Limits per session"): `max_workers` (0 to 20, or null for the global `sessions.maxChildren`; above the global cap counts as the cap) applies at once; `subagents` (on or off: off launches its process with `--disallowedTools Agent Task Workflow RemoteTrigger` (a forked skill can still run a sub-agent: the known gap)) applies at its next start, and the result's `restart_needed` says when a Restart is due. Audited `session.limits`. An agent's token never reaches it (admin scope), so a session never changes its own limits. |
| `crew_scorecard` | agent (reach session: its own program); an admin's token reads every program | R I | `program` (a program id: its first lead session), `window` (`1h`, `6h`, `day` default, `week`), `compare` (default true: the window before too), `full` | T-450, [Claude usage](claude-usage.md) §28.14: per program (a lead chain with its continuations and every worker under it) tickets done by type and per hour, lead time p50 and p90, reopened, wont_do, the review backlog (age, what it waits for), CI runs by pipeline, deploys; cost (estimated dollars) total, lead versus workers, per done ticket all-in and workers only (per type from usage spend's `ticketReport`, T-449, over the tickets' life); efficiency: token-class shares, requests, context p50 and p90 per role and per lead, top sessions, model mix, sessions per role, live per Claude, hand-overs, spikes; health: refusals by scope, bad endings (pod memory unavailable); the D-61, D-62 and D-63 targets as `ok`, `warn`, `breach` or `unavailable` with offenders. Short by default (headline figures now and before, target states, flags); `full` gives every figure with its basis (`measured`, `estimate`, `unavailable` with a reason), the sources named once in `basis`. Another program, or one that does not exist, is `NOT_FOUND`. Declared in `lab/authz.ts`; the same as `GET /api/lab/scorecard`. |

Resources (read scope, no subscriptions): `pilot://status`,
`pilot://workspaces/{target}/{name}` and `pilot://pools/{id}`, attached with `@` in
Claude Code. Prompts: `fleet_status`, and `workspace_triage` with a `workspace_id`, shown in Claude
Code as `/pilot:fleet_status`.

### 13.4 Not over MCP in v1

| Action | Why |
| --- | --- |
| Everything in §6's right column; changing MCP settings, session control included; "Prune now" | Security posture, or hides tracks. `mcp_lockdown` is the one exception, and it only removes access. |
| Importing, approving, rejecting or revoking skill versions and MCP catalog entries; "Update to v…" from a source | A person reviews code in the UI ([Skillset](skillset-pool.md) §11 and §14, [MCP set](mcpset-pool.md) FR3) |
| Publishing a persona draft; persona test runs | Persona text reaches every later session's context, and a model can complete a confirmation alone ([Persona pool](persona-pool.md) §14) |
| Endpoints, custom hosts, organization monitors | They hold secrets and URLs the portal calls |
| Creating and deleting account pools; pinning a workspace to an account (Account Pool FR19) | Later |
| CPU and memory of an existing workspace; "Switch image" | Later; in-place resize is unverified (Settings & policies Q12) |
| "Enable pools" (foundation §6.6), "Update Claude Code" (foundation §9) | Later; both can restart sessions, so they'd come as operate with D and C |
| Pausing and resuming workspaces (Settings & policies §13.2) | Later; resume lifts a spend stop and stays UI-only |
| Settings' first-run Apply (Settings & policies FR5); "Resume delivery" and "Adopt workspace" (foundation §6.5) | A person reviews what changes in the UI first |
| Images and files, ultracode, and resuming, renaming, archiving or deleting chat sessions ([Chat sessions](chat-sessions.md) FR4) | Later |
| Opening a terminal | No shell over MCP; results link to the terminal |

### 13.5 As built (v0.6)

**35 tools**, 4 resources and 2 prompts (tickets add 8 tools: [Tickets](tickets.md) §12): portal 3 (`portal_status`, `audit_search`,
`mcp_lockdown`), workspaces 7 (`workspace_list`, `_get`, `_create`, `_start`, `_stop`, `_sync`, `_delete`),
sessions 8 (`session_list`, `_get`, `_interrupt`, `_end`, and behind the switch `_start`, `_send`, `_respond`,
`_configure`), pools 8 (`pool_types`, `_list`, `_get`, `_create`, `_update`, `_delete`, `_assign`,
`_unassign`), accounts 4 (`account_pool_list`, `account_list`, `account_check`, `account_pool_assign`),
monitoring 2 (`monitor_overview`, `usage_report`) and the catalog 3 (`mcp_propose_entry`,
`mcp_proposal_withdraw`, `mcp_catalog_list`: interface I3, scope `agent`, §12.6). Where the tables above
and the code differ, the code is what ships:

- `pool_*` cover the types that exist (skillset, MCP set). **Secrets pools are read-only over MCP**: a write
  answers `UI_ONLY` (Q13 decided). Persona and browser pools are not listed until their services are in.
- Not built: `settings_get`, `settings_update`, `event_search`, `account_pool_update`, `account_update`,
  `account_delete`, `secret_link_create` and the relaxation guard (FR13): their services, or the Settings
  PRD, are not in yet. `workspace_get` takes `include` of `usage`, `sessions`, `claudes` and `pools`
  (not `configuration` or `files`) and has no `wait_seconds`; `session_get` has it.
- `workspace_create` takes `account_pool` and `pools` by id or exact name and resolves them before it
  creates anything; there is no 10-minute repeat rule, a name that exists is refused by the workspace service.
- `session_respond` takes `decision` only (`allow` needs admin and a confirmation); `answer` and `mode` are not built.
- **Resources and prompts are built** for an admin's token (an agent's gets tools only): `pilot://status`,
  `pilot://workspaces/{target}/{name}`, `pilot://pools/{id}` and `pilot://tickets/{id}` (JSON, read scope), and
  the prompts `fleet_status` and `workspace_triage` (its `workspace_id` is checked against an id pattern, so an
  argument can't write the prompt). A resource is a view over a read tool, run as the caller, so it has the same
  scope check, limits, redaction, untrusted-text labels and audit row (the row names the tool behind it); the
  lists name ids and fixed words only, never a ticket's own words. Checked with Claude Code 2.1.296: it lists
  both and runs `/mcp__pilot__workspace_triage docker/api`; resources are tested with the official client in
  both protocol eras (the `@` mention itself is interactive and not exercised). No subscriptions.
- Not built: elicitation. Confirmation is the server's `confirm_token`.

## 14. Safety mechanics

### 14.1 Confirming destructive actions

No single mechanism works in every client, so there are four layers:

1. **Annotations:** claude.ai always asks before a destructive tool, unless the user chose "Always
   allow". **U** (documented for Claude Code only) is on every admin tool marked D, `mcp_lockdown`
   and `session_respond`.
2. **Scopes and guards:** admin needs a step-up, and FR13 and FR14 refuse what no prompt may allow.
3. **Server confirmation (C):** the first call returns `{"status": "confirmation_required",
   "preview": {…}, "confirm_token": "cfm_…"}`, listing what will be lost (for example the home
   volume `ws-api-dev-home` and 2 running sessions). The second call repeats the arguments plus the
   token: single use, valid 5 minutes, bound to the caller, the tool, the argument hash, the resolved
   target (ID plus `created_at` or revision) and a hash of the preview. At confirm time the server
   recomputes the preview; if it differs, it returns a new `confirmation_required` instead.
4. **Elicitation:** when a request declares `elicitation.form` (Claude Code on 2026-07-28 does;
   claude.ai doesn't list it, Q6), the server asks the user through `inputRequired` instead, with
   HMAC-signed request state (`createRequestStateCodec`, 5 minutes).

The model can complete the token step alone. It stops accidental one-shot calls and shows the blast
radius; real protection comes from the first two layers.

### 14.2 Long-running operations

claude.ai allows about 240 s and 150,000 characters per call, Claude Code moves a call to the
background after 2 minutes, and Cloudflare cuts at 100 s, so no call runs longer than 30 s.
`workspace_create` and `workspace_start` return at once. `workspace_get` and `session_get` take
`wait_seconds` (up to 25) and return early on any change. With a `progressToken`, the server sends
`notifications/progress` with the workspace's `detail` (image build, pod waiting reason). 🔬 Only
third-party probes say claude.ai sends one (Q6). The Tasks extension is deferred; no Claude client
supports it.

### 14.3 Secrets never pass through chat

- No tool has a secret field. Results show masked values, fingerprints, or "set" and "missing".
- String arguments that match secret patterns (`sk-ant-`, `ghp_`, `github_pat_`, `AKIA`, PEM, JWT,
  `cpat_`, `cpoa_`, `cpor_`) are refused with `SECRET_IN_ARGUMENT` and stored in audit as
  `[redacted]`. The message says: "This looks like a secret. It is now in this chat's history:
  rotate it, then use secret_link_create."
- `secret_link_create` returns `<PORTAL_PUBLIC_URL>/connect/secret/<id>` (without a public URL,
  `PORTAL_UI_URL`, local only), single use for 15 minutes. The page asks for the server code and the
  value, saves through the same service as the UI, and shows only the masked result. For account
  keys it adds [Account Pool](account-pool.md)'s ownership confirmation (required) and runs its
  check on save (its FR3). Clients that declare URL elicitation are also asked to open the link; the
  spec forbids secrets in form elicitation ([elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)).

### 14.4 Text from workspaces and third parties is untrusted

Agent messages, runtime errors and imported content can carry prompt injection to a model that holds
admin tools. Every field below is returned as `{"untrusted_text": "…", "source": "…"}` through the
sanitizer, and never appears in tool descriptions or server instructions.

| Source | Fields | Returned by |
| --- | --- | --- |
| Agents | Session events and titles; pending requests (questions and options, plans, tool input such as commands and paths) | `session_list`, `session_get`, the `session_respond` preview |
| Runtimes | Workspace `detail`, Kubernetes waiting and termination messages (a container writes its own), runtime error text | `workspace_list`, `workspace_get`, progress notifications |
| Delivery and monitoring | Delivery and drift errors, security event summaries and details ([Monitoring](monitoring-dashboard.md) FR23), names of unmanaged MCP servers | `workspace_get`, `event_search`, `monitor_overview` |
| Imported pool content | SKILL.md text, MCP server descriptions, tool names and lists, registry text | `pool_get`, `pool_list`, `workspace_get` (files) |
| Other hosts and clients | Custom-host error text; CIMD `client_name`, `clientInfo`, user agents | `account_check`, `account_list`, `audit_search` |

The sanitizer strips ANSI and OSC sequences, C0 and C1 controls, bidi, zero-width and Unicode tag
characters (U+E0000–E007F), redacts secret patterns, and caps text at 2,000 characters per item and
16 KB per result. `workspace_get` returns files from the compiled desired state, never read back from
the workspace. The UI recommends "Needs approval" for admin tools in claude.ai's per-tool settings.

### 14.4.1 Short results (T-282)

Every result is read again on each later request of the agent's session, so list and detail tools answer short by
default and return the rest on request: `ticket_get` (tickets PRD §12.1), `ticket_list`, `ci_runs_list` (id,
number, pipeline, branch, a 12 character sha, status, reason, ticket, created, duration; `ci_run_get` or
`full: true` for the rest), `session_family` (T-574: a session with workers gets one line per worker by default, `id8 title state model ticket
first line of its latest report`, in one `lines` `untrusted_text` block of at most 1,100 characters (`workers` stays an array of `{id}` for the lines shown), with a `cut` line saying how many workers
it left out; `view: detail` gives the rows (the latest reply's first 200 characters, no folder; `full: true` for
600 and the folder), `worker_id` one member's row by id or its first 8 characters, `reply_of` the whole reply; a session outside the
family is the same NOT_FOUND as none; T-294: a lead hears of its workers' turn ends in one line each instead of polling it) and `usage_attribution` (dollars and requests per row; `full: true` adds the tokens and the
times). `usage_spikes` keeps its evidence: it is the point of the call. A shortened field carries a `cut` line; a
whole result over 20,000 characters is refused (`RESULT_TOO_LARGE`) with a hint to narrow it, never cut silently.
The server's instructions tell agents which calls are cheap. Untrusted text keeps its `untrusted_text` label in
every form.

### 14.5 Rate limits

| Limit | Default | When exceeded |
| --- | --- | --- |
| Requests without a valid token, per client IP | 120 per minute | HTTP 429 |
| Wrong server code on the consent and secret pages | 5 per IP and 20 in total per 10 minutes, then a 10-minute lock | Page error with this IP's tries left, and an auth event. Tokens and the local UI are unaffected. |
| `/oauth/token` | 30 per minute per client and IP | HTTP 429 |
| Tool calls per token: read, write, destructive | 120 per minute, 30 per minute, 10 per 10 minutes | Tool error `RATE_LIMITED` with `retry_after_seconds` |
| Long-polls and workspace creates in flight, per token | 4 and 3 | Same |

The global limit lets anyone keep new consents and secret entry closed; Cloudflare Access (Q3) is
the way out of a sustained lockout. After sign-in, limits are tool errors rather than HTTP 429,
because Anthropic lists 403 and 429 responses at the edge as a cause of failed connections.

### 14.6 A token inside a workspace

Assume the `cpst_` token of a session is known to whatever that session reads or runs: agents have
passwordless `sudo`, and text from a web page, a repository or a ticket can steer them. What limits the damage:

- **Narrow reach.** Only `agent` tools: tickets in its own workspace and the shared queue, catalog proposals,
  who-am-I. No workspace, pool, account, setting or session tool, and nothing destructive.
- **Short life.** It dies with its session and with the workspace's opt-in, and lasts 7 days at most.
- **Rate and size.** §12.6's limits stop a looping or injected agent filling queues: 50 tickets an hour per
  session, 200 open agent tickets per workspace, 10 proposals an hour, 16 KB a proposal.
- **A person decides.** A proposal is a draft that waits for review; nothing an agent can call approves,
  publishes or delivers (a test lists every agent tool). Text an agent wrote is labelled untrusted wherever it is
  shown, and starting a session from its ticket shows the opening message first.
- **No cross-talk.** A token never works for another session or workspace; an agent changes only tickets
  assigned to its own session, or ones it made and nobody holds.
- **Audit and redaction.** Every call is audited with `session:<id>`; the portal's own results and logs mask
  `cpst_` shapes, and the chat redactor is to as well (asked of Chat sessions, not in yet); the token is in
  the process environment, not its arguments.

Accepted: the token is readable by its own session's process and what it spawns (it is that session's own
credential), and an injected agent can still make noise inside the limits above and comment on its own tickets.

## 15. User experience

Existing components only (PageHeader, PageTabs, Section, Card, Badge, Menu, FormDialog,
ConfirmDialog, SwitchRow, Segmented, Select, TextField, Button, CopyButton, EmptyState, LoadError,
RowsSkeleton, AuthLayout, ServerCodeInput), on phones and desktops. No new navigation item: the
Access page gets PageTabs "Sign-in" (today's sections) and "MCP".

**Access → MCP:**

- **MCP server:** an "Enable MCP" SwitchRow; the URL to paste into claude.ai (CopyButton), or "Local
  only" with a tunnel guide; Badges for OAuth ready, Locked, Session control on, Origin rejections,
  and "3 workspaces not protected", which opens the list with reasons.
- **Connect, claude.ai:** (1) a SwitchRow, "The claude.ai account I'll use is never used inside a
  workspace", which must be on before the steps show; (2) Add custom connector, name it
  `pilot`, paste the URL; (3) Sign in now, then "Use your own OAuth client" (or Advanced
  settings): Client ID `claude-ai`, secret blank; (4) Connect and enter the server code. The steps
  stay disabled while any workspace is Pending; Not protected workspaces are listed, and continuing
  needs a ConfirmDialog naming them. **Claude Code** (§10.2) and **scripts** (curl) follow.
- **Connections** and **Access tokens:** one row per grant (client, scope Badges, last used,
  "Expires in 5 days" near the 90-day limit) or per PAT (label, `cpat_…3f9a`, scope, expiry, last
  used), each with Menu → Revoke, plus "Revoke all"; tokens are grouped by label (§12.1b). "New token" opens a FormDialog (label; scope as
  Segmented Read, Operate, Admin, default Read; expiry as Select, 15 minutes to 365 days, default 90 days), then shows the
  token and the ready-to-paste commands once, with CopyButtons.
- **Recent activity** (the last 20 audit rows, linking to [Monitoring](monitoring-dashboard.md)),
  then **Advanced**, a Section behind a "Show advanced" ghost Button: "Allow session control over
  MCP" (off), CIMD hosts, extra origins, automatic registration (off), confirmation threshold,
  retention and size caps.

**Rotate code** (existing ConfirmDialog) adds "Also revoke 2 tokens and 1 connection", checked.
**Workspace detail → Configuration** gets a "Portal connector" row (Blocked, Pending, or Not
protected with the reason and its fix), and the workspace list's delivery chip counts it (A6).

**Public pages** are a small second entry of the same Vite build, under `/connect/`, with the same
components:

- **Consent:** AuthLayout; "claude.ai wants to manage pilot"; the redirect host; scopes as
  SwitchRows (Read on and disabled, Operate on, Admin shown only when requested and on only for a
  step-up); the loopback warning for Claude Code; the box-per-character ServerCodeInput; Allow and
  Deny. A wrong code shows this IP's tries left. It fits a 360 px screen (claude.ai mobile may open
  it in an in-app browser 🔬).
- **Secret entry:** "API key for account prod-2", the ownership confirmation (a SwitchRow) for
  account keys, the server code, a password TextField and Save, then "Saved. Key ending a1b2 ·
  Check: OK". A used or expired link says so and offers nothing else.

**In Claude**, results carry a one-line `summary` plus data, and UI links say "Opens on the portal
machine" (FR11). The shared **event log** shows MCP changes as "via MCP · claude.ai connection" and
filters by actor.

**As built (v0.6), text diet.** Rule 12 (the owner: less text, fewer components, long text into ⓘ notes)
supersedes this section's copy. Access → MCP is one tab: the **MCP** row with its switch and one ⓘ, and the
URL (copy) while it is on; **Tokens** (New; each row: label, scope, expiry, last used, Revoke; Revoke all);
**Agents** (a switch per workspace, "Agent access to portal tools", off by default; turning one off asks);
**Activity** (the last 10 calls); and **More** with the session-control switch (turning it on asks) and the
tool counts. New token: label, scope with one line under it, expiry; then the token once, with the Claude
Code command (Other ways: the helper variant, curl). The claude.ai steps, Connections, the public pages and
the advanced settings belong to MCP4 and are not built.

## 16. Security requirements

- Tokens, codes and confirm tokens are compared in constant time. Every OAuth and `/connect/*`
  response sends `Cache-Control: no-store`. Tokens are never logged; audit keeps their IDs.
- Public pages: CSRF token, `frame-ancestors 'none'`, no third-party scripts, the persisted sign-in
  switch honored. CIMD fetches pass an SSRF guard.
- While the portal is Locked, `portal_status`, `workspace_list`, `workspace_get`, `workspace_start`
  and `workspace_stop` still work; tools that need secrets or signed state return `LOCKED`; the
  consent and secret pages are closed and no tokens are issued. While delivery is Frozen (foundation
  §6.5), pool, assignment and settings writes return `FROZEN` with the reason.
- Automated tests: canary secrets planted in every pool type never appear in tool output, audit,
  errors or progress messages; Unicode tag characters and "ignore previous instructions" planted in
  every §14.4 source come back stripped and labeled; every write tool is tried against every flagged
  setting (FR13) and every unapproved version (FR14).
- Exact SDK versions, with conformance tests (Claude Code v1 and v2 runtimes, MCP Inspector,
  claude.ai) before every upgrade, since the 2026-07-28 spec is two months old.

## 17. Observability and audit

- **Authenticated requests** get one `mcp_audit` row each. Unauthenticated, Host- or
  Origin-rejected and rate-limited requests are counted per IP per minute in one `mcp_auth_events`
  row (kind `rejected`, count, first and last time). Other auth events: consent granted or denied,
  wrong code, lockout, token issued, refreshed or revoked, refresh reuse, PAT created or revoked,
  CIMD failure, lockdown.
- Each audit table has a size cap with oldest-first pruning, and a security event fires if pruning
  starts before the retention period ends; outside floods prune only `mcp_auth_events`. Changes made
  over MCP also enter the foundation's event log with an actor (A3).
- For [Monitoring](monitoring-dashboard.md): security events (lockdowns, refresh reuse, refused
  relaxations, repeated wrong codes, Origin rejections, "Portal connector used in a workspace"), and
  metrics (calls per tool, error and denial rates, p95 duration, rate-limited calls, step-ups,
  active tokens and connections).
- The first claude.ai connection records `clientInfo`, era, `Origin`, the client ID and whether a
  `progressToken` arrived, to settle Q6.

## 18. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| MCP1 | `PORTAL_PUBLIC_URL`, the public listener, Host gate, routing fixes, persisted server code and sign-in switch, audit tables | Foundation F1 |
| MCP2 | `/mcp` with PATs on loopback; read tools for what exists (portal, workspaces, audit); sanitizer and secret-pattern redaction; Access → MCP with tokens and recent activity | MCP Inspector and Claude Code v1 and v2 runtimes pass; injection tests on runtime text |
| MCP3 | Workspace write tools, `mcp_lockdown`, confirmation, rate limits, long-poll and progress | Destructive-action matrix and canary-secret tests pass |
| MCP4 | OAuth server, consent page, connections, tunnel guide, deny entry and its status in every workspace | 🔬 claude.ai connects end to end through a Cloudflare Tunnel with the `claude-ai` client; deny entry verified in an own-login workspace (Q8); foundation F2 and F3 |
| MCP5 | Pool, account pool, account, secret-link, settings, event and monitoring tools; relaxation guard; review gate; persona draft rules | Each feature's service; foundation F4 (event log); guard and review-gate tests pass |
| MCP6 | Session tools behind the session-control switch, resources, prompts, elicitation confirmation | Chat sessions C1 and C2; injection tests on session text |

**Status (2026-10-12).**

- **MCP1** partly: the audit tables and persisted settings are built. `PORTAL_PUBLIC_URL`, the public
  listener, the Host gate and the persisted server code are not; `/mcp` is on the portal's own origin, with
  an Origin check (`PORTAL_MCP_ORIGINS` adds origins).
- **MCP2** built. Checked with the official TypeScript client in both protocol eras and Claude Code 2.1.296
  (host and inside a Docker workspace); MCP Inspector not run. Injection tests on runtime text pass.
- **MCP3** built: workspace write tools, `mcp_lockdown`, confirmation, rate limits, `session_get` long-poll;
  progress is best effort. The destructive-action matrix and canary-key tests are in `portalmcp.test.ts` and
  `tools.test.ts`; canaries per pool type are not (a secrets pool's values are never returned).
- **MCP4** not built (OAuth, consent, connections, tunnel guide, the deny entry's status).
- **MCP5** partly: pool, account-pool and account tools as in §13.5; the review gate is the pool service's
  (`waiting_review`). Not built: secret links, settings and event tools, the relaxation guard, persona drafts.
- **MCP6** built except elicitation: session tools behind the switch, resources and prompts (§13.5).
- **MCP7** (added): agent tokens and the `agent` scope (§12.6), the tool registry other areas register
  through (interface I2), `mcp_propose_entry` (I3), and [Tickets](tickets.md).
- The SDK is pinned by the lockfile (`@modelcontextprotocol/server` and `/client` 2.3.1, zod 4); `package.json`
  keeps the caret, so a deliberate upgrade needs the conformance tests (§16).

## 19. Success metrics

| Metric | Target |
| --- | --- |
| Time from opening Access → MCP to the first tool call in claude.ai | Under 3 minutes |
| p95 tool duration, long-polls excluded | Reads under 1 s, writes under 3 s |
| Secrets in tool results, audit, errors or progress messages | Zero (canary tests) |
| Calls to C tools that ran without a confirm token or elicitation | Zero (test matrix per client) |
| MCP calls that relaxed a flagged setting, through any tool | Zero |
| Authenticated MCP requests missing from audit | Zero |
| Own-login workspaces without the deny entry after a public URL is set | Zero after one reconcile cycle, except those shown Not protected with a reason |
| Portal tools called from inside a workspace | Zero; each one raises a High security event |
| claude.ai reconnects caused by the portal (restarts, token bugs), the 90-day grant limit excluded | Zero |

## 20. Amendments to Pools foundation

| ID | Section | Proposed change |
| --- | --- | --- |
| A1 | §7 ownership, managed sources | Add to the Foundation row `managed-settings.d/00-claudepilot-base.json`, the base drop-in that [Skillset](skillset-pool.md) A2 and [MCP set](mcpset-pool.md) A3 also use for the marketplace, with the key `deniedMcpServers` (the portal's `serverUrl` and `serverName` entries, §10.1). Make `deniedMcpServers` a list key several owners may contribute (rule 2): Foundation for the portal, Settings & policies for admin-chosen entries (MCP set A2). Add to the managed-sources paragraph that `deniedMcpServers` and `disableClaudeAiConnectors` are read from every admin source from Claude Code 2.1.273 📄, so the deny entry holds where server-managed settings replace other drop-ins (Q9 there). |
| A2 | §6.1 compile, §6.3 reconcile | The base drop-in is a system fragment ([Monitoring](monitoring-dashboard.md) A2), compiled for every workspace, Unsupported ones included, whenever `PORTAL_PUBLIC_URL` is set, MCP on or off, with the URL in the desired hash. Changes to its deny entries skip the rollout limit, as revocations do. Reject any fragment containing a portal token prefix (`cpat_`, `cpoa_`, `cpor_`). |
| A3 | §5 tables, §10 event log | Add `actor` (`kind`: `ui`, `mcp` or `system`, plus `workspace` per Monitoring A7; `label`; `principal_id`) to `delivery_events` and every pool's event table, and an actor filter to the event log. |
| A4 | §4.1 encryption | Reserve the HKDF labels `claudepilot/mcp/cursor/v1` and `claudepilot/mcp/state/v1`, and encrypt `portal_state.server_code` and `oauth_tokens.retry_pair`. `portal rotate-key` re-encrypts both and invalidates open cursors and pending elicitations; clients just list again. |
| A5 | §11 security | Public access goes only through a TLS-terminating tunnel to a loopback listener (`PORTAL_PUBLIC_PORT`) that serves only the public paths and is never port-forwarded. Only it trusts `CF-Connecting-IP`; the main listener ignores forwarding headers and rejects the public hostname. The admin UI, `/api/*` and the terminal are never public. |
| A6 | §10 shared UI | Workspace detail → Configuration gets a "Portal connector" row (Blocked, Pending, or Not protected with the reason), and the workspace list's delivery chip includes it. |

**Requests to related PRDs.** [Settings & policies](settings-policies.md): have FR1 also flag
lowering a retention period, and decide whether raising or removing a budget or cap counts as
relaxing; Portal MCP follows the flag either way. [Monitoring](monitoring-dashboard.md): raise the
High event "Portal connector used in a workspace" from FR16's tool names, and add lockdowns and
refused relaxations to the Security feed. [Chat sessions](chat-sessions.md) A10 is adopted (§13.3).

## 21. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | Where does the portal run in production (the devcontainer on the Mac, or the k3s cluster), and what's its public hostname (for example `claudepilot.isnan.me`)? This decides where cloudflared runs, next to the public listener. Same as Account Pool Q2. | Operator |
| Q2 | Which Claude plan and which claude.ai account add the connector? Connect requires an account that's never used inside a workspace. Free allows one custom connector; on Team and Enterprise an Owner adds it for the organization. | Operator |
| Q3 | Is the server code on a public consent page acceptable, or must `/oauth/authorize` and `/connect/*` sit behind Cloudflare Access (also the way out of a wrong-code lockout), or should the portal add a passkey or TOTP? | Operator |
| Q4 | Should rotating the server code revoke MCP tokens and connections by default (proposed: yes, with an opt-out)? | Product |
| Q5 | Built-in authorization server (proposed), or Cloudflare Access Managed OAuth (less code, but no scopes, Cloudflare lock-in, and it can't share an Access app with our own server)? | Engineering |
| Q6 | 🔬 What does claude.ai send and do: its CIMD client ID, `Origin`, protocol revision and capabilities (progress, elicitation); how it refreshes the tool list; whether its mobile app opens the consent page in an in-app browser? Recorded on first connect. Connecting no longer depends on the answer (§12.2). | Live test |
| Q7 | 🔬 Does Claude Code honor HTTP 403 `insufficient_scope` step-up for MCP OAuth? If not, Claude Code connects with PATs only. | Live test |
| Q8 | 🔬 On the pinned Claude Code version, does the deny entry block the synced connector in an own-login workspace (the docs say it does), and does a running session drop it when the entry arrives, or keep it until reconnect or restart? If it doesn't hold, Plan B (§10.1). | Sandbox test |
| Q9 | ✅ Resolved: session tools ship behind "Allow session control over MCP", off by default, with steering in admin scope (§13.3). | |
| Q10 | Are 90 days of call audit and 365 days of auth events, capped at 512 MB and 64 MB in SQLite, enough? | Operator |
| Q11 | ✅ Resolved: SDK v2 (2.3.1) with zod 4 builds with the repo's TypeScript 5.9.3; the typecheck is clean. | |
| Q12 | 🔬 Which Bot Fight Mode option does the zone use (§11.3), and do a cloudflared ingress with path rules, the catch-all 404 and SSE keep-alives work end to end with claude.ai? | Live test, Operator |
| Q13 | ✅ Decided for now: secrets pools stay UI-only; over MCP they are read-only (`UI_ONLY` on writes). Secret links are not built. | |
| Q14 | Is an inline MCP App status card (Claude web and Desktop) wanted later? | Product |
| Q15 | 🔬 Which tool names does Claude Code give a claude.ai connector? This session shows `mcp__claude_ai_<name>__<tool>`; Monitoring's detection (§10.1) matches on it. | Sandbox test |
