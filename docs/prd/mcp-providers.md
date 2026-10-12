# PRD: MCP providers

| | |
| --- | --- |
| Status | **Draft v0.1, built** (2026-10-12). The five definitions and the stand-in provider server are built and tested (§10), and the research below was checked on 2026-10-12 against each provider's public discovery documents and documentation. Not confirmed, because it needs a real account: §9 (🔬). |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Built-in MCP catalogue](mcp-builtin-catalogue.md) (the template contract these files fill in, preview and Add), [MCP set pool](mcpset-pool.md) (FR1 OAuth fields, §10.2 delivery, §13.3 OAuth servers) |
| Related | [Secrets & env](secrets-env-pool.md) (the names token slots reference, FR21), [Portal MCP server](portal-mcp.md) |

## 1. Summary

The [built-in catalogue](mcp-builtin-catalogue.md) is only as good as its facts: a wrong URL, a scope the
provider never grants or an OAuth style the provider does not have costs an admin an afternoon. This PRD
records what each of the five providers (GitHub, GitLab, Gitea, Outline, Cloudflare) really offers, how that
was checked, and the definition that follows from it, in `apps/server/src/mcp/builtin/providers/`. It also
describes the **stand-in provider**, a small fake MCP server with an authorization server that the catalogue's
tests, the OAuth sign-in work and the security review run against, so none of them needs a real account
(`apps/server/src/mcp/builtin/testkit/`).

The short version of the research:

| Provider | OAuth without a client secret? | So the template offers |
| --- | --- | --- |
| GitHub | No. No dynamic registration, and an OAuth App's code exchange still needs its client secret. | **token** only |
| GitLab | Yes: dynamic registration (RFC 7591), scope `mcp`. | OAuth, then token (unconfirmed, §5.2) |
| Gitea | Yes, with a **pre-registered public PKCE client** (no registration endpoint); OIDC discovery only. | OAuth (client ID asked), then token |
| Outline | Yes: dynamic registration, S256, scopes `read` and `write`. | OAuth, then token (API key) |
| Cloudflare | Yes: dynamic registration on the API server; the docs server needs no sign-in. | OAuth, then token (API token) |

## 2. Method and marks

Every fact carries one mark, and a source. The templates carry `checkedAt` (this day) and `version`; a change to
a definition bumps `version`, so instances of the old one show "Update" in the catalogue.

| Mark | Meaning |
| --- | --- |
| ✅ | **Observed**: a harmless unauthenticated request to the provider's public host (a GET of a discovery document, one unauthenticated MCP `initialize` POST per URL to read the 401 challenge), or a run of a real Claude Code 2.1.296 against a stand-in (B3 with its own, B2 with the kit of §6). No real token was sent, nothing was registered at a provider, nobody signed in. |
| 📄 | **Documented**: the provider's documentation or its source on a public repository (URL given), Claude Code's documentation, or the owner's cluster manifests read through the read-only mount (non-secret settings only). |
| 🔬 | **Unverified**: needs a real account, a real token or a person at a consent screen. Listed in §9. |

To re-check a provider (all three are harmless):

```
curl -si -X POST <mcp-url> -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
curl -s <origin>/.well-known/oauth-protected-resource<path of the MCP url>
curl -s <issuer>/.well-known/oauth-authorization-server        # or /.well-known/openid-configuration
```

## 3. The definitions at a glance

| | Modes | Servers (on by default in bold) | Params (OAuth only in italics) | Token slot | Pinned OAuth fields |
| --- | --- | --- | --- | --- | --- |
| GitHub | token | **`github`**, `github-ro` | none | `GITHUB_TOKEN` | none |
| GitLab | oauth, token | **`gitlab`** | `host` (`https://gitlab.com`), *`clientId` (optional)* | `GITLAB_TOKEN` | `callbackPort` 24819 |
| Gitea | oauth, token | **`gitea`** | `mcpUrl`, *`baseUrl`*, *`clientId` (required)* | `GITEA_TOKEN` | `callbackPort` 24819, `scopes` (seven `write:*`), `authServerMetadataUrl` |
| Outline | oauth, token | **`outline`** | `outlineUrl` | `OUTLINE_API_KEY` | none |
| Cloudflare | oauth, token | **`cf-api`**, **`cf-docs`**, `cf-bindings`, `cf-observability` | none | `CLOUDFLARE_API_TOKEN` | none |

Conventions: a token goes in `Authorization: Bearer <value>` (every provider here reads that form); the server keys
carry the provider's name because catalog entry keys are global (`cf-` for Cloudflare, to keep tool names short);
the Gitea defaults are the owner's own instance, every one overridable; texts are short, with the long explanation in the template's `notes` (an InfoTip).

## 4. What Claude Code does with them (2.1.296)

These facts decide the OAuth fields of a definition. The ✅ rows are runs of a real Claude Code in a workspace
container against a stand-in provider: B3's runs (against its own stand-in, delivered through the portal; the detail is
in [MCP set pool](mcpset-pool.md) §13.3) and B2's against the kit of §6.

| Fact | Mark | Source |
| --- | --- | --- |
| Sign-in is OAuth authorization code with PKCE, redirect `http://localhost:<port>/callback` (host `localhost`, not `127.0.0.1`; path `/callback`). The port is random per client registration, or exactly `oauth.callbackPort` when set. | ✅ 📄 | B3's runs; [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) |
| With `oauth.clientId` set there is no dynamic registration and no client secret: `authorize` carries `client_id`, `response_type=code`, `code_challenge_method=S256`, `scope` and `resource=<MCP URL>`; the token call repeats the same `redirect_uri` and `resource`. | ✅ | B3's runs |
| `oauth.scopes` in `.mcp.json` is **one space-separated string**. An array makes Claude Code silently drop the whole server from the plugin. The contract keeps `string[]`; the compiler joins them. | ✅ 📄 | B3's runs; docs |
| Requested scope, by precedence: pinned `oauth.scopes`; else the `scopes_supported` of the `authServerMetadataUrl` document; else the protected resource's; else the authorization server's. | ✅ | B3's runs |
| `authServerMetadataUrl` must be `https://` (an `http://` one fails at config load). Claude Code then fetches exactly that document and reads no other discovery document of the authorization server. | ✅ | B3's runs |
| Without it, discovery is RFC 9728 (protected resource metadata), then RFC 8414, then **OpenID Connect discovery**. The OIDC document is validated with the MCP SDK's schema, which **requires `jwks_uri`**. | ✅ | B3's runs |
| It probes `server/discover` first (a JSON-RPC `-32601` answer is fine), reads the PRM at `/.well-known/oauth-protected-resource/mcp`, registers as `Claude Code (<server name>)` with `token_endpoint_auth_method: none`, and sends `resource=<MCP URL>` on refresh. | ✅ | B3's runs |
| A `headersHelper` output that includes an `Authorization` header is used as the server's credential and OAuth is not tried; a rejected one is a failed connection, not "needs sign-in". This is the token fallback's path. | 📄 | docs |
| `claude mcp login --no-browser <name>` needs a terminal: with none it prints "stdin isn't a terminal, so authentication can't be completed here". With one it prints the URL and offers "Or paste the redirect URL here:"; the pasted URL completes it ("Authenticated with …"), and `claude mcp list` then says `✔ Connected`. On the same machine the browser's own redirect to the loopback callback completes it (B3). | ✅ | the kit run (§6), in tmux; B3 |
| Claude Code adds `offline_access` to the requested scope by itself when the authorization server advertises it (`scope=user:read account:read offline_access` against the Cloudflare-style preset). After the access token expired it got a 401, sent `grant_type=refresh_token` with `resource=<MCP URL>` and stayed Connected; with the refresh token expired too it says "Needs authentication". | ✅ | run against the stand-in (§6) |
| An authorization server with no registration endpoint and no `oauth.clientId`: `✘ Failed to connect — Incompatible auth server: does not support dynamic client registration`. A configured header token the server rejects: `✘ Failed to connect — Server rejected the configured Authorization header (HTTP 401) … OAuth fallback is disabled when headers.Authorization is set`. A wrong token against a server that answers 200 (gitea-mcp alone) shows `✔ Connected`. | ✅ | run against the stand-in (§6) |
| Chat sessions (`claude -p`) cannot sign in; they name the server that needs it. Credential-named environment variables read empty in a remote server's `url` and `headers`, which is why tokens come from secret files. Anthropic-hosted connector hosts are refused for local OAuth (none of ours). | 📄 | docs |

## 5. The providers

### 5.1 GitHub

Remote server `https://api.githubcopilot.com/mcp` (checked 2026-10-12). **Token only.**

| Fact | Mark | Source |
| --- | --- | --- |
| `POST /mcp`, `/mcp/` and `/mcp/readonly` with no token answer 401 directly (no redirect): `Bearer error="invalid_request", error_description="No access token was provided in this request", resource_metadata="https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp"` (the readonly one names `…/mcp/readonly`). | ✅ | probe |
| Protected resource metadata (path form only; the bare path is 404): `resource` `https://api.githubcopilot.com/mcp`, authorization server `https://github.com/login/oauth`, ten scopes (`repo`, `read:org`, `read:user`, …). | ✅ | probe |
| Authorization server metadata is at the path-inserted RFC 8414 URL `https://github.com/.well-known/oauth-authorization-server/login/oauth`: PKCE `S256`, grants `authorization_code`, `refresh_token`, device code, `authorization_response_iss_parameter_supported`, scope `offline_access`, **no `registration_endpoint`**, no client-ID-metadata-document flag. | ✅ | probe |
| An OAuth App's code exchange marks `client_secret` **Required** even with PKCE; only the device flow needs none. Claude Code's documented flow is the authorization code flow; no device flow is described. | 📄 | [GitHub: authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [Claude Code docs](https://code.claude.com/docs/en/mcp) |
| "Each MCP host application needs to configure a GitHub App or OAuth App to support remote access via OAuth"; "any host … should support the remote GitHub server with PAT authentication." | 📄 | [github-mcp-server README](https://github.com/github/github-mcp-server) |
| URLs: default `/mcp`, read-only `/mcp/readonly`, one toolset `/mcp/x/<toolset>` (also `/readonly`), all `/mcp/x/all`, `/insiders`; headers `X-MCP-Toolsets`, `X-MCP-Tools`, `X-MCP-Readonly`, `X-MCP-Lockdown`, `X-MCP-Insiders`. Default toolsets: `context`, `repos`, `issues`, `pull_requests`, `users`. | 📄 | [remote-server.md](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md) |
| Claude Code: `claude mcp add-json github '{"type":"http","url":"https://api.githubcopilot.com/mcp","headers":{"Authorization":"Bearer <PAT>"}}'`; failures: check the PAT has `repo` and has not expired. | 📄 | [install-claude.md](https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-claude.md) |
| GitHub Enterprise Server "does not support remote server hosting". Enterprise Cloud with data residency: `https://copilot-api.<subdomain>.ghe.com/mcp`. | 📄 | README |
| A real Claude Code against an authorization server shaped like GitHub's (no registration endpoint, a confidential client, no `clientId` to give) stops with `Incompatible auth server: does not support dynamic client registration`. | ✅ | the stand-in's `github` preset, §6 |
| Whether `/readonly` and the toolset paths exist on `ghe.com`; classic versus fine-grained PAT acceptance and the permissions each tool needs; any organization policy ("MCP servers in Copilot") that blocks a PAT. | 🔬 | not stated |

Definition: `github` (default tools) and `github-ro` (write tools hidden, off by default), one shared slot
`GITHUB_TOKEN`; no params. `ghe.com` is added by hand (a note says so): a host param would put a field in
every Add for a niche case.

### 5.2 GitLab

Built-in server `<host>/api/v4/mcp`, GitLab.com and self-managed alike.

| Fact | Mark | Source |
| --- | --- | --- |
| `POST https://gitlab.com/api/v4/mcp` with no token: 401 `Bearer realm="GitLab", scope="mcp", resource_metadata="https://gitlab.com/.well-known/oauth-protected-resource/api/v4/mcp"`, body `{"message":"401 Unauthorized"}`. | ✅ | probe |
| Protected resource metadata (path form and bare): `resource` `https://gitlab.com/api/v4/mcp`, authorization server `https://gitlab.com`, scopes `["mcp"]`. | ✅ | probe |
| Authorization server (RFC 8414 at `/.well-known/oauth-authorization-server`): `registration_endpoint` `/oauth/register`, PKCE `plain` and `S256`, `token_endpoint_auth_methods_supported` `client_secret_basic` and `client_secret_post` (no `none`), scopes including `mcp`. | ✅ | probe |
| Generally available since 19.5 (experiment in 18.3, beta in 18.6; the flags `mcp_server` and `oauth_dynamic_client_registration` were removed in 18.6). Free tier from 19.2. Needs "Allow access to the MCP server" on: for the instance, or for the top-level group on GitLab.com. GitLab Duo is not required for the core toolsets. | 📄 | [GitLab docs](https://docs.gitlab.com/user/model_context_protocol/mcp_server/) |
| Authentication is OAuth 2.0 **dynamic client registration** (RFC 7591), limited to 10 registrations an hour per IP address; an admin can turn it off, after which each user needs a pre-registered application: scope `mcp`, **Confidential unchecked**, its Application ID is the client ID; the redirect URI must match exactly. | 📄 | GitLab docs |
| `claude mcp add -s user --transport http GitLab https://<host>/api/v4/mcp`, then `/mcp` and the browser. Toolsets by header `X-Gitlab-Enabled-Mcp-Server-Toolsets` (`core`, `merge_requests`, `work_items`, `repository`, `ci` on by default; `wikis`, `code_security` opt-in). | 📄 | GitLab docs |
| The endpoint's source reads the token through Doorkeeper (OAuth) and refuses a token without the `mcp` scope or a granular scope; the access-token scopes page lists no `mcp` scope for personal, project or group tokens. So a **classic personal access token is probably refused**; a granular token may pass. The docs say nothing about PATs, and third-party pages disagree. | 📄 🔬 | [`lib/api/mcp/base.rb`](https://gitlab.com/gitlab-org/gitlab/-/raw/master/lib/api/mcp/base.rb), [token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/) |
| Whether GitLab accepts the registration Claude Code sends (`token_endpoint_auth_method: none`) although its metadata advertises secret-based methods only; the whole sign-in with the fixed callback port; a PAT as `Bearer`. | 🔬 | needs an account |

Definition: one server `gitlab`, URL `{host}/api/v4/mcp` (`host` defaults to `https://gitlab.com`), OAuth with
dynamic registration, and the **optional** `clientId` for instances whose admin turned registration off.
`callbackPort` 24819 is pinned so a registered redirect URI (`http://localhost:24819/callback`) matches;
scopes are left to the server (its challenge says `mcp`). The **token mode is offered but flagged
unconfirmed** in its description and notes: the source also accepts a granular scope, and chat sessions
(`claude -p`) cannot sign in, so a token that works would be their only way in before someone signs in by hand.
The owner can confirm it with one token (§9).

### 5.3 Gitea (ours)

gitea-mcp in HTTP mode, as the owner runs it (`-t http -oauth -oauth-public-url … -H https://git.konfersi.com`
behind an nginx sidecar at `https://gitea-mcp.konfersi.com/mcp`).

| Fact | Mark | Source |
| --- | --- | --- |
| `POST https://gitea-mcp.konfersi.com/mcp` with no token: 401 `Bearer resource_metadata="https://gitea-mcp.konfersi.com/.well-known/oauth-protected-resource/mcp", scope="write:repository write:issue write:user write:organization write:notification write:package write:misc"`, body `authorization required`. | ✅ | probe |
| Protected resource metadata (both forms): authorization server `https://git.konfersi.com`, the same seven scopes. | ✅ | probe |
| `https://git.konfersi.com/.well-known/oauth-authorization-server` is **404**; `/.well-known/openid-configuration` is 200: `/login/oauth/authorize`, `/login/oauth/access_token`, `jwks_uri`, `userinfo_endpoint`, PKCE `plain` and `S256`, grants `authorization_code` and `refresh_token`, `scopes_supported` `openid profile email groups` (**not** the API scopes), **no registration endpoint**. | ✅ | probe |
| gitea-mcp runs with `-oauth`: no static token, every request carries the caller's own Gitea access token. The sidecar checks the bearer against Gitea `GET /api/v1/user` (30 s cache) and answers 401 with `error="invalid_token"` when a token was presented, because gitea-mcp itself answers 200 with a tool error and clients would never refresh. The OAuth app is created by hand ("Claude MCP (gitea-mcp.konfersi.com)"), public, no secret. Image `gitea/gitea-mcp-server:1.8.0`. | 📄 | the owner's cluster manifest (`konfersi-infra/gitea/gitea-mcp.yaml`, comments and non-secret settings) |
| gitea-mcp HTTP mode: `/mcp` (POST only) and `/healthz`; per-request `Authorization: Bearer <token>` or `Authorization: token <token>`; OAuth mode flags `-oauth`, `-oauth-public-url`; register the Gitea app with Confidential Client **unchecked** so PKCE is used; env `GITEA_ACCESS_TOKEN`, `GITEA_HOST`, `GITEA_READONLY`. | 📄 | [gitea-mcp README](https://gitea.com/gitea/gitea-mcp) |
| Gitea's OAuth provider: authorization code grant only, with PKCE and no client secret for public clients; `http://127.0.0.1/` as a redirect URI "allows any port" (public clients only) and `localhost` "should be avoided"; granular `read:`/`write:` scopes since 1.23, and a non-OIDC scope outside that set falls back to full access; applications are made in Settings, Applications (or `POST /user/applications/oauth2`). | 📄 | [Gitea docs](https://docs.gitea.com/development/oauth2-provider), the owner's `tea api` recipe |
| Claude Code sends `http://localhost:<port>/callback`, so Gitea's loopback-IP rule never applies: the app needs the exact URI `http://localhost:24819/callback` and the template pins `callbackPort` 24819. OIDC fallback works with `jwks_uri`; the pinned scopes win over the OIDC document's. | ✅ | B3's runs against its own stand-in; B2's against the kit's `gitea` preset |
| In a real workspace with the delivered built-in (B1's run): the owner's gitea-mcp shows "Needs authentication", as it should before anyone signs in. | ✅ | B1's report |
| Against the stand-in's `gitea` preset (§6) the definition's shape works end to end: `oauth.clientId`, `callbackPort` 24819, the seven pinned scopes as a string and an https `authServerMetadataUrl` give a sign-in and `✔ Connected`. A wrong header token against the `gitea` preset (the sidecar's behaviour) is refused (`HTTP 401 … OAuth fallback is disabled when headers.Authorization is set`); against `gitea-bare` (gitea-mcp alone) it shows Connected, and only tool calls would fail. | ✅ | the kit run, §6 |
| Gitea matching `http://localhost:24819/callback` exactly; the 1-hour access token refreshing through Claude Code; a Gitea personal access token as `Bearer` through the sidecar (it validates with `/api/v1/user`, which accepts one). The Gitea version that introduced public PKCE clients and the gitea-mcp version that introduced `-oauth` are not stated (the owner runs gitea-mcp-server 1.8.0 with it). | 🔬 | needs the real app and a token |

Definition: params `mcpUrl` (default the owner's), `baseUrl` (default the owner's; OAuth only, used for the
discovery URL), `clientId` (required, OAuth only: the ID of a public app made by hand, not secret and with no
default). The OAuth block: `dcr: false`, the client ID, `callbackPort` 24819, the seven `write:*` scopes pinned
(Gitea's OIDC document names OIDC scopes, and Claude Code would request those), and
`authServerMetadataUrl` = `{baseUrl}/.well-known/openid-configuration` (https, as Claude Code insists). The
notes say how to create the app and record the sidecar's 401 behaviour.

### 5.4 Outline

Built-in endpoint `<outline>/mcp`, hosted (`https://<subdomain>.getoutline.com/mcp`) or self-hosted.

| Fact | Mark | Source |
| --- | --- | --- |
| `POST https://docs.isnan.me/mcp` (the owner's) with no token: 401 `Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"` (no `scope`), JSON body `{"ok":false,"error":"authentication_required",…}`. The hosted `https://app.getoutline.com/mcp` adds `scope="read write"`. | ✅ | probe |
| Protected resource metadata (both forms): the Outline origin is its own authorization server, scopes `read` and `write`. Authorization server metadata (RFC 8414; no OIDC document): `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, **`/oauth/register`**, `token_endpoint_auth_methods_supported` `client_secret_post` and `none`, PKCE `S256` only. | ✅ | probe (both hosts) |
| MCP is on or off per workspace at Settings, Workspace, AI. OAuth is the default; an API key goes in `Authorization: Bearer <key>`. Hosted URL `https://<subdomain>.getoutline.com/mcp`, self-hosted `<domain>/mcp`; only streamable HTTP. `claude mcp add --transport http outline https://<subdomain>.getoutline.com/mcp`, then `/mcp`. | 📄 | [Outline MCP guide](https://docs.getoutline.com/s/guide/doc/mcp-6j9jtENNKL) |
| The route is stateless streamable HTTP, POST only (GET and DELETE answer 405). Accepted credentials: MCP, OAuth and API tokens. With the workspace's MCP preference off it answers 404. Registration returns 404 when the instance sets `OAUTH_DISABLE_DCR`. Public clients refresh without a secret; `state` is required; refresh tokens rotate. | 📄 | [`server/routes/mcp`](https://github.com/outline/outline/blob/main/server/routes/mcp/index.ts), [`server/routes/oauth`](https://github.com/outline/outline/blob/main/server/routes/oauth/index.ts) |
| v1.6.1 (18 March): MCP takes an API key header. v1.9.0 (9 July): the 401 carries `WWW-Authenticate`, which is what lets Claude Code find the authorization server, and `client_name` is optional at registration. (Release dates as printed, without a year.) | 📄 | [releases](https://github.com/outline/outline/releases) |
| The redirect addresses Outline's registration accepts (the schema was not visible); the whole sign-in with Claude Code; rotation under Claude Code. | 🔬 | needs an account |

Definition: one param `outlineUrl` (no default: the owner has three instances), server `outline` at
`{outlineUrl}/mcp`, OAuth with dynamic registration and the server's own scopes, API key fallback in
`OUTLINE_API_KEY`. Notes: Outline 1.9 for sign-in, 1.6.1 for the key, the admin switch, and that an instance
with registration off needs the key.

### 5.5 Cloudflare

Official remote servers. The API server is the recommended one; four are in the definition.

| Fact | Mark | Source |
| --- | --- | --- |
| `POST https://mcp.cloudflare.com/mcp` with no token: 401 `Bearer realm="OAuth", resource_metadata="https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp", scope="user:read account:read"`, empty body. PRM (path form only; the bare path is 404): authorization server `https://mcp.cloudflare.com`. Its metadata: `/authorize`, `/token`, **`/register`**, a very long `scopes_supported` including `offline_access`. | ✅ | probe |
| `POST https://docs.mcp.cloudflare.com/mcp` (`initialize`) with **no token answers 200** over SSE (`docs-ai-search`); its CORS headers allow `cf-account-id`. No protected resource metadata. | ✅ | probe |
| `bindings.mcp.cloudflare.com` and `observability.mcp.cloudflare.com` answer 401 with `Bearer realm="OAuth", resource_metadata=…` (no scope); PRM in both forms, their own host as authorization server. | ✅ | probe |
| The API server has `search` and `execute` (JavaScript against the OpenAPI spec and `cloudflare.request()`; about 1k tokens against 244k for every endpoint as a tool), `docs` and `whoami`. `?codemode=false` and `?truncateToolResult=false` change that (risk flag `query` in the review). | 📄 | [cloudflare/mcp](https://github.com/cloudflare/mcp) |
| OAuth is recommended: sign in at Cloudflare and choose the permissions. An **API token** (user or account) goes in `Authorization: Bearer`; account tokens need "Account Resources: Read" so the account is found; tokens with IP address filtering are not supported. With OAuth or a user token the agent passes `account_id` itself. | 📄 | cloudflare/mcp, [Cloudflare docs](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/) |
| Listed: Cloudflare API (recommended), Documentation, Containers, Browser Run, DEX, CASB, Blog, Demo Day. **Deprecated, "migrate to the Cloudflare API MCP Server"**: AI Gateway, Audit Logs, AutoRAG, DNS Analytics, GraphQL, Logpush, Observability, Radar, Workers Bindings, Workers Builds. The `/sse` URLs remain only as aliases. | 📄 | cloudflare/mcp, Cloudflare docs |
| A `cf-account-id` header picks the account for servers that read it (the owner's Developer Platform connector says so; the docs server's CORS list names it). Not used by the definition. | 📄 ✅ | connector instructions, probe |
| In a real workspace with the delivered built-in (B1's run on the real hosts): `cf-docs` shows `✔ Connected` with no sign-in, `cf-api` shows "Needs authentication". | ✅ | B1's report, [built-in catalogue](mcp-builtin-catalogue.md) |
| Against the stand-in's `cloudflare` preset, Claude Code parses SSE answers, reads the path-form PRM and asks for `user:read account:read offline_access` (it appends `offline_access` itself). | ✅ | the stand-in run, §6 |
| The whole sign-in with Claude Code against the real server; which permissions the consent screen offers when Claude Code asks only for the two the challenge names (`user:read account:read`), since writes need more; the `offline_access` refresh; an API token on the deprecated servers (documented only as "a token with the scopes that server needs"); `cf-account-id`. | 🔬 | needs an account |

Definition: `cf-api` and `cf-docs` on, `cf-bindings` (the owner's Developer Platform connector: Workers, D1,
KV, R2, Hyperdrive) and `cf-observability` off, with "Deprecated by Cloudflare" in their descriptions. The docs
server has neither `oauth` nor `token`, so it is offered in both modes. All three authenticated servers share
`CLOUDFLARE_API_TOKEN`. The other product servers (Containers, Browser Run, DEX, CASB, Blog) are left out: the
API server reaches their APIs, and each extra row is one more thing to untick.

## 6. The stand-in provider

`apps/server/src/mcp/builtin/testkit/`. A real remote MCP server and its authorization server are impossible to test
against without accounts and tokens, so the kit is a small server (Node built-ins only, nothing installed) that
speaks the same protocols, with presets that copy the shapes observed in §5. It is not Claude Code, and it
never claims what a real provider's consent screen does (§9).

**What it speaks.** The MCP endpoint (`initialize`, `tools/list`, `tools/call` for `whoami` and `echo`, `ping`,
notifications, batches; JSON or SSE answers; GET and DELETE answer 405); bearer checking (a configured static
token, `Authorization: token` where the server reads it, an issued access token) with the RFC 6750 challenge: no
token gives `WWW-Authenticate: Bearer resource_metadata=…`, a wrong or expired one adds `error="invalid_token"`;
RFC 9728 metadata (path form and bare); RFC 8414 and OIDC discovery for the authorization server, on the same
origin or its own, with or without a path in the issuer; the authorization endpoint (PKCE `S256` and `plain`,
`state`, RFC 9207 `iss`), the token endpoint (authorization code and refresh, public and confidential clients,
refresh rotation, a replayed code revokes what it issued, `resource` recorded), registration (RFC 7591, rate
limited, public clients always accepted) and revocation (RFC 7009).

**Redirects go to loopback addresses only** (`http://localhost`, `127.0.0.1`, `[::1]`), or also to claude.ai and
claude.com with `redirects: 'loopback+claude'`: the owner's own MCP servers refuse a portal-hosted https
callback, and so does the kit, at registration and at authorization (a bad address is a plain 400, never a
redirect). Gitea's rule is available as `looseLoopback`: a registered IP-literal loopback address matches on any
port, `localhost` only exactly.

| Preset | Copies | Distinctive |
| --- | --- | --- |
| `gitea` | the owner's Gitea behind the sidecar | authorization server on its own origin; OIDC only (no RFC 8414), with `jwks_uri`; no registration; one public pre-registered client with `http://localhost:24819/callback` and `http://127.0.0.1/callback`; OIDC scopes differ from the seven API scopes the resource wants; `token <t>` works; a wrong token gets 401 `invalid_token` |
| `gitea-bare` | gitea-mcp with no sidecar | the same, but a wrong token still gets **200**, and only tool calls fail |
| `gitlab` | GitLab's built-in server | same origin; RFC 8414 and OIDC; registration limited to 10 an hour; `client_secret_basic` and `_post` advertised; `plain` and `S256`; 2-hour tokens |
| `cloudflare` | the Cloudflare API server | path-form PRM only; registration; a refresh token only with `offline_access`; SSE answers |
| `outline` | Outline | registration of public clients; `state` required; `S256` only; JSON 401 body; rotating refresh tokens |
| `github` | GitHub | issuer with a path (`/login/oauth`), metadata at the path-inserted URL; no registration; its one client is confidential, so a client with no secret cannot finish |

**Verified against a real Claude Code.** Built with `build.ts`, copied into a throwaway workspace container
(`claudepilot-workspace`, Claude Code 2.1.296, a user config of its own, talking only to the stand-in on its loopback) and driven
with `claude mcp add`, `claude mcp login --no-browser` in tmux (the URL fetched with curl, the redirect URL pasted
back) and `claude mcp list`:

| Preset and setup | Result |
| --- | --- |
| `outline`: registration, `state` required, S256 | Registered as `Claude Code (bp-outline)` (`none`), signed in, `✔ Connected`; the clock moved past the token lifetime: 401, refresh, still Connected; past the refresh token's: `Needs authentication` |
| `gitea`: own origin for the authorization server, OIDC only, pre-registered client, `oauth.clientId`, `callbackPort` 24819, pinned scopes (a string) | The authorization request carried `client_id`, the seven scopes, `redirect_uri=http://localhost:24819/callback` and `resource`; signed in; `✔ Connected`; `claude mcp get` shows "client_id configured, callback_port 24819" |
| `gitea` over https (`--self-signed`, `NODE_EXTRA_CA_CERTS`) with `authServerMetadataUrl` = `<issuer>/.well-known/openid-configuration` | Signed in with the pinned scope; `✔ Connected` (the Gitea template's pattern) |
| `gitlab`: registration, challenge `realm="GitLab", scope="mcp"` | Scope `mcp` requested; signed in; `✔ Connected` |
| `cloudflare`: SSE answers, path-form PRM only, refresh only with `offline_access` | Scope `user:read account:read offline_access`; signed in; `✔ Connected` |
| `github`: no registration, a confidential client | `✘ Incompatible auth server: does not support dynamic client registration` |
| Header tokens: `Bearer` against `outline`, `token <t>` against `gitea`; a wrong one against `gitea` (sidecar) and `gitea-bare` | Connected, Connected; `✘ Server rejected the configured Authorization header (HTTP 401)`; `✔ Connected` (the false positive) |

**Controls.** In process: `startProvider(preset, overrides)` returns the URL, issuer and origins, `requests` (each
with endpoint, status, scheme, JSON-RPC method, challenge, error and the parameters of authorize, token and
register requests; values of `code`, `code_verifier`, `refresh_token`, `client_secret` and `token` are never
kept), `tokens()`, `clients()`, `advance(ms)` (a clock the tokens age on), `setAuthorize('deny')`,
`setQuirk('badTokenOk' | 'sse' | 'issMismatch' | 'metadataIssuerMismatch', …)`, `addClient`, `revokeAll()`.
Options include `tls` (https, for `authServerMetadataUrl`; `selfSignedCertificate()` makes one with openssl),
token lifetimes, `rotateRefresh`, `refreshNeedsOffline`, `redirects`, `dcrLimitPerHour`.

**In a workspace container.** `build.ts` bundles `cli.ts` into one dependency-free script, like the CI runner's
(`npx tsx src/mcp/builtin/testkit/build.ts /tmp/standin.cjs`, from `apps/server`). `node standin.cjs --preset gitea
--port 4601 --auth-port 4602 --control [--self-signed | --tls-cert F --tls-key F] [--client id=redirect]
[--static-token t=subject] [--access-ttl N] [--bad-token-ok] [--sse]` prints one JSON line when it listens and
runs until SIGTERM. With `--control` it is steered with curl: `GET /__standin/state`, `POST /__standin/advance
{"ms":3600000}`, `/authorize {"mode":"deny"}`, `/quirk {"name":"badTokenOk","value":true}`, `/revoke-all`.
Everything it issues is fake and in memory; the control endpoints do not exist without the flag.

## 7. Requirements

- **FR1** One definition per provider, in code (`providers/<id>.ts`), exported as `BUILTIN_TEMPLATES`; the registry
  validates all of them when the server starts, so a mistake stops the start and names the problem.
- **FR2** Every URL, scope, redirect rule and header in a definition has a ✅ or 📄 source here; anything else is 🔬
  and is said so in the definition's text. No definition carries a client secret, a token or a default client ID.
- **FR3** OAuth is offered first only where the provider works without a client secret; a provider that does not
  is token only and says why (GitHub). A pre-registered public client pins `callbackPort` (one constant,
  `providers/common.ts`, 24819) and its notes name the redirect URI to register.
- **FR4** Tokens go in `Authorization: Bearer <value>` from a Secrets & env secret file whose suggested name is
  the provider's usual one; servers of one definition that share a token share a slot.
- **FR5** Texts follow the UI text diet: a summary under 90 characters, at most five notes of 260 characters, a
  param label of at most two words, hints under 200 characters. Long explanations are `notes`.
- **FR6** The stand-in provider speaks the protocols of §6 closely enough that a real client library, and Claude
  Code, complete a sign-in against it; its presets mirror the definitions (a test pins the scopes, the redirect
  and the discovery document the Gitea template names), and its request log never keeps a secret.
- **FR7** Facts age: each template carries `checkedAt`, and a changed fact bumps `version`.

## 8. Decisions taken for the owner (2026-10-12), provisional

| # | Decision | Why |
| --- | --- | --- |
| P1 | GitHub is **token only**, with no host param. | No registration, and the OAuth App flow needs a client secret the portal never holds (D1). `ghe.com` is a hand-made entry; Enterprise Server has no remote server. |
| P2 | GitLab offers the **token mode although unconfirmed**, flagged in its description and notes. | A classic PAT is probably refused, but a granular token may pass, and a token is the only way for `claude -p` before anyone has signed in. One token confirms it (§9); a later `version` keeps or removes it. |
| P3 | One callback port, **24819**, for every client registered by hand (Gitea required, GitLab optional). | A registered redirect URI matches exactly and Claude Code sends `http://localhost:<port>/callback`. Below Linux's ephemeral range and away from dev-server ports; one constant to change. B3 confirmed the URI form. |
| P4 | Gitea **pins its scopes** (the seven the owner's server names) and names the OIDC document as `authServerMetadataUrl`. | Gitea has no RFC 8414 endpoint and its OIDC document lists OIDC scopes; pinned scopes win over everything. Scopes of GitLab, Outline and Cloudflare are left to the server. |
| P5 | Cloudflare: API and docs on, **deprecated** Developer Platform and Observability off but present. | The owner uses the Developer Platform connector; Cloudflare says to migrate to the API server. |
| P6 | Conventional secret names (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `GITEA_TOKEN`, `OUTLINE_API_KEY`, `CLOUDFLARE_API_TOKEN`). | The name an admin most likely already has in Secrets & env, so the Add flow shows "exists". Changeable per Add. |
| P7 | The stand-in is TypeScript with an esbuild bundle for containers. | One source for the portal's tests and for B3's runs, following `ci/runner/build.ts`. |

## 9. What only a real account can confirm (🔬)

| What | Where it matters | How |
| --- | --- | --- |
| A GitLab personal access token, as `Bearer`, against `/api/v4/mcp`; and whether GitLab registers the client Claude Code sends (`none`) | GitLab token mode (P2), GitLab OAuth | One `curl` with a PAT and `initialize`; one sign-in from a workspace |
| The Gitea round trip: the app with `http://localhost:24819/callback`, sign-in, the 1-hour token refreshing, a personal access token as `Bearer` through the sidecar | Gitea OAuth and token | Create the public app (`tea api` recipe in the notes), add the built-in, assign, sign in |
| Outline: registration of `http://localhost:<port>/callback`, sign-in, rotation under Claude Code | Outline OAuth | Add the built-in for docs.isnan.me, sign in |
| Cloudflare: whether the consent screen lets the person grant more than the two scopes Claude Code asks for (writes need them), the `offline_access` refresh, an API token on the deprecated servers, `cf-account-id` | Cloudflare OAuth and token | Add, sign in, call `whoami`, then try a write |
| GitHub: which PAT type and permissions each tool needs; `ghe.com` paths | GitHub notes | A fine-grained token against `/mcp` and `/mcp/readonly` |
| Every provider: Claude Code against the **real** servers (so far only against the stand-in) | all | A person signs in from a workspace |

## 10. Testing and verification

- **Observed** (2026-10-12): the probes of §5 against GitHub, GitLab, Cloudflare (API, docs, bindings,
  observability), the owner's Gitea MCP and Gitea, the owner's Outline and `app.getoutline.com`; every documentation
  URL a template cites answered 200 on a plain GET (redirects followed).
- `providers/providers.test.ts` (11 tests): the registry accepts all five; keys unique and at most 16; every URL
  https, fills from defaults, none on Anthropic hosts; the pinned decisions of §3 and §5 (GitHub token only,
  GitLab optional client ID, Gitea defaults, scopes and discovery URL, Outline's URL fill, Cloudflare's server
  set and the docs server offered in both modes); no secret anywhere; the text diet limits; the presets mirror
  the templates.
- `testkit/provider.test.ts` (25 tests), driven by the MCP SDK's own client and OAuth code and by plain HTTP:
  every preset served to the SDK client with a static bearer; the wire (JSON and SSE, 202, 405, `server/discover`
  `-32601`, batches); each preset's 401 challenge against the strings observed in §5; discovery per preset
  (including OIDC-only and the issuer with a path); full sign-ins with dynamic registration (public and
  confidential) and with a pre-registered client, expiry and refresh with rotation, revocation; refusals
  (https and non-loopback redirects, unregistered redirect addresses, PKCE, `state`, replayed and expired codes,
  wrong secrets, the registration limit); hostile modes (a mismatched `iss` or issuer is caught by the SDK);
  the log keeps no secret; https; the standalone bundle run under plain `node` and steered over HTTP.
- A real Claude Code 2.1.296 against the standalone bundle in a throwaway workspace container: the table in §6. It
  was removed afterwards, with its temporary files.
- Not covered: Claude Code against the real providers (§9), and any consent screen.

## 11. Milestones

| Milestone | Scope | Status |
| --- | --- | --- |
| P1 | Research and the five definitions | **Built.** `providers/{github,gitlab,gitea,outline,cloudflare,common,index}.ts`, 11 tests, all five pass the registry's start-up validation. Facts ✅ and 📄 as in §5; 🔬 in §9. |
| P2 | The stand-in provider | **Built.** `testkit/{types,presets,provider,cert,cli,build,index}.ts`, 25 tests, and ✅ run against a real Claude Code 2.1.296 in a workspace container (§6): sign-in, refresh and expiry, https with `authServerMetadataUrl`, header tokens, the GitHub-style refusal. B3's findings are folded in (OIDC `jwks_uri`, https, `server/discover`, the registration request). |
| P3 | Confirmation against the real providers | Not built: §9, needs accounts. |

## 12. Open questions

1. Should GitHub get a host param for Enterprise Cloud with data residency once someone needs it? (P1: no until then.)
2. Do the deprecated Cloudflare servers stay when Cloudflare removes them? The `version` bump and "Update" cover it;
   a probe in CI would catch a 404 earlier but would call third parties on every run (A.7 allows it by hand only).
3. A "toolsets" choice for GitHub (`X-MCP-Toolsets`) and GitLab (`X-Gitlab-Enabled-Mcp-Server-Toolsets`) would
   need non-secret header slots in the templates; the contract has only the token header today.
