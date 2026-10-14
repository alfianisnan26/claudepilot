# PRD: Secrets & env pool

| | |
| --- | --- |
| Status | **Draft v0.5**, revised after the cross-PRD review. **S1 built** on Docker and checked with a real Claude Code 2.1.296 in a Docker workspace (§15); parts of S2 built (§15). ✅ = observed in our experiments (Docker 29.9, Claude Code 2.1.296, fake values). 📄 = documented, not observed by us. 🔬 = unverified, listed in §18. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-12 |
| Depends on | [Pools foundation](foundation-pools.md) (storage, encryption, revisions, delivery engine, ownership §7), [Settings & policies](settings-policies.md) (effective sandbox policy, §10.4) |
| Related | [MCP set](mcpset-pool.md) (references secrets by name), [Account Pool](account-pool.md) (owns Anthropic credentials), [Portal MCP server](portal-mcp.md) (secret links), [Monitoring dashboard](monitoring-dashboard.md) (deny hits, metrics), [Chat sessions](chat-sessions.md) (shared redactor) |

## 1. Summary

Secrets & env lets admins define named **secret sets** of plain variables, secrets and tool logins
(GitHub `gh` and `git`, npm, container registries, AWS, Google Cloud, SSH, kubeconfig) and assign
several to a workspace. Delivery is native and push-only. Secrets are files under
`/etc/claudepilot/secrets/` that tools re-read on every call, so a rotated token works on the next
command. Plain variables go into the pool's managed-settings drop-in, re-applied live, and a profile
script for terminals. A secret is a variable only if the admin opts in.

The pool also writes deny rules, and sandbox credential rules where the policy runs the sandbox.
None is a boundary while users have `sudo`, so the design relies on least privilege, short-lived
per-workspace tokens, fast rotation and a record of where each value went.

## 2. Background and problem

- Credentials get into workspaces by hand: `gh auth login`, tokens in `~/.npmrc`, keys in `~/.ssh`.
  They sit unencrypted on the home volume with no inventory, rotating one means visiting every
  workspace, and these copies keep winning after a portal takes over (§10.6).
- Container env, the obvious channel, freezes each value until a recreate or restart (§10.1).
- Claude Code runs commands with the user's rights: whatever a tool can authenticate with, the agent
  can read, print or send out, and prompt injection can ask it to. ✅ Without the OS sandbox,
  `python3`, `grep -r` and command substitution read files that deny rules cover (lab).
- The user asked for a "secrets and env pool", including `gh`.

## 3. Goals

| ID | Goal |
| --- | --- |
| G1 | **Sets.** Create, version and assign named sets of variables, secrets and tool logins. A workspace can use several sets. |
| G2 | **Tools just work.** `git`, `gh`, `npm` and `ssh` (all in the image) authenticate with no manual login for Claude Code, in the portal terminal and in interactive bash, on all three targets. For tools users install (AWS CLI, `kubectl`, gcloud and Google libraries, docker, podman), the portal writes their standard files and pointers, tested at pinned versions (S2). |
| G3 | **Live rotation.** A rotated secret reaches running workspaces without a restart, and the admin sees which workspaces have it and when the old value is safe to revoke. |
| G4 | **References.** Other pools (MCP sets first) use a secret by name, never by copying it. One value feeds every consumer. |
| G5 | **Honest protections.** Deny rules and sandbox credential rules cover everything delivered, each labeled with what it covers and whether the workspace enforces it. |
| G6 | **Secrets stay secret in the portal.** Encrypted at rest, write-only, masked, never logged (FR11). |
| G7 | **Traceability.** For any secret value, the portal shows every workspace that received it, when, and whether it was removed. |

## 4. Non-goals

- **Protecting secrets from workspace users** (they have `sudo`, Pools foundation §2) **or portal
  users**, who can all open a shell in any workspace. The locked image is Settings & policies'.
- **Anthropic and Claude credentials** (§6). Every `sk-ant-` value is refused, even a key for an app
  the workspace builds: it would reach every process, Claude Code included.
- **A secrets manager** (leasing, scanning, vault sync), **writing into the home folder** (§10.6
  only reports it), **container env** (§10.1), **per-user secrets** and **terminal output masking**.

## 5. Users and stories

**Admin** manages sets. **Workspace user** runs the terminal and `claude`. **Agent** is Claude Code.

| ID | Story |
| --- | --- |
| US1 | As an admin, I assign a set "team-base" with plain variables and a GitHub Packages npm token to every workspace. Projects whose `.npmrc` uses `${NODE_AUTH_TOKEN}` keep working. |
| US2 | As an admin, I add a GitHub login with a fine-grained token for two repositories to one workspace's set. `git push` and `gh pr create` then work in its terminal and for Claude, with no `gh auth login`. |
| US3 | As an admin, I add an SSH deploy key with pinned host keys, AWS credentials, a Google Cloud credential or a kubeconfig. `ssh` works, and the AWS CLI, gcloud or `kubectl` work once installed. |
| US4 | As an admin, I rotate a token. Running workspaces use it on their next command, and I see which confirmed it and when the old one is safe to revoke. After a leak, I rotate urgently and see every workspace that ever received the old value. |
| US5 | As an admin, I point an MCP set's secret slot at `{{secret-file:LINEAR_API_KEY}}`. The server gets the value, and the MCP set never holds it. |
| US6 | As an admin, I mark a secret "Hidden", so Claude's sandboxed commands can't read it while an MCP server still can, and I see whether each workspace enforces that. |
| US7 | As an admin, I delete a set that three workspaces use. The portal removes it from them first and reminds me to revoke the values. It refuses while an MCP set still references one of its names. |
| US8 | As a workspace user, I see which variables and credentials my workspace has (names, never values), whether a change needs a new shell, and which of my own home credentials the portal overrides. |
| US9 | As an admin, I switch the GitHub login to mint 1-hour tokens from our GitHub App, so each workspace holds its own short-lived token. |

## 6. Scope boundary

| In this pool | Not in this pool |
| --- | --- |
| Variables and secret material for tools inside a workspace. | Anthropic API keys and custom hosts belong to [Account Pool](account-pool.md). Every `sk-ant-` value is refused (FR5). |
| Tool logins: GitHub, npm, container registries, AWS, Google Cloud, SSH, kubeconfig. | Claude subscription credentials are never accepted (README ground rule): FR5 refuses OAuth tokens, refresh tokens and `.credentials.json` content in any encoding. |
| Deny rules and `sandbox.credentials` entries for what it delivers. | The sandbox switch, `tlsTerminate`, the env scrub, `CLAUDE_CODE_MCP_ALLOWLIST_ENV`, network allowlists, hook and MCP restrictions, transcript retention and deny rules for the user's own home files belong to [Settings & policies](settings-policies.md). |
| Name-based references from other pools. | MCP server definitions and MCP OAuth logins belong to [MCP set](mcpset-pool.md). Pulling the workspace image on Kubernetes uses `PORTAL_K8S_IMAGE_PULL_SECRET`, which never enters the container. |

## 7. Solution overview

```
 Portal                                   Workspace (any target)
 ┌────────────────────────────┐   push    ┌───────────────────────────────────────────────────┐
 │ Sets, revisions, versions  │ ────────▶ │ managed-settings.d/20-claudepilot-env.json        │
 │ Compiler, references, mint │           │ /etc/claudepilot/secrets/: env.sh, files, tools   │
 │ Tracker, exposure records  │ ◀──────── │ Image hooks → secrets/; claude, bash, git, gh, …  │
 └────────────────────────────┘ read-back └───────────────────────────────────────────────────┘
```

The compiler merges sets, checks names (FR4), resolves references and reads the effective policy.

## 8. Functional requirements

### Sets, entries and delivery

- **FR1** A set has a unique name, a description and entries; each edit is a revision with a note.
- **FR2** "Add entry" has three groups. **Variable:** a name and a plain value. **Secret:** a value
  or file, always delivered as `files/NAME`, with options for a path variable, **Also expose as
  variable** (off, labeled "agent-readable"), **Terminals need it** (off for Hidden and Masked) and
  **Owner-only** (`node:node 0400`, for tools like libpq). **Tool login:** the kinds in §10.2.
- **FR3** Names: variables `^[A-Za-z_][A-Za-z0-9_]{0,127}$`, entries and files
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Limits: variable values one line of 8 KB, secrets and files
  256 KB, a workspace's fragment 384 KB of the 1 MiB Kubernetes Secret (A12).
- **FR4** Reserved names are refused with the reason: names and prefixes other owners declare in the
  env registry (A2), such as `ANTHROPIC_*`, `CLAUDE_*`, `MCP_*` and `DISABLE_*`; `PATH`, `HOME`,
  `SHELL`, `LD_*`, `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`; proxy variables in any case;
  TLS switches (`NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`, `*_CA_BUNDLE`,
  `GIT_SSL_*`), kept for the owner of `tlsTerminate`; `GIT_CONFIG*`, `GIT_SSH*`, `*_ASKPASS`,
  `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES` and the §10.2 pointers. A tool login also reserves the
  variables that would outrank its file: `GH_TOKEN`, `GITHUB_TOKEN` and their `_ENTERPRISE_` forms;
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_ROLE_ARN`,
  `AWS_WEB_IDENTITY_TOKEN_FILE`; `CLOUDSDK_AUTH_ACCESS_TOKEN_FILE`. A name another owner claims
  later fails only this workspace's secrets fragment, whose applied files stay. Exception: a name the agent
  policy sets (`BASH_MAX_OUTPUT_LENGTH`, `MAX_MCP_OUTPUT_TOKENS` and the sub-agent variables, settings
  §22.5): the policy wins, that entry is skipped at delivery with one warning line per workspace, and
  delivery goes on (T-285).
- **FR5** Every value, file body and tool-login field is scanned raw and decoded (base64 and
  base64url to two levels, URL-encoded, JSON-escaped) for `sk-ant-` (covering `-oat`, `-ort`,
  `-admin` and `-api`) and the `claudeAiOauth` key. A match is refused: "This looks like a Claude
  sign-in or an Anthropic key. Anthropic API keys belong in Account Pool." Canaries in §13.
- **FR6** A plain value that looks like a credential (a prefix such as `ghp_`, `npm_` or `AKIA`, a
  PEM header, a JWT, or 20+ high-entropy characters) stays a Variable only after a confirmation.
- **FR7** Fields rendered into git config, INI, YAML, JSON or `ssh_config` pass a per-format
  allowlist (§10.2) and per-format escaping. Every generator is fuzzed (§13).
- **FR8** Checks (§10.2) run on save and on demand through Account Pool's SSRF guard (10 s); a
  failure saves "unchecked". Expiry comes from the provider or the admin, warned at 14 and 3 days.
- **FR9** Several sets per workspace, names unique across them. One per scope: GitHub per host, npm
  per registry, registry per host, AWS per profile, SSH per host pattern, one Google Cloud, one
  kubeconfig. Conflicts are refused (409) on assign and on save.
- **FR10** Assigning says "Anyone who can sign in to this portal can read these secrets," and for a
  set on other workspaces, "Shared by N workspaces: prefer read-only tokens." Duplicating a set
  copies plain values and leaves secrets empty ("Needs value").
- **FR11** Secret bytes travel only in Docker archive request bodies, `exec` stdin and the
  workspace's Kubernetes Secret: never in `exec` command lines (✅ `docker events` records them),
  container env, labels, annotations, Deployment specs, URLs, the pending-creates file, the
  manifest, logs, events, error text, API responses or browser storage. Other sections cite this.
- **FR12** After each write to a running workspace, the engine checks as the workspace user that the
  files are readable: Claude Code starts without a drop-in it can't read 📄.
- **FR13** A removed variable becomes a **tombstone** with a safe value (A6): the default home path
  for pointers that have one (`GH_CONFIG_DIR=/home/node/.config/gh`), else `""`. Removing an `env`
  name applies only at the next launch, while changing a value applies live (foundation §6.4).
- **FR14** While the portal is Locked or Frozen, nothing is delivered or removed (foundation §6.5).
- **FR15** Before a workspace's first set, the foundation preflight (A13) reports the home
  credentials in §10.6 by existence only; the Configuration row shows each with its cleanup step.

### Rotation, versioning and deletion

- **FR16** Secret values have immutable versions. Rotating adds one and a revision ("Rotated NAME")
  at the foundation's pace; **Urgent rotate**, after FR8's checks, skips the pace and pins (A14).
- **FR17** The tracker confirms each workspace: running, by manifest read-back; stopped on Docker,
  by archive write and manifest read-back; stopped on Kubernetes, by the acknowledged Secret update.
  Pinned ones stay pending until moved. "Safe to revoke" shows when all are confirmed or unassigned
  ("Revoke anyway" skips unreachable ones) and covers portal-delivered files only, not other copies.
- **FR18** Rollback restores entries and plain values; secrets keep their current version unless the
  admin ticks "Restore secret versions". Rollback and pins refuse revoked versions ("revoked on
  2026-10-01"), and revoking moves pinned workspaces to the current one. Ciphertext is purged 30
  days after nothing current, pinned or applied uses it; revoked versions once none is applied.
- **FR19** Deleting a set is refused while another pool references one of its names, listing those
  pools and workspaces. Otherwise the set is unassigned, confirmed as in FR17, then purged.
- **FR20** Delete and rotate dialogs say "Deleting is not revoking: processes, transcripts and
  home-folder copies may still hold this value. Revoke it at the provider."

### References and protections

- **FR21** Other pools reference entries by name. `{{secret-file:NAME}}`, which resolves to
  `/etc/claudepilot/secrets/files/NAME`, is the default and the only form for secrets in remote MCP
  headers. A single-token tool login (GitHub, npm, registry) is referenced by its entry name and
  gets a token-only file from the same value version, so one rotation reaches every consumer.
  `${NAME}` works for Variables wherever Claude Code expands it, and for exposed secrets only in a
  stdio server's `env`, never `command`, `args` or `url`, which show in `ps` and logs (🔬 Q3).
- **FR22** References resolve against the same workspace's sets. An unresolved one leaves out only
  the referencing item, such as one MCP server: "MCP set 'Linear' needs `LINEAR_API_KEY`".
- **FR23** Renaming or removing a referenced entry is refused. Unassigning a set that satisfies a
  reference warns first, listing the referencing pools and workspaces.
- **FR24** The editor warns when a remote MCP `url` or header uses a name Claude Code reads as empty
  there, such as `NPM_TOKEN` or `HTTPS_PROXY` 📄. Full list 🔬 (Q4).
- **FR25** The drop-in denies Read and Edit on everything the pool delivers, plus
  `Read(//proc/**/environ)` while a secret is exposed as a variable (A1).
- **FR26** Each secret has a **Claude's access** setting within what its kind allows (§10.4):
  **Usable** (default), **Hidden** (sandboxed commands can't read it) or **Masked** (they see a
  sentinel the sandbox proxy swaps for the real value on declared hosts). It compiles against the
  effective policy (A10) and uses Settings & policies' Enforced, Guidance and Not applied labels.
- **FR27** Hidden and Masked need `sandbox.enabled`, `failIfUnavailable: true` and
  `allowUnsandboxedCommands: false`; Masked also needs `tlsTerminate`. A workspace that receives
  secrets also needs `allowManagedHooksOnly`, an MCP allowlist and `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`
  (the Strict preset) to count as Enforced. Settings & policies shows unmet ones and never applies
  them itself.
- **FR28** Tool logins declare the hosts they authenticate to (GitHub: `github.com`,
  `api.github.com`), which feed Masked entries' `injectHosts` and allowlist proposals to approve.

### Minted credentials (milestone S5)

- **FR29** GitHub App: app ID, private key (kept by the portal), installation, repositories and
  permissions. Each running workspace gets its own 1-hour token at start and every 30 minutes; a
  failed refresh keeps the current one, alerting 10 minutes before expiry. Optional static fallback.
  Refreshes aren't paced; minted values are purged a day after expiry; exposure is kept per source.
- **FR30** Kubernetes ServiceAccount: context, namespace, ServiceAccount. A 1-hour TokenRequest
  token in a kubeconfig for running workspaces, refreshed at half its lifetime. ServiceAccounts in
  the workspaces' namespace are refused, since rights there reach other workspaces' Secrets.

## 9. Data model

Stored in the portal's database (Pools foundation §4). Values are encrypted as in its §4.1, with
additional data `secret_values|<id>|ciphertext`.

| Table | Key fields |
| --- | --- |
| `pools`, `pool_revisions` (foundation) | type `secrets`. Revision content holds the entries: stable `id`, `name`, group, `kind`, plain fields (variable values, hosts, profile, known_hosts, git identity, options), `value_ids` (current when the revision was made), `claude_access`, `hosts`. Never ciphertext (A8). |
| `secret_values` | id, pool_id, entry_id, version, ciphertext, fingerprint, fingerprint_key_id, prev_fingerprint, hint, byte_length, detected_type, expires_at, check_status, checked_at, source (`manual`, `github_app`, `k8s_token`), revoked_at, created_at, purge_after |
| `secret_rotations` | id, pool_id, entry_id, from_value_id, to_value_id, urgent, started_at, safe_at, note |
| `exposures` (foundation §5) | secret_ref (value ID, or minting source), revision, workspace_id, first_delivered_at, removed_at |
| `secret_references` | from_pool_id, from_revision, name, form (`file`, `env`), recomputed on every compile |
| `minted_sources`, `minted_tokens` | Source: pool_id, entry_id, provider (`github_app`, `k8s_sa`), config (no secrets), credential_value_id. Token: source_id, workspace_id, value_id, issued_at, expires_at, refresh_at, last_error. |
| `env_tombstones` (foundation, A6) | workspace_id, owner, name, safe_value, removed_at |

**Fingerprint:** HMAC-SHA256 under an HKDF key from `PORTAL_SECRET_KEY`, 8 hex characters, with its
key ID (A11), so a stolen database can't brute-force it; `portal rotate-key` keeps the old one 90
days. **Hint:** a known prefix (`ghp_`, `AKIA`, …) plus the last 4 of 20+ characters, else `••••••`.

## 10. Delivery into Claude Code and the workspace

### 10.1 Layout and channels

Owners are `root:node` on Docker and `node:node` on Kubernetes, where `sync` writes into
memory-backed `emptyDir`s owned through `fsGroup` (Pools foundation §6.2). Variables use the drop-in
`env`: it changes live ✅ and reaches Bash, hooks and stdio MCP servers. Container env is fixed at
create ✅, Secret-sourced Kubernetes env changes only on restart 📄, and a `CLAUDE_ENV_FILE` script
reaches only Bash and re-exports past `sandbox.credentials`. All are plain text; secrets stay files.

| Path | Content | Mode |
| --- | --- | --- |
| `/etc/claude-code/managed-settings.d/20-claudepilot-env.json` | `env`: Variables, pointers, exposed secrets, tombstones. `permissions.deny` (FR25). `sandbox.credentials` (§10.4). | `0440` |
| `/etc/claudepilot/secrets/` | Everything below. Absent when no set is assigned. | dirs `0750` |
| `…/env.sh` | For login and interactive bash: one `export NAME='value'` line per Variable, pointer, and exposed secret marked "Terminals need it". `'` is written as `'\''`. | `0440` |
| `…/files/<NAME>` | Secrets, and token-only files for referenced tool logins (FR21). | `0440`; owner-only `node:node 0400` |
| `…/gh/hosts.yml`, `…/git/config` | `hosts.yml` per host, in the layout the image's `gh` uses: `oauth_token`, `user` (the login from the check, or `x-access-token` for App tokens), `git_protocol: https`. `git/config` per GitHub host: `[credential "https://<host>"] helper = !GH_CONFIG_DIR=/etc/claudepilot/secrets/gh gh auth git-credential`, optional `user.name`, `user.email` and the SSH rewrite. | `0440` |
| `…/npm/npmrc`, `…/docker/config.json`, `…/aws/credentials`, `…/aws/config`, `…/gcp/credentials.json`, `…/kube/config` | Generated from the entry's fields (§10.2). | `0440` |
| `…/ssh/<NAME>`, `…/ssh/config`, `…/ssh/known_hosts` | Private keys, one `Host` block per entry, pinned host keys. ✅ OpenSSH 9.2 in the image accepts a root-owned `0440` key read through the group, but rejects a user-owned key the group can read, hence `0400` on Kubernetes. | keys: Docker `0440`, Kubernetes `0400` |

### 10.2 Per kind

| Entry | Fields | Files | Pointers (drop-in `env` and `env.sh`) | Notes, validation and checks (FR7, FR8) |
| --- | --- | --- | --- | --- |
| Variable | name, value | none | `NAME=value` | Plain text, visible in the portal and Portal MCP's `pool_get` (FR6). |
| Secret | name, value or file, options (FR2) | `files/NAME` | Optional path variable; `NAME=value` only when exposed | Any command can print an exposed secret with `env`; the file alone is safer. |
| GitHub | host (default `github.com`), token or App source with optional static fallback (FR29), optional git identity, "Rewrite SSH remotes to HTTPS" (off) | `gh/hosts.yml`, `git/config` | `GH_CONFIG_DIR` | ✅ `gh` and its git helper read a read-only `hosts.yml` through `GH_CONFIG_DIR`; the helper sets it inline, so git needs no variable. `GH_TOKEN` is never set. While assigned, `gh auth login` and `gh config set` don't persist, and the user's gh settings and aliases are hidden. `github_pat_` preferred; `ghp_` and `gho_` (often a copied `gh auth token`) warned; `ghu_`, `ghr_` and static `ghs_` refused. The SSH rewrite is system-wide, so the user's own SSH remotes for that host also use the portal token. Check: `GET /user` (App: `/installation/repositories`). |
| npm | registry URL, token, optional scope, "Block install scripts", "Also export as `NODE_AUTH_TOKEN`" | `npm/npmrc` | `NPM_CONFIG_GLOBALCONFIG` | The token is literal, never `${VAR}`. ✅ The user's `~/.npmrc` and the project `.npmrc` still apply, and win. "Block install scripts" writes `ignore-scripts=true`. The export option exposes the same value version for projects that use `${NODE_AUTH_TOKEN}`; the editor notes that such project lines outrank the portal file. Check: `GET /-/whoami`. |
| Container registry | host, username, token | `docker/config.json` | `DOCKER_CONFIG`, `REGISTRY_AUTH_FILE` (podman, skopeo) | `auths` is base64, not encryption. `docker login` can't save into the read-only folder, and docker contexts and CLI plugins in `~/.docker` are hidden while assigned. Check: `GET /v2/` with the bearer-token exchange (HTTPS realms only). |
| AWS | profile (default `default`), key ID, secret key, session token, region, expiry | `aws/credentials`, `aws/config` | `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`, `AWS_EC2_METADATA_DISABLED=true` | Key IDs start with `AKIA` or `ASIA`; `ASIA` needs a session token and an expiry. Profiles match `^[A-Za-z0-9._-]{1,64}$`. Generated from fields only; `credential_process` is never accepted. Check: `sts:GetCallerIdentity`. |
| Google Cloud | credential JSON, optional project | `gcp/credentials.json` | `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` 🔬, `CLOUDSDK_CORE_PROJECT` | `service_account` keys warned (Google advises against them); `authorized_user` warned (it acts as one person). `external_account` only with `credential_source.file` under `/etc/claudepilot/secrets/files/`, `token_url` on `sts.googleapis.com` and impersonation on `iamcredentials.googleapis.com`; `executable` and `url` sources refused. Workspaces have no subject-token source today (no metadata server, and A5 removes the pod's token). |
| SSH | private key, host patterns, user (default `git`), known_hosts lines (pre-filled for github.com, gitlab.com and bitbucket.org from their published keys) | `ssh/NAME`, `ssh/config`, `ssh/known_hosts` | none | Each `Host` block sets `IdentityFile`, `IdentitiesOnly yes`, `IdentityAgent none`, `UserKnownHostsFile /etc/claudepilot/secrets/ssh/known_hosts`, `StrictHostKeyChecking yes`. Host patterns use only letters, digits, `.`, `-`, `*` and `?`; users match `^[a-z_][a-z0-9_.-]{0,31}$`. Keys with a passphrase refused; at least one known_hosts line required. Prefer HTTPS tokens for agent-driven git. |
| Kubeconfig | content, or a ServiceAccount source (FR30) | `kube/config` | `KUBECONFIG=/etc/claudepilot/secrets/kube/config:/home/node/.kube/config` | The portal file comes first, so its values win and the user's contexts stay available. `exec` and `auth-provider` users refused unless "Allow credential plugins" is ticked, because a crafted kubeconfig can run code; `proxy-url`, `insecure-skip-tls-verify` and file references warned. Refused if its credentials match the portal's own. |

### 10.3 Hooks in the image

| File | Content | Verified |
| --- | --- | --- |
| `/etc/profile.d/claudepilot.sh` | `[ -r /etc/claudepilot/secrets/env.sh ] && . /etc/claudepilot/secrets/env.sh` | ✅ The portal terminal runs `bash -l`, which sources it. |
| `/etc/bash.bashrc` | The same line, appended, for interactive non-login bash (VS Code terminals, `docker exec -it … bash`) | ✅ `docker exec -it … bash` (S1 check). VS Code terminals 🔬 Q11 |
| `/etc/gitconfig` | `[include] path = /etc/claudepilot/secrets/git/config` | The image has no `/etc/gitconfig` today ✅; a missing include is skipped 📄 |
| `/etc/ssh/ssh_config.d/50-claudepilot.conf` | `Include /etc/claudepilot/secrets/ssh/config` | ✅ The image's `ssh_config` includes `ssh_config.d`; a missing target is skipped (S2 test) |

New images carry all four (the two shell hooks today; git and ssh with S2); older Docker workspaces get them as A3 describes. Other shells and
non-interactive `exec` skip both shell hooks: git and ssh still work, pointer-based tools don't.

### 10.4 Claude Code protections

The compiled `sandbox.credentials` for a Masked GitHub login and a Hidden, exposed `LINEAR_API_KEY`:

```json
"sandbox": { "credentials": {
  "files": [
    { "path": "/etc/claudepilot/secrets/gh/hosts.yml", "mode": "mask",
      "extract": "oauth_token:\\s*(\\S+)", "injectHosts": ["api.github.com", "github.com"] },
    { "path": "/etc/claudepilot/secrets/files/LINEAR_API_KEY", "mode": "deny" },
    { "path": "/etc/claude-code/managed-settings.d/20-claudepilot-env.json", "mode": "deny" },
    { "path": "/etc/claudepilot/secrets/env.sh", "mode": "deny" } ],
  "envVars": [{ "name": "LINEAR_API_KEY", "mode": "deny" }] } }
```

| Control | What it covers | What it doesn't |
| --- | --- | --- |
| `permissions.deny` Read and Edit rules | Claude's Read and Edit tools, plus the Bash file commands Claude Code recognizes (`cat`, `head`, `tail`, `sed`, `tee`, redirections) 📄. `//` is absolute and `~/` is home; a single leading `/` is anchored to the settings location and would protect nothing 📄, so the compiler emits only `//` and `~/` rules. | ✅ `python3`, `grep -r` and command substitution read a denied file anyway (lab), and so can `jq`, `rg` and `node`, all in the image. Tools reading their own config, which is intended: `gh` and `git` must work. |
| `sandbox.credentials` deny (Hidden) | Hides a file, or unsets a variable, for sandboxed Bash and Monitor commands 📄. Deny entries merge across scopes and only narrow access. Written whenever the policy enables the sandbox. | The Read tool, hooks, MCP servers and the status line run outside the sandbox. Only listed items are protected; there's no built-in list. Paths under `/etc`: 🔬 Q1. |
| `sandbox.credentials` mask (Masked) | Sandboxed commands see a per-session sentinel, and Claude Code's own proxy in the workspace substitutes the real value on requests to `injectHosts` 📄. `extract` masks just the token inside `hosts.yml`. Honored only from managed, user or `--settings` scope. | Needs the experimental `tlsTerminate`; without it the sentinel goes out and auth fails silently, so the compiler writes Hidden instead and flags it. If `extract` matches nothing, `onExtractNoMatch: warn` leaves the real file readable, so the compiler tests the regex first. |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, owned by Settings & policies | Strips credential-looking variables from Bash commands, hooks and stdio MCP servers 📄. | ✅ With no bubblewrap in today's image it stops every `claude` invocation (lab), so it waits for Settings' sandbox probe. It strips `CLAUDE_CONFIG_DIR`, a path 📄, so it may strip this pool's pointers (Q2). If so, the editor names the tools that break in Claude's commands, and the image links npm's `/usr/local/etc/npmrc` to the portal file. |

| Kind (Usable always works) | Hidden | Masked in v1 |
| --- | --- | --- |
| Secret (file or exposed variable) | Yes | With declared hosts, for consumers that send the value verbatim in a header 🔬 (Q1). |
| GitHub | Yes; `gh` and `git` then fail in sandboxed commands | "gh only": `gh` sends the token in a header, while git over HTTPS sends Basic auth and fails until Q1 passes. |
| npm | Yes | Yes: npm sends `_authToken` as a bearer header 🔬 (Q1). |
| Registry, AWS, Google Cloud, SSH, kubeconfig | Yes | No. Registries use Basic auth and a token exchange. AWS arrives as files, and masking is documented only for its two key variables. Google keys and kubeconfig client certificates sign locally. ssh doesn't use the proxy. |

**Enforced** needs all of: FR27's settings in the effective policy; Settings & policies' functional
sandbox probe passing in the workspace; Claude Code support (§10.7); for Masked, a CA the tool
trusts (🔬 Q1); and the locked image. Otherwise it's Guidance: ✅ `sudo` read root-only files and
rewrote managed settings, and the sandbox couldn't start under Docker's default seccomp profile.

Hiding or masking an exposed secret also denies the drop-in and `env.sh`, which hold its value, so a
`claude` started in a sandboxed command runs without this drop-in. 🔬 These entries must merge with
Settings' `sandbox.*` key by key, as documented 📄 (Q1).

### 10.5 When changes apply

| Change | Claude Code (agent's next command, hooks) | Open terminal shells | New shells and sessions | Running processes (dev servers, stdio MCP servers) |
| --- | --- | --- | --- | --- |
| Content of a delivered file (rotated token, key, kubeconfig) | Next call: `gh`, the git helper, `ssh`, npm, `kubectl` and the AWS CLI read the file each time. | Next call | Yes | Only if they re-read it. SDK clients may cache until restarted. |
| Variable or pointer added, changed or removed (tombstone, FR13) | Next command: the drop-in `env` is re-applied live ✅ (Pools foundation §6.4), about 1–2 s after the write ✅: a command sooner still sees the old value (print and interactive sessions, S1 check). | No: run `. /etc/claudepilot/secrets/env.sh` or open a new shell. git and ssh need neither, through the hooks. | Yes | No. Restart them. |
| Deny rules; Claude's access | Deny rules: next tool call 📄 (Settings & policies Q2 checks the pinned version). `sandbox.credentials`: 🔬 Q1, else the next session. | n/a | Yes | n/a |
| A secret an MCP server references | Remote servers: next connection, through the headers helper. stdio servers: 🔬 at their next restart (Q3); a new session always works. | n/a | Yes | n/a |

### 10.6 The user's own credentials

| Tool | Who wins while a set is assigned | Cleanup checklist |
| --- | --- | --- |
| git over HTTPS | The portal helper, which comes first. A user's `~/.gitconfig` that resets `credential.helper` wins. After a successful login git hands the credential to every helper 📄, so a `store` helper writes the portal token to `~/.git-credentials`, and an editor's forwarding helper may copy it to the host machine. | Remove storing helpers; delete `~/.git-credentials` and `~/.netrc` entries |
| `gh` | The portal (`GH_CONFIG_DIR`). The user's login in `~/.config/gh` is hidden, and returns after unassigning in a new shell or session. | `gh auth logout` |
| ssh | The user's `~/.ssh/config` is read first and wins for any option it sets. | Remove matching `Host` blocks and `~/.ssh/id_*` keys |
| npm | The project `.npmrc`, then `~/.npmrc`, then the portal file. A `//host/:_authToken=${VAR}` line for the same registry overrides the portal token. | Remove `_authToken` lines |
| AWS, Google Cloud, Docker | The portal files replace `~/.aws`, the gcloud ADC file and `~/.docker/config.json`. AWS key variables the user exports still win. | Remove the files and exports |
| `kubectl`; variables | The portal kubeconfig is merged before `~/.kube/config`. Inside Claude Code the drop-in wins over shell exports; in terminals the user's profile runs after `/etc/profile.d` and wins. | None |

### 10.7 Versions

| Feature | Needs | Gate |
| --- | --- | --- |
| Drop-in delivery, live `env` reload | Claude Code 2.1.296, the foundation minimum ✅ | Pools foundation §9 |
| `sandbox.credentials` (deny, mask, `extract`) | Claude Code ≥ 2.1.221 📄, tested on the pinned version in S4 | Omitted below it, with "Needs Claude Code ≥ 2.1.221" |
| `gh` with a read-only `hosts.yml`; git include and helper order; OpenSSH key checks; npm `globalconfig` | The image's `gh` (unpinned today; multi-account layout since 2.40, Q5), git 2.39, OpenSSH 9.2p1, npm 10.9.9; behavior ✅ on the tested builds | The image pins `gh`; reconcile records the versions (A13); S2 tests rerun on every image rebuild |

## 11. Threats and mitigations

| ID | Threat | Mitigations | What remains |
| --- | --- | --- | --- |
| T1 | Prompt injection makes the agent read a secret and print it or send it out, also through an allowed host: a gist, an issue, an attacker-owned repository, domain fronting. | Least privilege by default (fine-grained, repo-scoped tokens without gist scope; read-only registry tokens; namespace-scoped ServiceAccounts). Per-workspace sets and minted 1-hour tokens. Files rather than variables. Deny rules; Hidden and Masked where enforced. Narrow allowlist proposals (`api.github.com`, not `*.github.com`, FR28). Exposure records and urgent rotation. | Whatever a usable tool can authenticate with, the agent can use, for example to push to an allowed repository; the allowlist checks hostnames only. With `sudo` the agent can bypass every control in the workspace. |
| T2 | Deny rules are bypassed with tools in the image: `jq`, `rg`, `python3`, `node`, `grep -r`. | Hidden, which the sandbox enforces at the OS level. Deny rules only stop Claude's own reads and accidents. | ✅ Bypassed in the lab. Without an enforced sandbox, nothing stops it. |
| T3 | Code running as `node` outside the sandbox reads every delivered file, and other processes' `/proc/<pid>/environ`: stdio MCP servers, hooks (✅ repository hooks run with no trust prompt in `-p`, S1 check), project `.mcp.json` servers that `-p` and SDK sessions start without asking 📄, and npm lifecycle scripts. A `claude` started from `bash -l` carries `env.sh` values in its environment. | FR27's `allowManagedHooksOnly`, MCP allowlist and `CLAUDE_CODE_MCP_ALLOWLIST_ENV`, without which a workspace stays at Guidance. MCP set's review and pinning. npm "Block install scripts". Secrets stay files unless exposed. `Read(//proc/**/environ)` stops Claude's own reads, and sandboxed commands couldn't read outer processes ✅ (weaker nested mode, lab; Q1 on the real targets). | Any code running as `node` reads every delivered file and other `node` processes' environments: the cost of delivering secrets at all. |
| T4 | Anyone who can sign in to the portal reads delivered secrets, since they can open a shell in any workspace. | Assigning is sharing, and the dialog says so (FR10). Exposure records. | Nothing, until per-user identity exists (Pools foundation Q10). |
| T5 | Copies persist on the home volume: transcripts (`~/.claude/projects`, 30 days by default), shell history, tool caches, `~/.git-credentials` from a storing helper. | The portal never writes the home folder. Deny rules cut accidental prints. A shorter `cleanupPeriodDays` (Settings & policies; 7 recommended). Storing helpers flagged (FR15). Minted 1-hour tokens limit what a copy is worth. ✅ Claude Code wrote no env or helper credential under the home folder (print mode, Account Pool lab values; print and interactive sessions with this pool's exposed and file secrets, S1 check). | What a tool printed or stored stays until cleaned up. |
| T6 | A shared set multiplies the blast radius: a token leaked from "team-base" works in every workspace. | "Shared by N workspaces" warning; read-only tokens for shared sets; write access in per-workspace sets, which limit an injected agent's reach but not other portal users (T4); urgent rotation. | |
| T7 | The portal leaks a value (API responses, logs, error text, command lines, container specs) or is compromised: it holds every secret, a cluster-admin kubeconfig and the Docker sockets. | FR11, the shared redactor (A9), canary tests (§13). Pools foundation §11: a namespace-scoped role, the key on a separate channel. GitHub App keys and cluster credentials never enter workspaces. | A compromised portal compromises every workspace. |
| T8 | Runtime-level readers: anyone with the Docker socket (`docker exec`, `export`, `diff`), exec or Secret rights in the namespace, or etcd access. | On Kubernetes: one Secret per workspace, memory-backed `emptyDir`s, no ServiceAccount token in pods (A5), k3s secrets encryption with `secretbox` (Q8). | On Docker, secret files sit unencrypted in the container's writable layer on the daemon's disk (Q9). |
| T9 | Config injection: a newline adds an ssh `ProxyCommand` or an AWS `credential_process`, a quote in `env.sh` runs code, a kubeconfig carries an `exec` plugin, a Google credential an `executable` source. | Files generated from structured fields; per-format allowlists and escaping, fuzzed (FR7); credential plugins, `credential_process` and executable sources refused. | |
| T10 | A removed or rotated value stays exposed, or a bad rotation breaks many workspaces. | Tombstones (FR13), the tracker and revoke flow (FR17), revoked versions never redelivered (FR18), "Deleting is not revoking" (FR20). Checks before rollout (FR8), the stoppable rollout limit, rollback. | Copies already made inside the workspace. |
| T11 | Minted tokens expire while the portal is down or Locked. | Refresh at half-life, an alert 10 minutes before expiry, the static fallback (FR29). | An outage or Lock longer than the remaining lifetime, 30–60 minutes after the last refresh, breaks git or cluster access until it ends. |

## 12. User experience

Existing components only (Card, Section, Badge, Menu, FormDialog, TextField, TextArea, Select,
Segmented, ChipGroup, ConfirmDialog, CopyButton), designed for phones and desktops.

- **Secrets tab** under Pools ([Skillset](skillset-pool.md) A8): a card per set with revision,
  contents ("4 variables · 2 secrets · GitHub"), "Used by N workspaces" and the soonest expiry.
- **Set editor** (full screen on phones): revision note, "Preview files" (`«secret NAME v3 ·
  3f9a1c2e»`), "Add entry" (Variable, Secret, Tool login) and the shared write-only input (A7), also
  behind Portal MCP's secret links. Claude's access shows only where some policy runs the sandbox.
- **Rotate dialog:** value, note, "Urgent", the tracker ("Confirmed 7, 1 stopped · pending 1").
- **Workspaces:** "Secret sets" chips in the create dialog. The Configuration row shows delivered
  names (never values), when changes apply, the enforcement badge, migration findings and "Restart
  to finish removing N variables".

## 13. Security requirements

- **At rest** as in Pools foundation §4.1; backups and exports never hold plaintext. **API:**
  write-only (hint, fingerprint, length, type, expiry), with no reveal or copy, no values in errors,
  and a warning off localhost or HTTPS. Transport rules are FR11; the redactor (A9) is a backstop.
- **Runtimes:** one Kubernetes Secret per workspace, never per set; no ServiceAccount token in pods
  (A5). Never write a secret to a Docker tmpfs path through the archive API: ✅ it returns 200 but
  stores the file in the on-disk layer underneath. Never commit a workspace container to an image.
- **Tests:** CI searches API responses, logs, events, `docker inspect`, `docker events`, Deployment
  specs and the manifest for canaries in every encoding. FR5 must refuse a fake `.credentials.json`,
  `Bearer sk-ant-oat01-…` and a bare `sk-ant-ort01-…`, raw and encoded. Generators are fuzzed.

## 14. Observability and audit

- **Event log** (Pools foundation §10), never with values: set changes, rotations with old and new
  fingerprints, revocations, checks, assignments, deliveries, minted token failures, unresolved
  references, access-status changes. **Exposure records** answer "where has this value been?"
- **Metrics** for [Monitoring](monitoring-dashboard.md): values expiring within 14 days, rotations
  not yet safe to revoke, minted and delivery failures, workspaces waiting for a restart or at
  Guidance, storing git helpers. Its deny-hit handler (its FR24) covers this pool's deny rules.

## 15. Rollout and milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| S1 | Variables and secrets (files, exposed variables); values, versions, hints, fingerprints; FR5 and FR6 detectors; write-only API; drop-in, `env.sh` and files on Docker; `profile.d` and `bash.bashrc` hooks; deny rules (A1); tombstones; migration check; Secrets tab, editor, Configuration row. **Built.** Server: `apps/server/src/secrets` (values in `secret_values`, migration 13), registered in the pool service; the two shell hooks are delivered to older Docker workspaces and baked into the image. Web: the Secrets tab, editor page, Configuration row, Add-ons, FR10 notes in bulk assignment and FR20 in the delete dialog. Canary, FR5 and fuzz tests pass. **Checked** on DinD through the portal with Claude Code 2.1.296 in the workspace image and a mock API (fake key, no sign-in): files, modes and owners as in §10.1; `bash -l`, `sh -l` and `docker exec -it … bash -i` get `env.sh`, plain `bash -c` doesn't; Claude's Bash sees variables, exposed secrets and path variables; its Read tool is denied the secret files, the drop-in and `/proc/1/environ`, and `cat` of a secret file in Bash is denied too, while `python3` reads it (Guidance, T2); a changed value, a removed name (`""` tombstone, gone once no older `claude` runs) and a rotated file reach a running session at its next command, in print and interactive mode; a stopped workspace gets changes through the archive API and has them at start; unassigning removes files, `env.sh` and the `profile.d` hook after the 30 s grace and keeps the `bash.bashrc` line; no secret value showed in the portal's log, `docker events` or `docker inspect`, and none under the home folder after the sessions (T5). Q11 answered for `docker exec -it` and for repository hooks in `-p` (they run, no trust prompt). Not checked: VS Code terminals (Q11). Not covered: the "This machine" target, which isn't one of this pool's targets: it writes as the portal's user, can't create `/etc/claude-code` (EACCES, checked), so a set assigned there fails delivery. | Foundation F1, F2, F5. Canary, FR5 and fuzz tests. Q11. |
| S2 | Tool logins; git and ssh hooks with the Docker backfill; checks and expiry; references from MCP sets (FR21–FR24); rotation tracker, urgent rotation, exposure records, deletion flow; all on Docker. **Partly built:** names unique across a workspace's sets (FR9), the reference side of FR21–FR23 (names resolve per workspace; renaming, removing or deleting a referenced name is refused; unassigning warns), the FR24 list, value versions with exposure records per value, and **FR18's rollback rule**: a roll back (`POST /api/pools/secrets/:id/revisions/:rev/current`) publishes a NEW revision with the old entries and plain values whose secrets keep their CURRENT version (an entry the current revision no longer has comes back with its newest version, or as "Needs value" when that one was revoked), so a token rotated away after a leak is not delivered again; the Revisions dialog asks, with "Restore secret versions" off by default, and refuses any version that was revoked (`secret_values.revoked_at`), as does pinning a workspace to a revision that holds one; the same name rules as an edit (FR9, FR23) apply to any revision made current, forward moves included. Checked by `secrets/rollback.test.ts` (8 tests) and `pools/pools.test.ts`. **Also built (wave 2):** **rotation** (FR16): `POST /api/secrets/:pool/entries/:entry/rotate` adds the next value version through the pool's ordinary save ("Rotated NAME"), with an optional expiry and note; **urgent rotation** (A14) asks every workspace at once, pinned ones included, and a pinned workspace gets the new value in place of the one its revision names (a value an urgent rotation replaced, or one that was revoked, is never delivered: the entry's current value stands in, and with none the entry "needs a value"); the **tracker** (FR17): per workspace `confirmed` (the old value is no longer delivered there: the engine now closes an exposure record when a secret file takes another value), `pinned`, `failed` or `pending`, and "Safe to revoke" once all are confirmed (portal-delivered files only, FR20); **versions** (hint, fingerprint, size, where it is, who is pinned to it) and **revocation** (`revoked_at`: never delivered, restored or pinned to again; the value in use can't be revoked, rotate first; pinned workspaces are asked to deliver); the **purge sweep** (FR18: a revoked value once no workspace holds it, an unused old one 30 days after it was last in use, daily, try/catch, only while the portal may work) and **expiry** warnings at 14 and 3 days and on passing (events in `secret_events`; the versions dialog shows "Expires in N days"); the **deletion flow** (FR19): `DELETE /api/pools/secrets/:id?unassign=1` is refused while another pool uses a name, otherwise takes the set out of each workspace (removal records clear its files) and deletes it. Web: Rotate and Versions on each saved secret in the editor (not over unsaved edits), the tracker and Revoke in the Versions dialog, delete with unassign in the pool card menu. Checked by `secrets/rotation.test.ts` (10 tests, in-memory delivery). Deviations: a deleted set's values go with it at once (`secret_values` follows the pool by foreign key), not after confirmation, so their 30-day redaction window ends with the set; expiry shows in the dialog and the event trail, not yet as an alert elsewhere; "Urgent rotate, after FR8's checks" has no checks to wait for yet. Not built: tool logins (GitHub, npm, registry, AWS, Google Cloud, SSH, kubeconfig), git and ssh hooks with the Docker backfill, provider checks (FR8). | Foundation F4. Test matrix: the image's git, `gh`, OpenSSH and npm, plus pinned aws-cli v2, `kubectl`, gcloud, google-auth (Python and Node), docker and podman, rerun on every image rebuild. Q3 (launcher), Q5. |
| S3 | Kubernetes delivery of all of the above; the "Enable pools" hook check | Foundation F3 |
| S4 | Claude's access (Hidden, Masked) against the effective policy; policy requirements | Settings & policies' sandbox (its S6). Q1 and Q2 on Docker Desktop and the k3s nodes. Gate test: no sandboxed command recovers a Hidden value from any file under `/etc/claude-code`, `/etc/claudepilot`, the home folder or `/proc`. |
| S5 | Minted credentials: GitHub App, Kubernetes ServiceAccount | Q6 decided |

## 16. Success metrics

| Metric | Target |
| --- | --- |
| Time from assigning a GitHub login to `git push` and `gh pr create` working | Under 1 minute on every target |
| Rotated file in use in running workspaces | Docker: 99% within 2 minutes of the rollout reaching each workspace (the foundation paces 20 a minute); urgent rotations within 2 minutes overall. Kubernetes: within 3 minutes. |
| Secret values in API responses, logs, events, command lines, container specs or the manifest; Claude credentials accepted in any form | Zero, checked by the canary and FR5 tests |
| Deliveries with an exposure record | 100% |
| Running workspaces holding an expired minted token while the portal is up | Zero |

## 17. Amendments to Pools foundation

| ID | Section | Change |
| --- | --- | --- |
| A1 | §7 | Secrets & env may also contribute `permissions.deny` entries, limited to `Read(…)` and `Edit(…)` rules on `//etc/claudepilot/secrets/**` and its own drop-in, plus `Read(//proc/**/environ)` while a secret is exposed as a variable. The compiler checks the prefixes. |
| A2 | §7 | An env registry: each owner declares its `env` names and prefixes, and every compiler checks new names against it (FR4). Secrets & env declares the names in its assigned sets, its pointers (§10.2) and its tombstones, and no `CLAUDE_*` name. |
| A3 | §6.6, §7, §9 | Bake the four hooks (§10.3) into the image. The foundation owns `/etc/profile.d/claudepilot.sh` and `/etc/ssh/ssh_config.d/50-claudepilot.conf` and writes them into older Docker workspaces. `/etc/gitconfig` and `/etc/bash.bashrc` are never owned: one line is added once (`git config --system --add include.path` when missing), outside drift repair. After its restart, "Enable pools" checks that the hooks exist, and otherwise offers the image update (§9). |
| A4 | §6.2 | Withdrawn: §6.2 now updates the Secret before streaming the bundle. |
| A5 | §6.2, §11 | Workspace pods set `automountServiceAccountToken: false`. Anyone who can read Secrets in the shared namespace can read every workspace's secrets. |
| A6 | §6.4 | Tombstones for every pool: a removed `env` name keeps a safe value chosen by its owner (`""` by default) until no `claude` process that started before the removal still runs (checked at reconcile), and is dropped at once in a stopped workspace. Stored per workspace. |
| A7 | §10 | A shared write-only secret input (never prefilled, "Replace value", hint and fingerprint) for Account Pool, MCP set, Portal MCP's secret links and this pool. |
| A8 | §5 | A pool type may keep secret values in its own versioned table, referenced by ID from revision content (§9). |
| A9 | §11 | A shared value redactor (current and recent values raw, base64, URL- and JSON-escaped, plus credential shapes) for every pool, Chat sessions and Monitoring. |
| A10 | §6.1 | Compile inputs from other owners: a fragment may declare read-only inputs from another owner's effective settings. Secrets & env reads Settings & policies' effective `sandbox.*` and sandbox probe result (FR26), compiles after it, and recompiles when they change. Inputs are part of the desired hash. |
| A11 | §4.1, §6.1, §6.3 | One keyed fingerprint for every pool: HMAC-SHA256 under an HKDF key from `PORTAL_SECRET_KEY`, with a key ID (Account Pool FR2 uses plain SHA-256 today). The manifest lists secret files without hashes; drift compares the workspace's `sha256sum` output with a hash computed from the decrypted value at reconcile, never stored. |
| A12 | §6.2 | Byte budgets per owner in the 1 MiB workspace Secret, with the total checked at compile. Secrets & env asks for 384 KB (FR3). |
| A13 | §6.6, §9 | The preflight also reports, by existence only, the home credential files in §10.6, exported credential variable names and git credential helper types (`store`, `cache`, forwarding, other), never their text. Reconcile records `gh`, `git`, `ssh` and `npm` versions next to `claude_version`. |
| A14 | §6.3 | Urgent rotations skip the rollout limit and pins, as revocations do ([Skillset](skillset-pool.md) A3). Minted refreshes aren't revisions and aren't paced. |

**Requests to related PRDs** (settle before approval). [Settings & policies](settings-policies.md):
own the env scrub and gate it on the sandbox probe; drop `Read(//etc/claudepilot/secrets/**)` from
"Protect portal files" (A1 owns it); stay the only writer of `CLAUDE_CODE_MCP_ALLOWLIST_ENV`; add
"Protect home credential files" (`~/.ssh/**`, `~/.aws/**`, `~/.kube/**`, `~/.config/gh/**`,
`~/.config/gcloud/**`, `~/.docker/config.json`, `~/.npmrc`, `~/.git-credentials`, `~/.netrc`); in
FR8, show FR27's requirements instead of adding them, take FR28's hosts as proposals, and reserve
FR4's TLS variables. [MCP set](mcpset-pool.md): drop `CLAUDE_CODE_MCP_ALLOWLIST_ENV`; use
`{{secret-file:NAME}}` for every secret slot and a tool login's entry name, not a second GitHub
token; its FR21, FR22 and FR24 citations match, and its Q8 (the "For MCP servers" preset, per-server
degradation) is accepted. [Account Pool](account-pool.md): adopt A11. README: list Draft v0.5.

## 18. Open questions

| ID | Question | Who decides |
| --- | --- | --- |
| Q1 | 🔬 `sandbox.credentials` on the pinned Claude Code: path syntax for files under `/etc`; substitution inside HTTP Basic auth (git over HTTPS, registries); whether `extract` masks every match when `hosts.yml` holds several hosts or one token twice; which CA each tool must trust under `tlsTerminate` (Node, git, curl, Python); whether these entries merge with Settings' `sandbox.*` key by key; whether changes reach a running session; whether a sandboxed command can read outer `node` processes' `/proc/<pid>/environ` on our targets (T3). | Sandbox spike (S4) |
| Q2 | 🔬 The scrub: does its PID namespace work under Docker's default seccomp, and which pointers (`GH_CONFIG_DIR`, `NPM_CONFIG_GLOBALCONFIG`, the AWS file variables, `GOOGLE_APPLICATION_CREDENTIALS`, `DOCKER_CONFIG`, `REGISTRY_AUTH_FILE`, `KUBECONFIG`) survive it? | Sandbox spike (S4) |
| Q3 | 🔬 Do values a stdio MCP server gets through its `env` mapping or MCP set's launcher survive the scrub and `CLAUDE_CODE_MCP_ALLOWLIST_ENV`? Does `${NAME}` in a plugin's `.mcp.json` expand from managed `env` (MCP set Q5)? Does a stdio server pick up a rotated value without a new session (MCP set Q3)? | Sandbox spike (S2, S4) |
| Q4 | 🔬 What is the full list of names Claude Code reads as empty in remote MCP `url` and `headers` (FR24)? | Docs or a test |
| Q5 | 🔬 Do `gh`, npm, AWS, gcloud, docker, podman and `kubectl` treat each tombstone value (a default path, or `""`) as unset or as their default, and fail safe? Does gcloud honor `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` with a read-only file? Does the pinned `gh` read a read-only `GH_CONFIG_DIR` in the multi-account layout without a migration write? | S2 test matrix |
| Q6 | GitHub model: a portal-owned GitHub App minting 1-hour tokens (best scoping, but needs the portal up), or fine-grained tokens per workspace with an expiry? Which organizations and repositories? | Operator |
| Q7 | Will secret-bearing workspaces run the locked image, or stay at Guidance? | Product, with Settings & policies |
| Q8 | Is k3s secrets encryption on, and with which provider? Kubernetes rates `aescbc`, the k3s default, as weak; `secretbox` is preferred (Pools foundation Q3). | Operator |
| Q9 | Should new Docker workspaces get a RAM-only tmpfs for secrets? It needs `exec`-only writes and a push on every start, and a workspace restarting while the portal is down would have no secrets. v1 keeps files in the container layer. | Engineering |
| Q10 | Should a later version mint AWS STS credentials, with the portal assuming a role per workspace? | Product |
| Q11 | Partly answered (S1 check, Claude Code 2.1.296, Docker): ✅ the `/etc/bash.bashrc` line reaches `docker exec -it … bash`; ✅ repository hooks (`SessionStart`, `PreToolUse`) run without a trust prompt in `-p` (T3); ✅ an interactive session wrote no delivered value under the home folder (T5). 🔬 Still open: VS Code terminals, SDK sessions. | S1 test |
