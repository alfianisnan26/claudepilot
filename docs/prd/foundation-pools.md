# PRD: Pools foundation

| | |
| --- | --- |
| Status | **Draft v0.6.** ✅ = observed in our experiments (Claude Code 2.1.296, mock API, print mode). 📄 = documented by Anthropic or Kubernetes, not observed by us. 🔬 = needs a test (§14). New in v0.6: Kubernetes delivery decided, atomic Docker writes, outbox on the home volume, failing safe, version gating, existing workspaces, testing. Composition rules (§7) still wait for the cross-pool critique. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-10 |
| Used by | [Account Pool](account-pool.md), [Skillset](skillset-pool.md), [Persona](persona-pool.md), [Browser & desktop](browser-desktop-pool.md), [MCP set](mcpset-pool.md), [Secrets & env](secrets-env-pool.md), [Settings & policies](settings-policies.md) |

## 1. Summary

Every pool is the same shape: a reusable bundle, managed in the portal, assigned to many
workspaces, and delivered into Claude Code through files Claude Code reads itself. This PRD defines
the parts they share, so each pool PRD only describes its own content:

1. **Storage:** one SQLite database with migrations, backups and encrypted secret columns.
2. **Assignment:** which pools a workspace uses, and the history of what was delivered.
3. **Delivery engine:** compiling a workspace's assignments into files, writing them into the workspace
   on all three targets, keeping them in sync, and freezing instead of undoing deliveries when the
   portal can't trust its own state.
4. **Composition:** which pool owns which file and settings key, so pools never overwrite each other.
5. **Outbox:** a pull channel for events that workspaces produce (failures, usage), since workspaces
   can't call the portal.
6. **Shared UI:** the patterns every pool page and the workspace detail reuse.

## 2. Goals and non-goals

| Goals | Non-goals |
| --- | --- |
| One storage, one encryption scheme, one delivery path for every pool. | A general configuration management system for anything other than Claude Code workspaces. |
| Delivery works on DinD, host Docker and Kubernetes, for running and stopped workspaces, without workspaces calling the portal. | Hardening the workspace against its own user. Workspace users have `sudo`, so managed settings are precedence, not a security boundary. |
| Pools compose predictably: what each pool may write is declared and checked. | Writing files Claude Code owns (`~/.claude.json`, `~/.claude/settings.json`, transcripts). |
| Every delivery is visible: what's applied, when, whether it drifted, and why it failed. | Multiple portal replicas (one portal process in v1). |
| A portal with a wrong key, a damaged or empty database, or an old backup never removes or blanks what it delivered. | Recovering secrets from workspaces, even after the key is lost. |

## 3. Concepts

| Term | Meaning |
| --- | --- |
| **Pool** | A named, versioned bundle of one type: account, skillset, persona, browser & desktop, MCP set, secrets & env. |
| **Revision** | An immutable snapshot of a pool's content. Editing a pool creates a new revision. |
| **Assignment** | Workspace → pool. Per type, either one pool (account, persona, browser & desktop) or several (skillsets, MCP sets, secrets & env). |
| **Desired state** | All files a workspace should have, compiled from its assignments' current revisions. |
| **Applied state** | What the portal last wrote, recorded in the workspace's manifest (`/etc/claudepilot/state.json`) and in the database. |
| **Reconcile** | Making applied state match desired state for one workspace. |
| **Locked, Frozen** | The portal delivers nothing. Locked: the secret key is missing or wrong. Frozen: it can't trust its database or a workspace's manifest (§6.5). |
| **Outbox** | Files a workspace appends events to. The portal seals each one by renaming it, reads it, then deletes it (§8). |

## 4. Storage

- **Engine:** SQLite through Node's built-in `node:sqlite` at `<PORTAL_DATA_DIR>/portal.db`, with WAL mode,
  `busy_timeout`, foreign keys, and a versioned migration runner. ✅ It runs without a flag on Node
  22.23.3, and the server bundle needs no change. The engines field becomes `>=22.13`, and the
  experimental warning is silenced.
- **Startup checks:** `PRAGMA quick_check`, a schema version no newer than the code, and the key
  check (§4.1). Any failure freezes delivery (§6.5). The store never falls back to empty on a read
  error the way `JsonFile` does.
- **Backups:** SQLite's backup API, before each migration (keep 3) and daily (keep 7), plus
  `portal backup` / `portal restore` (§6.5). Backups contain secret columns still encrypted, so a
  restore needs the key the backup was made with.
- **Data dir:** `PORTAL_DATA_DIR` (exists today, default `<repo>/.data`). Created with mode `0700`, and
  files written with fsync then rename.
- **The existing JSON file** for pending workspace creates stays as it is. Secrets and assignments
  never go into it.

### 4.1 Encryption

- **Key:** `PORTAL_SECRET_KEY` (32 random bytes, base64url) or `PORTAL_SECRET_KEY_FILE`. In the devcontainer,
  the key file lives in the host-secrets folder (`~/.config/claudepilot-devcontainer`, written by
  `initialize.sh` with `umask 077`), not in the repo's `.env`, which sits next to `.data`. Keep an
  offline copy: without the key, every backup's secrets are lost (§6.5).
- **Scheme:** HKDF-SHA256 derives a data key. AES-256-GCM with a random 12-byte IV, with additional data
  binding table, row ID and column, so a ciphertext can't be moved to another row. A versioned
  envelope records the key ID so the key can be rotated.
- **Key check:** a known-value row is decrypted at startup. With a missing or wrong key the portal is
  **Locked**: secret-holding features show the reason, and delivery freezes (§6.5). The portal never
  generates a replacement key or re-encrypts by itself.
- **Key rotation:** `portal rotate-key` re-encrypts every secret column in one transaction.
- **Never** derive the key from the server code (about 40 bits, rotatable, regenerated on restart).

## 5. Assignment

| Table | Key fields |
| --- | --- |
| `portal_meta` | portal_id (random, created with the database), schema_version, key_check |
| `pools` | id, type, name, description, current_revision, created_at, updated_at |
| `pool_revisions` | pool_id, revision, content (json, secrets encrypted), created_at, note |
| `assignments` | workspace_id (`target/name`), pool_id, pinned_revision (null = follow current), assigned_at |
| `removals` | workspace_id, pool_type, pool_id, requested_at, event_id. The only thing that lets the reconciler remove or blank files (§6.5). |
| `workspace_delivery` | workspace_id, desired_hash, applied_hash, generation, applied_at, status (`synced`, `pending`, `drifted`, `failed`, `locked`, `frozen`, `unsupported`, `needs_restart`), reason, claude_version |
| `delivery_events` | id, at, workspace_id, kind, details (json, redacted) (kept 90 days) |
| `exposures` | secret_ref, revision, workspace_id, first_delivered_at, removed_at. Every workspace a secret ever reached, kept for the portal's lifetime. |

- The database is the source of truth for assignments. Docker labels can't change after a container
  is created. On Kubernetes, the Deployment also gets a `claudepilot.io/pools` annotation (no
  rollout) for visibility.
- Removing a workspace deletes its assignments. The reconciler also cleans up assignments of
  workspaces that disappeared outside the portal, because a name can be reused. It does so only when
  the runtime answers "not found" for that workspace, never from an empty or failed listing.
- Following the current revision is the default. Pinning a workspace to a revision allows staged
  rollouts and rollback.

## 6. Delivery engine

### 6.1 Compile

For each workspace, the compiler collects its assignments' revisions and asks each pool type for its
**fragment**: files with path, content, owner and mode, plus settings keys for its drop-in. The
compiler then:

1. Checks ownership (§7): a fragment may only write the paths and settings keys its type declares.
2. Leaves out features the workspace's Claude Code version lacks, and says which (§9).
3. Validates every JSON file. A malformed managed-settings file stops every Claude Code session in the
   workspace 📄.
4. Adds the manifest `/etc/claudepilot/state.json`: portal ID, generation, pool IDs, revisions, file
   hashes, compile time. No secrets.
5. Produces the desired hash.

### 6.2 Write, per target

Every write follows §6.4, so Claude Code only ever sees a whole old file or a whole new one.

What a running session picks up (✅ rows observed on 2.1.296, print mode):

| Change | Picked up |
| --- | --- |
| Temp file renamed into `managed-settings.d` | ✅ At the next request: `env`, helper and key. |
| Archive API overwrite in place (Docker) | ✅ At the next turn, but ✅ **not atomic**: a reader polling the file during 40 overwrites saw it missing or partial 6 times in 15,387 reads (DinD, F2 gate test). Never used on a running workspace. |
| Kubelet-style `..data` symlink swap inside `managed-settings.d`, which is what a Secret or ConfigMap mounted there does | ✅ **Not picked up**, for `env` and helper changes alike (a base-URL change was still ignored after 60 s). The helper isn't re-run, so a new key goes unseen too (simulated kubelet layout). |
| A projected volume at `/etc/claude-code` whose items have nested paths (`managed-settings.d/<file>`) | ✅ At the next request (simulated). 🔬 With a real kubelet (Q5). |
| A `subPath` mount | 📄 Never updated. |

**Rule:** never mount a Secret or ConfigMap at `managed-settings.d`, and never use `subPath`.

**Docker (DinD and host)**

| | |
| --- | --- |
| Running | The archive API writes each file under a hidden temp name in its target directory, with owner and mode from the tar header. One `exec` as root renames them into place in write order. ✅ Tar-header owner and mode on both daemons. ✅ Temp and rename never showed a missing or partial file: 0 bad reads in 15,160 during 40 rewrites (DinD). |
| Stopped | The archive API writes the final names directly, in write order, manifest last. Nothing reads them while the container is stopped. ✅ Into a created, never-started container, and ✅ into one stopped after running (DinD). |
| Removing files | Running: `exec` as root (`rm`). Stopped: overwrite with empty files (an empty drop-in counts as `{}` 📄), then remove them at the next start. |
| Latency | About 1 s 🔬 (Q6). |
| Without the portal | Files stay in the container's writable layer, on the daemon's disk, until the container is removed. |

**Kubernetes**

| | Primary: `emptyDir` + `exec` of `sync.sh` | Fallback: projected volume |
| --- | --- | --- |
| Layout | `emptyDir` volumes at `/etc/claude-code` and `/etc/claudepilot` (memory-backed: the Secret is the durable copy), group-owned through `fsGroup`. The Secret `ws-<name>-claudepilot` (ownerReference to the Deployment) is mounted only in the init container, as `optional`, so a deleted Secret leaves the folders empty. | One read-only projected volume at `/etc/claude-code`, from the same Secret. Every pool's files are items of this one volume. `/etc/claudepilot/**` paths move under `/etc/claude-code/claudepilot/`, and the compiler rewrites references to match. |
| Pod start | An init container runs the bundle's `sync.sh` from the Secret into the `emptyDir`s. | The kubelet mounts the Secret. |
| Running update | Update the Secret, then `exec` `sync.sh` in the workspace container as uid 1000, with the bundle on stdin (a Secret mount would lag by the kubelet delay). `sync.sh` writes temp files and renames them. No `sudo`: an `emptyDir` is group-writable under `fsGroup` 📄, so this also works with `allowPrivilegeEscalation: false` 🔬 (Q5). | Update the Secret. The kubelet swaps the whole volume with one `..data` rename, so all files change together and write order doesn't matter 🔬 (Q5). |
| Latency | About 1 s 🔬 (Q5). | Up to the kubelet sync period plus its cache delay, about 1 minute by default 📄. 🔬 Measure on k3s, and check whether bumping a pod annotation speeds it up (Q5). |
| Removing files | `sync.sh` deletes files the new manifest doesn't list. | Remove the item from the Secret. |
| Drift, outbox, version | Through `exec` (§6.3, §8, §9). | No `exec`, so none of these. The mount is read-only, so even `sudo` can't change it 🔬 (Q5). The version comes from the pinned image tag (§9). |
| Without the portal | Yes. The init container copies the Secret at every start. | Yes. The Secret is the source. |

- Both paths keep one Secret per workspace, limited to 1 MiB 📄. Larger content needs its own volume
  ([Skillset](skillset-pool.md) A6 proposes one).
- The primary path is the default. The fallback is a per-target setting for clusters where the portal
  may not `exec` into pods. It can't meet Account Pool's failover targets. Changing the setting
  restarts that target's workspaces.
- On the primary path, workspace users can write the delivery folders without `sudo`. That changes
  nothing for the standard image, which has passwordless `sudo`. The locked image
  ([Settings & policies](settings-policies.md) amendment 6) mounts them read-only.

### 6.3 Reconcile

- **Triggers:** an assignment changes, a pool gets a new revision, a workspace starts, the portal starts,
  and timers. Starts come from Docker's event stream and a Kubernetes pod watch, so a start outside
  the portal counts too.
- **Every change reaches stopped workspaces at once:** through the archive API on Docker and the
  Secret on Kubernetes. Revocations and rotations never wait for a timer, so a stopped workspace that
  someone starts outside the portal already has current files.
- **Timers only detect drift:** every 60 s for running workspaces, every 10 minutes for stopped ones.
- **One reconcile per workspace at a time** (single-flight), with exponential backoff on failure. The
  outcome goes into `workspace_delivery` and the event log.
- **Drift:** on a running workspace, the reconciler reads the manifest and the file hashes
  (`sha256sum` through `exec`) and compares them with the database. On a stopped Docker workspace it
  reads only the manifest (archive API), so secrets are never read back. Files that changed or went
  missing are rewritten and reported as "drifted" once. A manifest that doesn't match the database's
  portal ID or generation freezes the workspace instead (§6.5).
- **Rollout control:** a pool change reaches at most N workspaces per minute (default 20), so a
  broken revision can be stopped. Revocations and account rotations skip this limit. A revision that
  fails validation never leaves the portal.

### 6.4 Write order and safety rules

- **Atomic as Claude Code sees it:** write each file under a hidden or non-`.json` temp name in its own
  directory, then rename it. Claude Code ignores hidden and non-`.json` files in `managed-settings.d`
  📄. Never overwrite a live file in place.
- **Order:** referenced files before what references them (key files before the drop-in that points at
  them), then drop-ins, then the manifest. A manifest that doesn't match means a write didn't finish,
  and the next reconcile redoes it.
- Never leave a state where Claude Code would send a user's own credentials to a third-party host
  (see [Account Pool §10.4](account-pool.md)).
- Changing an `env` value applies to running sessions ✅. Removing a variable applies only at the next
  launch 📄 (✅ a deleted drop-in's base URL stayed in effect). Pools that need to revert a variable
  overwrite it with its safe value instead of removing it.

### 6.5 Failing safe

The portal delivers only when it trusts its own state, and it never reads a missing row as a request
to remove something.

| Condition | Detected by | Result |
| --- | --- | --- |
| Secret key missing or wrong | Key check (§4.1) | **Locked:** no deliveries to any workspace. Drift reads and outbox pulls continue. Clears when the portal restarts with the right key. |
| Database corrupt, or from a newer schema | Startup checks (§4) | **Frozen:** no deliveries and no outbox pulls. |
| Database missing or empty, so a new one starts with a new portal ID | The manifest's portal ID (drift read, §6.3) | Every existing workspace is Frozen: "Set up by another portal". |
| A manifest's generation is newer than the database's (an old database put back by hand) | Drift read | That workspace is Frozen: "Database older than workspace". |
| A manifest lists pools that have no assignment and no removal record | Drift read | That workspace is Frozen: "Assignments missing". |

- **Removals need a record.** Unassigning, deleting a pool or removing a secret writes a removal record
  with its event. The reconciler removes or blanks files only against such a record, then deletes it.
- **The generation is recorded before writing.** The database stores the next generation before the
  files go out, so a crash mid-write never looks like an old database.
- **Unfreezing is explicit.** The Configuration panel shows what resuming would change in each
  workspace. An admin confirms "Resume delivery", or "Adopt workspace", which overwrites its files
  with this portal's.

**Restore**

- `portal restore <file>` checks the backup's integrity and that the current key opens its key check,
  keeps the replaced database as a backup, and starts Frozen until an admin resumes delivery.
- Backup but no key: `portal forget-secrets` deletes every encrypted value and writes a new key check
  under a new key. Pools, assignments and history stay, every secret shows "Re-enter", and
  workspaces keep their last files until their pools compile again. The portal never reads secrets
  back from workspaces, so they can't be recovered from there.
- No database and no backup: the new database gets a new portal ID. Every existing workspace shows
  "Set up by another portal", and nothing in it changes until an admin adopts it.

**If the portal is gone for good**

- Workspaces keep working on their last files indefinitely. Nothing rotates, revokes or repairs, and
  outbox files fill to their cap.
- Delivered secrets stay readable in each workspace, and on Docker in the writable layer, until
  removed. Revoke them at their provider: removing a key from workspaces doesn't revoke it.
- Clean up with `portal decommission` while the portal still runs. It unassigns everything in the safe
  order and deletes each workspace's Secret. Without a portal: stop the workspace, delete
  `/etc/claudepilot` and the `*-claudepilot-*.json` drop-ins (on Kubernetes, delete the Secret
  `ws-<name>-claudepilot`), then start it. Deleting while stopped is safe, because no running session
  keeps old `env`.

### 6.6 Existing workspaces

- **Docker:** nothing to restart. The first reconcile creates the folders (§9) and runs the preflight.
- **Kubernetes:** "Enable pools" adds the volumes and init container (§6.2). On a stopped workspace it
  costs nothing. On a running one the admin picks **Restart now**, after a confirmation that says the
  restart ends every session and shell and shows how many `claude` processes are running, or **When
  it next stops**, and the portal patches the Deployment once it's scaled to 0. New workspaces get the
  volumes at creation.
- **Preflight:** a delivered script, run through `exec`, reports by name only what the user configured:
  `ANTHROPIC_*` and `CLAUDE_CODE_USE_*` exports in shell profiles, `apiKeyHelper` and `env` names in
  `~/.claude/settings.json` and in project `.claude/settings*.json` files under `~/work` (three levels
  deep), and the container's environment. It never prints values and never opens `~/.claude.json` or
  `~/.claude/.credentials.json`, so login state stays unread. It runs at the first reconcile while the
  workspace is running ("Not checked" until then) and before each new assignment. The Configuration
  panel lists the findings ("A pool will override `ANTHROPIC_API_KEY`, exported in `~/.bashrc`"), and
  each pool PRD says what it does about them.

## 7. Composition: who owns what

Each pool type declares what it may write. The compiler rejects fragments outside their declaration.

| Owner | Files | Managed settings keys (in its own drop-in) |
| --- | --- | --- |
| Settings & policies | `managed-settings.d/10-claudepilot-policy.json` | `permissions.*` (deny, ask, allow, defaultMode, disableBypassPermissionsMode), `sandbox.*`, `availableModels`, `maxEffortLevel`, limits |
| Secrets & env | `managed-settings.d/20-claudepilot-env.json`, `/etc/claudepilot/secrets/**` | `env` (its declared variable names only), `sandbox.credentials` |
| MCP set | `managed-settings.d/30-claudepilot-mcp.json`, plugin(s) in the portal marketplace | `managedMcpServers` (remote servers), `enabledPlugins` entries for its plugins, `allowedMcpServers` / `deniedMcpServers` |
| Account Pool | `managed-settings.d/40-claudepilot-account.json`, `/etc/claudepilot/account/**`, `/etc/claudepilot/bin/account-*` | `apiKeyHelper`, `env` (`ANTHROPIC_*`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`, `CLAUDEPILOT_ACCOUNT`, …), `hooks.StopFailure` |
| Persona | `managed-settings.d/50-claudepilot-persona.json`, `/etc/claude-code/.claude/agents/**`, output styles | `claudeMd`, `outputStyle`, `model` defaults, `enabledPlugins` for its plugin |
| Skillset | `managed-settings.d/60-claudepilot-skills.json`, `/etc/claude-code/.claude/skills/**` or plugins in the portal marketplace | `enabledPlugins` entries for its plugins, `extraKnownMarketplaces` (the portal marketplace) |
| Browser & desktop | `managed-settings.d/70-claudepilot-browser.json` | its MCP server entry, `env` (`CLAUDEPILOT_BROWSER_*`) |
| Foundation | `/etc/claudepilot/state.json`, `/etc/claudepilot/bin/**` except pool scripts, `~/.claudepilot/outbox/` | none |

Pool scripts live in `/etc/claudepilot/bin/` under their type's prefix (Account Pool's `account-*`,
for example), and each type owns its prefix. On the Kubernetes fallback, the `/etc/claudepilot/**`
paths in this table live under `/etc/claude-code/claudepilot/` (§6.2).

How Claude Code merges drop-ins: files merge alphabetically, scalars from later files win, lists are
combined, and `env` and other nested blocks merge key by key. Two rules keep this safe:

1. **No two owners set the same scalar key or `env` variable.** The compiler checks this, so the
   alphabetical "later wins" rule never decides anything by accident.
2. **List keys** (`permissions.deny`, `enabledPlugins`) may be contributed by several owners, because Claude
   Code combines them.

Managed sources don't merge by default 📄. Claude Code uses the highest-ranked source that sets any
policy key, and only `env` merges per variable across sources. Server-managed settings for a user's
own sign-in rank above files, so in that workspace they could replace every drop-in except `env` 🔬
(Q9). The portal can't check this without reading login state.

Shared plugin marketplace: skillsets, MCP sets and personas that ship plugins all go into one
portal-managed directory marketplace at `/etc/claudepilot/marketplace`, registered once by the
foundation. Each owner adds only its own `enabledPlugins` entries. 🔬 Confirm that a managed
directory marketplace loads without prompts in interactive and `-p` sessions in a container (Q1).

## 8. Outbox

- **Where:** `/home/node/.claudepilot/outbox/<type>.jsonl`, on the home volume on every target (a named
  volume on Docker, the PVC on Kubernetes). Events written just before a stop survive it, including
  pod deletion when a Kubernetes workspace scales to 0. Owned by the workspace user. The delivery
  engine creates the folder.
- **Writing:** hooks and helpers append one JSON object per line, in a single `write`, at most 4 KB,
  each with an `id`. Lines hold only what the owning pool declares, never prompts, transcripts or tool
  output. Past its cap (1 MB by default), a file drops new lines and counts them in `<type>.dropped`.
- **Pulling** never truncates a file that a `claude` process may be appending to:
  1. Delete the `.pulling` files the portal stored last time (it passes their names).
  2. Rename `<type>.jsonl` to `<type>.<n>.pulling`. The next append starts a new file.
  3. Wait 1 s for writers that opened the old file, then print every `.pulling` file.
  4. The portal stores the events, skipping ids it stored in the last 24 hours.

| Target | Running | Stopped |
| --- | --- | --- |
| Docker | One `exec` of `/etc/claudepilot/bin/outbox-pull` runs steps 1–3. | The archive API reads the files. The portal stores the events, then replaces the files with empty ones; nothing appends while stopped 🔬 (Q7). |
| Kubernetes | The same `exec`. | Unreadable. Files wait on the PVC until the next start. |

- **Before it stops any workspace,** the portal pulls once.
- **Cadence and cost:** every 10 s for running workspaces with a subscriber (Account Pool failure
  events, an open Monitor view), otherwise in the same `exec` as the 60 s reconcile. Each pull is one
  `exec`, so a subscribed workspace costs 6 a minute, and 50 of them cost about 5 `exec` calls a second
  on the Docker daemon or the Kubernetes API server 🔬 (Q7). The Kubernetes fallback (§6.2) has no
  outbox.

## 9. Workspace image and Claude Code version

- **Folders:** the image creates `/etc/claudepilot` and `/etc/claude-code/managed-settings.d` with the
  right owners. The delivery engine also creates them and `~/.claudepilot/outbox`, because existing
  Docker workspaces keep their original image and existing home volumes keep what they were seeded
  with.
- **Pinned version:** drop-in watching, `env` reload, helper caching and retry counts are
  version-specific. The image installs a pinned Claude Code (`@anthropic-ai/claude-code@<version>`
  from a build argument) and is tagged with it. Today it installs whatever is latest. The weekly GHCR
  rebuild keeps the pinned version, which moves only after the lab suite passes on the new one (§12).
- **Minimum supported version: 2.1.296,** the only version the lab suite has run on, until the version
  matrix shows older ones pass (Q8).
- **Detection:** `claude --version` through `exec` at every reconcile of a running workspace, stored in
  `workspace_delivery`. Docker workspaces keep the version their image had when it was first built on
  that daemon. Kubernetes pods get the Deployment's image at every start.
- **Updating:** on Docker, "Update Claude Code" installs the pinned version through `exec` as root. On
  Kubernetes it changes the Deployment's image tag, which restarts the pod, with the same
  confirmation as "Enable pools" (§6.6).

Delivery gates on the detected version:

| Detected version | Delivery |
| --- | --- |
| Below the minimum | **Unsupported:** no new assignments. Existing ones keep updating, so revocations and rotations still land. The workspace offers "Update Claude Code". |
| Minimum up to the newest tested | Normal. |
| Newer than the newest tested | Delivered and flagged "Untested version". CI runs the lab suite on it. |
| Not known yet (stopped since before pools) | Delivered, and checked at the next start. |

Each pool type also declares a minimum version per feature. The compiler leaves out what the
workspace's version lacks and says so (§6.1).

## 10. Shared UI patterns

- **Pool pages:** one page per type, each a list of cards with name, description, revision, "Used by
  N workspaces", and the same actions (edit, duplicate, delete with "in use" guard).
- **Pool editor:** a form dialog per type, with a revision note, and "Preview files" showing exactly
  what will be written, secrets redacted.
- **Workspace detail → Configuration:** one row per pool type, showing the assigned pool and revision,
  delivery status (Synced, Pending, Drifted, Failed, Locked, Frozen, Unsupported, Needs restart) with
  time and reason, and a change control. "Preview files" for the whole workspace, the Claude Code
  version, and the preflight findings (§6.6).
- **Workspace create dialog:** account pool and persona selects, plus an "Add-ons" section for skillsets,
  MCP sets, secrets and browser, collapsed by default.
- **Bulk assignment:** select workspaces from the list and assign a pool to all of them.
- **Restarts:** "Enable pools" and, on Kubernetes, "Update Claude Code" confirm first (§6.6).
- **Locked or Frozen:** one portal-wide banner with the reason and the way out: provide the key, review
  and resume delivery, or adopt workspaces (§6.5).
- **Event log:** one filterable timeline (delivery, drift, failover, assignment), shared by every pool.

## 11. Security

- Secrets are encrypted at rest (§4.1), write-only in the API, masked in the UI, and redacted from logs
  and errors (runtime error text included).
- Secrets never go into container env, Deployment specs, labels, URLs, query strings, `exec` command
  lines or the pending-creates file. They travel only in archive uploads, Secret updates and `exec`
  stdin.
- **Where delivered secrets live:** Docker keeps them on disk in the container's writable layer, where
  `docker cp`, `docker export` and `docker commit` reach them. That's the price of stopped workspaces
  working without the portal. Kubernetes keeps them in the workspace's Secret (etcd, Q3) and in a
  memory-backed `emptyDir`.
- **Inside a workspace, every delivered secret is readable** by its users (they have `sudo`). Each pool
  PRD treats assignment as sharing with every user of that workspace. `exposures` (§5) records every
  workspace a secret ever reached.
- **Audit:** everyone signs in with one shared code as "Admin", so events can't name a person (Q10).
- **Transport:** the portal speaks plain HTTP. Secret entry forms warn when the page isn't served
  from localhost or over HTTPS.
- **Portal host:** the portal holds a cluster-admin kubeconfig today and can decrypt every secret.
  Production deployments should use a namespace-scoped role (secrets, pods/exec, deployments, pvcs)
  and keep the secret key on a separate channel.

## 12. Testing

The lab (a mock Anthropic API, fake keys, no network) becomes a CI suite. Claude Code runs in print
mode in every row except the last.

| Area | What it checks | Where |
| --- | --- | --- |
| Delivery matrix | Each target (DinD, Docker Desktop, k3d or kind, our k3s) × state (created, running, stopped after running) × operation (add, change, remove) × file kind (drop-in, key file, nested folder). Claude Code picks up each change at its next request. | CI for DinD and k3d. By hand on Docker Desktop and k3s. |
| Docker atomicity | `inotifywait -m` on the target folders plus a tight `cat` loop, comparing an in-place archive overwrite with temp + `exec` rename. Pass: only `MOVED_TO` events, no `ENOENT`, no partial reads. Both daemons, running containers and ones stopped after running. | CI. Gate for F2. |
| Kubernetes paths | On k3s: projected-volume pickup and the kubelet delay (time the `..data` swap with `readlink`), with and without an annotation bump; a Secret mounted at `managed-settings.d` (expect no pickup); `emptyDir` + `exec` of `sync.sh`, also under `allowPrivilegeEscalation: false`; Account Pool's safe unassign through both paths. | Gate for F3. |
| Fault injection | Portal killed mid-write on each target; a malformed drop-in (the compiler rejects it, and a hand-placed one is repaired as drift); concurrent reconciles of one workspace; locked key, empty database, corrupt database and an old backup (zero writes, the right Frozen reason); runtime unreachable during a listing (no assignment cleanup). | CI. |
| Outbox | Several appenders during pulls (no lost or doubled events); a pod deleted on scale to 0 (its events survive on the PVC). | CI (k3d). |
| Version matrix | The lab suite on every Claude Code version an image pins or a workspace reports, plus older candidates for the minimum. | CI, before a version moves. |
| Secret leaks | Marker secrets never appear in logs, events, API responses, backups or `exec` command lines. | CI. |
| Interactive | Pickup and reload in a `claude` session driven through tmux. | By hand, before F2 sign-off. |

## 13. Milestones

| Milestone | Scope | Gate |
| --- | --- | --- |
| F1 | SQLite store, migrations, startup checks, backups and restore, encryption with key check, portal ID | |
| F2 | Compiler with ownership checks and version gating, manifest, pinned image, Docker delivery (running, stopped, write-through, start detection), reconcile with drift repair, failing safe, preflight, delivery status in the workspace list | Docker atomicity and fault-injection tests pass |
| F3 | Kubernetes delivery (primary and fallback), "Enable pools" | Kubernetes tests pass on k3s |
| F4 | Outbox pull, event log, exposure records | Outbox tests pass |
| F5 | Shared UI: pool page pattern, workspace Configuration panel, create-dialog add-ons, bulk assignment | |
| F6 | Plugin marketplace (for skillsets, MCP sets and personas) | Q1 |

Account Pool can start after F2 (Docker) and F4 (signals). Kubernetes support follows F3.

## 14. Open questions

| ID | Question |
| --- | --- |
| Q1 | 🔬 Does a managed directory marketplace with relative-path plugins load without prompts, interactively and with `-p`, in a container? |
| Q2 | Should the data dir in the devcontainer move off the repo's bind mount (`~/Documents` on the Mac) to a named volume? |
| Q3 | Is k3s secret encryption at rest enabled in the cluster? |
| Q4 | Production deployment target for the portal itself (decides the data dir, the key channel and TLS). |
| Q5 | 🔬 With a real kubelet on our k3s: does a projected volume at `/etc/claude-code` with nested items hot-reload, how long does a Secret change take to reach the pod, does an annotation bump speed it up, does the read-only mount resist `sudo`, and how long does the primary path take, including `exec` as uid 1000 into the `fsGroup` `emptyDir`s under `allowPrivilegeEscalation: false`? |
| Q6 | ✅ Answered on DinD (`delivery/docker.integration.test.ts`): an in-place archive overwrite is **not** atomic; temp + `exec` rename is; writes into containers stopped after running persist. 🔬 Still open: the same on Docker Desktop, and the latency. |
| Q7 | 🔬 Can the archive API read and replace outbox files on a stopped Docker container's home volume? What load do 10 s `exec` pulls put on the daemon and the API server at 50 workspaces? |
| Q8 | Can the minimum supported Claude Code version go below 2.1.296? The version matrix decides. |
| Q9 | 🔬 Do server-managed settings for a user's own sign-in replace the portal's drop-ins (first-wins 📄)? Only the user can check, for example in `/status` "Setting sources". The portal never reads login state. |
| Q10 | Before the portal stores third-party keys: add named admin identities, or accept an audit log where every actor is "Admin"? |
| Q11 | 🔬 Do drop-in pickup and reload behave in interactive sessions as they do in print mode? |
