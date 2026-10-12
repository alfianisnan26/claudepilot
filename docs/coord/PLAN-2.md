# Round 2 plan: built-in MCP catalogue (OAuth preferred) + workspace git (coordinator: the main session)

COORD = /tmp/claude-1000/-workspaces-claudepilot/cad07383-74ea-4f0a-88e5-fc51c5b7a125/scratchpad/coord
Read this whole file, then PLAN.md sections 4 (non-negotiables), 5 (recipes), 6 (protocol), 7 (definition of done). They all still apply, amended by section A below.
The coordinator may edit this file; re-read it before each new work item and read your COORD/inbox-<id>.md.

## 0. The owner's asks (2026-10-12; the owner writes casual Indonesian, translated)

1. "help to add built in catalogue of mcp set (oauth preferable): github, gitlab, gitea (our, based on isnan-cluster approach), outline, cloudflare. do work using multi agents."
2. "read the isnan cluster in the neighbouring workspace, not directly from its MCP either." Done by the coordinator: the digest is section 3. You may read more with COORD/ro-mount.sh (section A.6).
3. "git in a workspace can be scanned automatically: say the agent inside turns out to be a pool of repos like konfersi-universe; since there are submodules that all have git trees, each can be tracked on its own, and working trees can be created directly and kept synced, so we can audit and monitor."
Standing directives still apply, above all the UI TEXT DIET (PLAN.md rule 12): less text, fewer components, tooltips (InfoTip) for explanations, phone first.

## A. Amendments to PLAN.md

1. The owner's dev portal (:3000, tmux `portal`, `.data`) is STOPPED by the coordinator on purpose: it runs `tsx watch` and would apply half-finished migrations to their real database. Never start it, never read or touch `.data`, `.env`, `deploy/.env`. Use your own scratch portal (PLAN.md section 5; ports below). The coordinator restarts theirs at the end.
2. Git is READ-ONLY for you (PLAN.md rule 1). The coordinator commits at the end.
3. The highest migration used so far is in A6's block (90-99); round 2 blocks start at 100. Your migration block is in the roster; append only; migrations never edited once written (a scratch data dir lets you iterate: delete it to re-run).
4. Memory: this machine has about 7 GB free; up to four agents run at once. One scratch portal, one Chromium and at most one workspace container of yours at a time; stop them when idle (`tmux kill-session -t <prefix>portal`). The previous round left 1.1 GB of /tmp junk (cpb-profile-*, cp-chat-*, qa* ...): delete what YOU made (your prefix only, never wildcards that match others) before your final report, and use a `trap` or a cleanup step for temp dirs.
5. Usage-limit economy (the last round died on the account's session limit): read with grep/sed ranges, not whole big files; run targeted tests while iterating and the full server suite ONCE at the end; no polling loops; keep status files and reports short. If you hit a 429 / "usage limit" error, do not retry in a loop: write RESUME HERE (what is done, the exact next step) into your status file, then stop with a short final report.
6. Docker: the daemon you reach by default (`docker ...`, no `--context`) is the dev container's own DinD: use it with your prefix (PLAN.md rule 7). NEVER use `--context host` (the owner's real Docker: their deployed portal, caddy, other projects) except through COORD/ro-mount.sh, which runs a throwaway container with NO network and a READ-ONLY mount of exactly one of the owner's neighbouring folders: `isnan-cluster` or `konfersi-universe` (`COORD/ro-mount.sh isnan-cluster '<cmd, cwd=/c>'`; `IMG=<local image>` picks another image, e.g. one with git). Rules for what it reveals: never read or print secrets (`vault-init-output.json`, `secret-*.yaml`, `*.env`, kubeconfigs, tokens, keys, anything in `.git/` config with credentials); mask values when you print manifests; never copy secret values or private repo content into the repo, the PRDs, tests or reports (paths, structure, public hostnames and non-secret settings are fine; konfersi-universe: git metadata only, no file contents).
7. Third parties: no real credentials, no sign-ins, no registrations. Reading public documentation (WebSearch / WebFetch) is fine. Harmless unauthenticated discovery probes are fine on the providers' public hosts and the owner's public MCP hosts: GET `/.well-known/oauth-protected-resource*`, `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`, and one unauthenticated MCP `POST` (initialize) to see the 401 challenge. NEVER POST to a registration endpoint (that creates a client at the provider) and never send any token.
8. `references/` at the repo root is the owner's pre-existing material: not yours, do not touch.
10. KUBERNETES SAFETY (applies to every round): this sandbox has KUBECONFIG set to the owner's REAL cluster `home-isnan-cluster`, and the server enables its Kubernetes target when KUBECONFIG is set. A scratch portal MUST run with `unset KUBECONFIG KUBERNETES_SERVICE_HOST` and `PORTAL_K8S_ENABLED=false` (the PLAN.md recipe now has both; restart yours if it was started without them and say so in your status file). Never run kubectl, helm or any client against the default context; Kubernetes work uses `--kubeconfig <your own throwaway file>` for a throwaway local test cluster only, or fakes. Never create or remove a Kubernetes workspace from a scratch portal.
11. CLEAN ENVIRONMENT (applies to every round; incident of 2026-10-12): the environment of every agent's shell carries the owner's credentials and sockets (CLAUDE_CONFIG_DIR = the owner's Claude profile, CLAUDE_CODE_MESSAGING_TOKEN/SOCKET, CLAUDECODE, SSH_AUTH_SOCK, KUBECONFIG). A scratch portal MUST be started with `env -i PATH=$PATH HOME=/tmp/<prefix>home ...` (the PLAN.md section 5 recipe now does); the 'This machine' local target (PORTAL_LOCAL_ENABLED=true) runs `claude` on the host, so enable it ONLY with HOME and CLAUDE_CONFIG_DIR under /tmp/<prefix>home. Tests that spawn `claude` or `ssh` must set their own HOME/CLAUDE_CONFIG_DIR. Never use SSH_AUTH_SOCK, ~/.ssh*, ~/.ssh-host, ~/.host-secrets, ~/.claude* or ~/.gnupg; generate throwaway keys. This supersedes the `unset KUBECONFIG ...` form of A.10 (env -i also removes KUBECONFIG).
9. Shared-file etiquette is PLAN.md section 2: surgical edits, re-read right before editing, never reformat. New pool kinds are NOT needed this round.

## 1. Roster, areas, ports

| Id | Role | Edit rights (new files here are yours) | Portal port | CDP port | Prefix | Migrations |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | Built-in catalogue core (server, contracts, PRD) | apps/server/src/mcp/builtin/** (new except providers/ and testkit/), apps/server/src/mcp/{routes,index}.ts and catalog.ts surgically, packages/contracts/src/mcp.ts (the built-in part), the Portal MCP read tool in apps/server/src/portalmcp/tools/ (new file), NEW docs/prd/mcp-builtin-catalogue.md | 3201 | 9331 | bc- | 100-109 |
| B2 | Providers: research, definitions, stand-ins | apps/server/src/mcp/builtin/providers/** and apps/server/src/mcp/builtin/testkit/** (new), NEW docs/prd/mcp-providers.md | 3202 | 9332 | bp- | none |
| B3 | OAuth status and sign-in (PRD mcpset-pool M2, Q2) | apps/server/src/mcp/oauth/** (new), apps/server/src/mcp/{kind,compile,index,jobs}.ts surgically, contracts mcp.ts (auth status part), docs/prd/mcpset-pool.md (13.3, M2, Q2) | 3203 | 9333 | bo- | 110-119 |
| B4 | Catalogue web UI | apps/web/src/features/mcp/** (the built-in shelf, add dialog, auth status chips, sign-in dialog) | 3204 | 9334 | bu- | none |
| G1 | Workspace git: scan, track, worktrees, audit, monitor (server) | apps/server/src/repos/** (new), contracts repos.ts (new), images/workspace/cp-session via chat/host.ts surgically, apps/server/src/chat/worktrees.ts surgically, a Portal MCP read tool file (new), NEW docs/prd/workspace-git.md | 3205 | 9335 | gt- | 120-129 |
| G2 | Repos web UI | apps/web/src/features/repos/** (new), one tab entry in the workspace page, a summary chip in the workspace list row | 3206 | 9336 | gu- | none |
| Q2 | QA round 2 (starts last) | docs/qa/**, tools/qa/**, apps/server/src/qa/** | 3207 | 9337 | q2- | none |

Waves: wave 1 = B1, B2, B3, G1. B4 and G2 start when the coordinator sees the server side answering (the coordinator spawns them). Q2 at the end.
Needs a change in someone else's area: outbox line (PLAN.md section 6), never edit it yourself.

## 2. Decisions the coordinator took on the owner's behalf (provisional; list them in your report if you rely on them)

D1. OAuth is the NATIVE Claude Code flow in each workspace (PRD mcpset-pool 13.3): the portal never stores, refreshes or relays OAuth tokens or client secrets (PRD section 6 stays). "OAuth preferred" means: a template offers `oauth` first wherever the provider supports it WITHOUT a client secret (dynamic client registration, or a public PKCE client whose ID is non-secret), and `token` (a header slot filled from Secrets & env) as the fallback. A provider that needs a client secret is token-only, and says so.
    Facts behind it: `claude mcp login [--no-browser] <name>` exists in 2.1.296 (prints the authorization URL, takes the redirect URL pasted back); `claude mcp add` takes `--client-id`, `--client-secret`, `--callback-port`. The owner's own MCP servers accept only claude.ai/claude.com and http loopback as redirect URIs (their coder-desktop-mcp), so a portal-hosted https callback would be refused by servers like theirs; the loopback flow in the workspace is accepted. Chat sessions run `claude -p`, which cannot complete OAuth: sign in once per workspace through the guided flow (B3); the stored token is then used and refreshed by Claude Code itself (to verify in B3's experiment, Q2).
D2. Built-ins are code-defined TEMPLATES (reviewed by the portal's authors, versioned). "Add" instantiates a template into the existing catalog (entries with approved versions, reviewer "Admin", note "Built-in catalogue v<N>") and creates a set (pool item of type mcpset) with its servers. The exact URL (and headers/OAuth fields, risk flags) is shown BEFORE adding (PRD FR3): that is the consent. No existing safeguard is relaxed: URL checks and the SSRF guard (`assertPublicUrl`), `allowPrivateNetwork` only on an explicit tick, FR19 allowlist matchers, immutable approved versions, "Upgrade available" for a newer template version. An agent or token can never add or approve a built-in (it may only PROPOSE a draft through the existing flow); approval is a person in the portal.
D3. Per-instance values (a Gitea or Outline host, a GitLab host, an OAuth client ID) are non-secret PARAMS asked at Add time. Several instances of one template are allowed (the instance name is part of the entry key and set name).
D4. Secret slots (the token fallback) are referenced as `{{secret-file:NAME}}` with a suggested NAME (for example GITHUB_TOKEN); the Add flow shows whether that name exists in Secrets & env and links there; it never takes a token value.
D5. Gitea is "ours": defaults point at the owner's Konfersi instance (section 3) and every default is overridable.
D6. Workspace git (G1): read-only scanning always; "sync" is fast-forward-only on a clean worktree and only when asked or opted in per worktree; never merge, rebase, stash, reset, clean or force anything on its own. Worktrees are created through the existing hardened session host (chat/worktrees.ts, chat/host.ts: no hook, filter or fsmonitor of a repository ever runs).

## 3. Facts from the owner's cluster repo (read-only, masked; this is the "isnan-cluster approach")

- Gitea MCP (konfersi-infra/gitea/gitea-mcp.yaml): image `gitea/gitea-mcp-server:1.8.0`, args `-t http -b 127.0.0.1 --port 8080 -H https://git.konfersi.com -oauth -oauth-public-url https://gitea-mcp.konfersi.com`; public URL `https://gitea-mcp.konfersi.com/mcp` (Cloudflare tunnel to Traefik). In `-oauth` mode there is NO static token: every request carries the caller's own Gitea OAuth access token, so each person sees what their Gitea account sees. The MCP serves RFC 9728 metadata (`/.well-known/oauth-protected-resource[/mcp]`) naming Gitea as the authorization server. Gitea has NO dynamic client registration: a client needs the client ID of a PUBLIC (PKCE) OAuth2 app created by hand in Gitea (theirs: "Claude MCP (gitea-mcp.konfersi.com)"; no secret). Scopes: `write:repository write:issue write:user write:organization write:notification write:package write:misc`. Gitea access tokens last 1 hour. gitea-mcp itself never answers 401 for a bad token (200 with a tool error), so an nginx sidecar validates the bearer against Gitea `GET /api/v1/user` (30 s cache) and returns `401` + `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="https://gitea-mcp.konfersi.com/.well-known/oauth-protected-resource/mcp", scope="..."` so clients refresh.
- Static-token variant: their Hermes agent (isnan-infra/hermes) talks to a gitea-mcp sidecar (`http://127.0.0.1:8080/mcp`) with an `Authorization` header token of a dedicated Gitea user. A Gitea access token as `Bearer` is therefore a plausible token fallback for the same URL (B2 to confirm from the gitea-mcp docs).
- Gitea is the SSO IdP for the isnan.me apps: OAuth2/OIDC at `/login/oauth/{authorize,access_token,userinfo}`, discovery at `/.well-known/openid-configuration`; OAuth2 apps are created through Gitea's REST API: `tea api --login <login> /user/applications/oauth2 -f name=... -F redirect_uris='["..."]' -F confidential_client=false` (false = public/PKCE). Instances: git.isnan.me, git.konfersi.com (and a kohilabs one).
- Outline has a BUILT-IN MCP endpoint at `<outline-url>/mcp` (docs.isnan.me/mcp); Hermes uses it with an API key in `Authorization`. Outline instances: docs.isnan.me (login via Gitea), Konfersi and Kohilabs (login via Authentik).
- The owner's own MCP servers in the cluster: coder-desktop-mcp (`https://desktop-mcp.isnan.me/mcp`, `auth: oauth`; the server is itself an OAuth 2.1 server for MCP clients with DCR + PKCE, accepting only claude.ai/claude.com callbacks and http loopback), admin-mcp (grafana, n8n, proxmox, argocd, kubernetes), discord-mcp, an in-cluster gitlab-mcp (port 3002, token from a Secret).
- Cloudflare: their claude.ai connectors are "Cloudflare API" (tools docs, execute, search, whoami) and "Cloudflare Developer Platform" (d1, kv, r2, workers, hyperdrive, docs search): the official remote servers.
- Claude Code 2.1.296 facts above (D1). The existing PRD for the pool: docs/prd/mcpset-pool.md (catalog FR1-FR5a, secrets 11, OAuth 13.3, milestones 19, Q2).

## 4. Draft contract for the built-in catalogue (B1 owns it; B1 lands it in packages/contracts/src/mcp.ts FIRST, within the first ~20 minutes, then says so in outbox-b1.md; others may start from this draft; additions are optional fields, nothing is renamed or removed without telling the others through the coordinator)

```ts
export type McpBuiltinAuth = 'oauth' | 'token';           // how a person signs in; OAuth is the native flow in the workspace

export interface McpBuiltinParam {                         // a non-secret value asked once per instance
  key: string;                                             // used as {key} in a server url
  label: string;                                           // one or two words
  hint?: string;                                           // InfoTip text, never inline
  kind: 'url' | 'text';
  required: boolean;
  placeholder?: string;
  default?: string;
  auth?: McpBuiltinAuth;                                   // asked only in this mode (a client ID only for OAuth); default both
}

export interface McpBuiltinServer {                        // becomes one catalog entry and one server in the new set
  key: string;                                             // suggested server key (FR5)
  name: string;
  description: string;
  url: string;                                             // {param} placeholders; the result passes the catalog's URL checks
  transport: McpTransport;
  oauth?: { dcr: boolean; clientIdParam?: string; scopes?: string[]; callbackPort?: number; authServerMetadataUrl?: string };
  token?: { header: string; template?: string; slot: string; description?: string; docUrl?: string };
  default: boolean;                                        // included by default (the person can untick)
}

export interface McpBuiltinTemplate {
  id: 'github' | 'gitlab' | 'gitea' | 'outline' | 'cloudflare';
  name: string;
  icon: McpBuiltinTemplate['id'];                          // web draws an inline SVG per id; no external images
  summary: string;                                         // one short line
  docUrl: string;
  auth: McpBuiltinAuth[];                                  // preference order, OAuth first where it works without a client secret
  params: McpBuiltinParam[];
  servers: McpBuiltinServer[];
  notes: string[];                                         // short lines for an InfoTip (prerequisites, how to register the OAuth app)
  version: number;                                         // bumps when the definition changes
  checkedAt: string;                                       // YYYY-MM-DD the facts were checked against the provider's docs
}

export interface McpBuiltinAdded {                         // one instance made from a template
  poolId: string; poolName: string; entries: string[];
  auth: McpBuiltinAuth; params: Record<string, string>;    // non-secret only
  templateVersion: number; updateAvailable: boolean; addedAt: string;
}
export interface McpBuiltinItem { template: McpBuiltinTemplate; added: McpBuiltinAdded[] }
export interface McpBuiltinAddRequest { auth: McpBuiltinAuth; params: Record<string, string>; servers?: string[]; name?: string; secretNames?: Record<string, string> }
export interface McpBuiltinPreview { servers: { key: string; url: string; headers: string[]; oauth: McpOAuthFields | null; flags: McpRiskFlag[] }[]; secretNames: { slot: string; name: string; exists: boolean }[] }
// routes: GET /api/mcp/builtin -> McpBuiltinItem[]; POST /api/mcp/builtin/:id/preview and /add (bodies McpBuiltinAddRequest) -> McpBuiltinPreview / McpBuiltinAdded
```

B3 adds, in the same file (its first deliverable, announced in outbox-b3.md):

```ts
export type McpAuthState = 'connected' | 'needs_sign_in' | 'failed' | 'unknown';
export interface McpServerAuth { mode: McpAuthMode; state: McpAuthState; detail: string | null; checkedAt: string | null }
// McpServerStatus gets `auth?: McpServerAuth` (null/absent for none and headers servers)
// sign-in (guided, native): POST .../workspaces/:id/signin {plugin,key} -> { signInId, url, expiresAt };
//   POST .../signin/:signInId/complete { redirectUrl } -> McpServerAuth; DELETE .../signin/:signInId cancels. The redirect URL carries the
//   authorization code: used once, never stored, never logged.
```

## 5. Assignments

### B1: catalogue core
1. FIRST the contracts (section 4) and a new PRD docs/prd/mcp-builtin-catalogue.md skeleton (summary, flow, API, data, FRs in the house style, status/milestones table). Tell B2 and B4 via outbox-b1.md when the types are in.
2. apps/server/src/mcp/builtin/: `registry.ts` (the templates come from B2's providers/*.ts; until they exist, a tiny fixture template for your tests), module-load validation of every template (placeholders resolve, URL checks, key lengths, slot rules) and a unit test that instantiates each real template with sample params through the catalog's own parse/validation; `instantiate.ts` (preview = exact URL, headers, OAuth fields, risk flags; add = create entries as approved versions with the built-in note, create the set with the servers and secret references, idempotent: the same template and params reuse entries and never duplicate a set; a template version bump offers a new catalog version through the normal draft/approve flow and drives `updateAvailable`); `routes.ts` mounted under the existing MCP routes; a migration (100-109) for `mcp_builtin_instances` (template id and version, params JSON, auth, pool id, entry ids, added_at/by; nothing secret); audit events like the rest of the catalog; a Portal MCP read tool `mcp_builtin_list` through the registry (read scope) and, if cheap, `mcp_builtin_propose` that only creates drafts through `proposeEntry` (never approval).
3. Tests (server), PRD status notes, README index line. Verify through your scratch portal: list, preview, add (OAuth and token modes, each template with sample params), add twice (idempotent), a set appears in the Pools hub, assignment to a test workspace compiles (the compiler output for an oauth server carries clientId, callbackPort, scopes, authServerMetadataUrl and a token server a headers helper entry), a revoked built-in entry stops delivering.

### B2: providers
1. Verify each provider's real facts from official docs and read-only discovery probes (A.7). For each: remote MCP URL(s) (SaaS and self-hosted variants), OAuth style (DCR / pre-registered public PKCE / needs a client secret, so token-only), scopes, redirect rules, token header format for the fallback, per-instance params, min versions or feature flags, known quirks. Mark every fact in docs/prd/mcp-providers.md: ✅ observed (probe or run), 📄 documented, 🔬 unverified; give the source URL and `checkedAt`.
   - GitHub: the remote server (api.githubcopilot.com/mcp/ and its read-only and toolset variants), whether any secretless OAuth path exists for a third-party host (DCR, CIMD, device flow); otherwise token-only with the PAT slot (the Secrets & env "GitHub login" is the natural source, see mcpset-pool.md section 11).
   - GitLab: the built-in MCP server (`/api/v4/mcp`, GitLab.com and self-managed, version and flag requirements), OAuth (DCR) and the PAT fallback; the owner's in-cluster community gitlab-mcp is NOT the target (mention only).
   - Gitea ("ours"): from section 3. Params: baseUrl (default https://git.konfersi.com), mcpUrl (default https://gitea-mcp.konfersi.com/mcp), clientId (OAuth only, required; a short note how to create the public PKCE app with `tea api`/UI and which redirect URI Claude Code uses, with a FIXED callbackPort because a pre-registered redirect needs one; coordinate the port and path with B3's experiment). `authServerMetadataUrl` = Gitea's discovery document if Gitea has no RFC 8414 endpoint. Token fallback: a Gitea access token as Bearer on the same URL, if the docs support it. Record the sidecar's 401 behaviour in a note.
   - Outline: the built-in MCP endpoint `<outline-url>/mcp`: how it is enabled, OAuth support (DCR? Outline's OAuth apps?) and API-key Bearer; param outlineUrl.
   - Cloudflare: the official remote servers (Cloudflare API with search/execute; Developer Platform/bindings; docs; observability and the others worth including), OAuth with DCR and the API-token fallback, which are default-on, account selection quirks. A multi-server template (the person unticks what they don't want).
2. Write apps/server/src/mcp/builtin/providers/{github,gitlab,gitea,outline,cloudflare}.ts (each exports one `McpBuiltinTemplate`) and an `index.ts` list, against section 4's types (B1 lands them; align when it does). Short copy only (text diet): names, one-line summaries, InfoTip notes.
3. apps/server/src/mcp/builtin/testkit/: a stand-in provider server for tests (B1, B3 and Q2 use it): MCP streamable-HTTP `initialize` + `tools/list` behind a bearer, the 401 + `WWW-Authenticate: Bearer resource_metadata=...` challenge, RFC 9728 and RFC 8414/OIDC metadata, an authorization server with authorize and token (PKCE S256, refresh), optional DCR (RFC 7591), loopback-only redirect enforcement, a switchable "bad token answers 200" quirk like gitea-mcp. Presets per provider style (gitea-like: public client, no DCR; gitlab/cloudflare-like: DCR; github-like: token only). Small, documented, tests for the kit itself.
4. Report what is 🔬 for the owner (things only a real account can confirm).

### B3: OAuth status and sign-in
1. EXPERIMENT FIRST (PRD Q2, 🔬), using B2's stand-in provider (until it exists, write a minimal one of your own and hand it to B2) and a real Claude Code 2.1.296 in ONE workspace container of yours (image `claudepilot-workspace:latest`): deliver an oauth server through the existing pipeline; observe `claude mcp list` / `claude mcp get` output for a server that needs sign-in; run `claude mcp login --no-browser <name>` under the runtime's exec (what it prints, whether it takes the pasted redirect URL on stdin, the redirect URI and path it uses with and without `--callback-port` and with `oauth.callbackPort` in `.mcp.json`, where it stores the token, whether the token survives a workspace restart, whether a `claude -p` run then connects and refreshes an expired token, whether a plugin-provided server name works). Record each result with the ✅/🔬 marks in mcpset-pool.md 13.3 and Q2, with the actual output.
2. Build from what you observed: the contract (section 4), a portal check that fills `McpServerStatus.auth` for oauth servers (after delivery and verify and on demand; parse of the workspace's own `claude mcp list/get`), the guided sign-in endpoints driven through the runtime's exec (start returns the URL; complete takes the pasted redirect URL; cancel; timeouts and cleanup of the login process; `code` and `state` never logged or stored; add the redaction pattern if needed), sign-out if Claude Code offers one, and a minimal seam so a chat session whose OAuth server needs sign-in surfaces "Sign in to <server>" (through A2's notice mechanism; surgical, tell B4). Tests with the stand-in. Prefer no migration (cache in memory); if you need one, block 110-119.
3. PRD: update mcpset-pool.md (13.3, M2 row, Q2) honestly: Built / Partly built / Not built, with what you observed.

### G1: workspace git (server)
Requirements, in priority order (R1-R4 first, a verified smaller increment beats a sprawling one):
R1 Discovery: find the git repositories inside a workspace automatically, without registration: under configurable roots (default the work/project folders under the home directory; excludes node_modules, caches, .claude, ...), bounded (depth, time, count) so a huge tree cannot hang. Detect normal repos, submodules (`.git` file with `gitdir:`), linked worktrees, nested repos that are not declared submodules, and submodules declared in `.gitmodules` but not cloned.
R2 Tree and identity: a stable id per repo and its relations (superproject to submodule, repo to worktrees, nested), so a pool-of-repos workspace (konfersi-universe: one parent with many submodules, or a folder of sibling repos) is shown as a tree and every repo is tracked on its own.
R3 State per repo, cheap and read-only through the hardened session host: branch or detached, HEAD (sha, subject, date), upstream and ahead/behind, dirty counts (staged, unstaged, untracked, conflicted), stash count, remotes with credentials removed, submodule drift (checked-out sha differs from the recorded one), worktrees.
R4 Tracking over time: scans on demand, at workspace start, around sessions, and on a timer while the workspace runs (budgeted, jittered, skipped when stopped); current state persisted plus an EVENT log (the audit): discovered, removed, branch changed, HEAD moved (commits count, authors, clipped subjects; attributed to a session when one ran in that repo or worktree), clean/dirty transitions, upstream diverged, worktree added/removed/synced, submodule drift, scan failed. 90-day retention, text clipped and redacted (chat/redact.ts).
R5 Worktrees: create one for any tracked repo (branch and base validated by chat/worktrees.ts's checks, through the same hardened host), linked into the tree; "keep synced" is opt-in per worktree and means fetch + fast-forward-only when clean (D6), always showing ahead/behind/diverged/dirty instead of acting on them. Reuse A2's session worktrees: they appear in the tree too.
R6 Audit: every portal-initiated git action (worktree create/remove/sync, scan requests by a person) is an event with its actor (person, session, ticket, agent token).
R7 Monitor: a per-workspace and a global summary (repos, dirty, ahead/behind, diverged, detached, unpushed, not-cloned submodules) with an "attention" ordering; Portal MCP read tools (`repos_list`, `repo_get`, `repo_events`, `repos_attention`) and, at operate scope, `worktree_create` (an agent token only in its own workspace).
R8 Safety: everything from a workspace is untrusted text (branch names, subjects, paths, remote URLs): validate, clip, escape; no fetch unless asked; no credentials; bounded resource use; works on the Docker and local targets (Kubernetes is unsupported everywhere).
Contracts: a new packages/contracts/src/repos.ts with REPOS_API; land it FIRST and say so in outbox-g1.md (G2 and the coordinator wait for it). PRD: NEW docs/prd/workspace-git.md (house style, status table). The host script change (chat/host.ts to images/workspace/cp-session: `npm run gen:workspace-host -w @portal/server`) must reach existing workspaces: find out how the portal refreshes cp-session in running workspaces and say what an existing workspace needs (an image rebuild, or a push at the next session start). Verify with synthetic fixtures (a superproject with three submodules, a nested repo, a linked worktree, a bare remote) in your scratch workspace, and, for realism, run the scan read-only over the owner's real pool repo with `COORD/ro-mount.sh konfersi-universe` (an image that has git via IMG=...; `git -c safe.directory='*'`; metadata only, summaries only in your report).

### B4: catalogue UI (spawned by the coordinator once B1's routes answer)
In apps/web/src/features/mcp/: a "Built-in" shelf at the top of the MCP catalogue (five cards: inline icon, name, one line, ⓘ for notes; one action: Add, or Added with Update when the template is newer); the Add dialog (a segmented `OAuth | Token` with OAuth first where offered, the params as bare labelled fields, the server list with toggles only for multi-server templates, the exact URL in one copyable line, token mode shows the Secrets & env name and whether it exists, primary action Add; then "Assign" straight into the existing assign dialog); auth status chips for oauth servers where the MCP status shows (Connected / Needs sign-in) and a "Sign in" dialog (open link, paste the redirect URL, done), using B3's endpoints. Text diet; 390 and 1280 px, light and dark; look at screenshots before reporting.

### G2: repos UI (spawned once G1's contract and routes exist)
In apps/web/src/features/repos/: a Repos tab on the workspace page (tree of repos: submodules and worktrees indented, one row each: name, branch, compact status chips with tooltips, a ⋯ menu: Scan, New worktree, Sync), a repo sheet (HEAD, remotes, worktrees, event timeline with filters), a "needs attention" chip on the workspace list row. Text diet; phone first; screenshots before reporting.

### Q2: QA round 2 (the coordinator spawns it last)
Regression over the integrated tree, UI at 390 and 1280, security review of the new surfaces (SSRF on built-in URLs and params, params injection into URLs and headers, redirect-URL handling in sign-in, secrets in logs, untrusted git text), accessibility, text diet; findings into docs/qa/qa-report.md with severity and owner.

## 6. Reporting

Status file (overwrite, at most 40 lines, with a RESUME HERE block) at every milestone; outbox for requests; final report as PLAN.md section 7. The coordinator reads status files and the outbox (a watcher prints new outbox lines).

12. HEAVY JOBS ARE SERIALISED (2026-10-12, after the machine hit load 20 and 2.5 GB free with 27 concurrent `tsc` processes): any root or workspace `tsc --noEmit`, any full test suite and any production build runs under ONE shared lock and low priority: `flock COORD/heavy.lock nice -n 10 <command>` (COORD/heavy.lock exists; if you wait long, that is the point). Targeted tests of your own files (a single module glob) are exempt. Do not re-run a whole typecheck after every small edit: typecheck once per stable point.

### A.13 (2026-10-12, from S1): never label a throwaway container `claudepilot.managed`
Every scratch portal on this machine talks to the SAME default (DinD) docker daemon and discovers workspaces by the label `claudepilot.managed`. A rig, canary or test container carrying that label is polled by OTHER agents' scratch portals (usage probes, hooks, health checks run inside it). Scratch containers use your own prefix and your own labels (e.g. `<prefix>.rig=1`), never `claudepilot.managed`, unless the test needs exactly that and it runs in your own portal's private data dir with a unique label VALUE you filter on; remove them when done.
