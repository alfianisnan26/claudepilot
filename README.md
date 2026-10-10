# portal

A small admin portal served over plain HTTP on port 3000. Sign in with a **server code**; once in, the
admin view rotates or replaces the code, turns sign-in on or off, and signs out.

Styled with pay's design system through [`isnanme/shared`](https://github.com/isnanme/shared)
(`@isnanme/tokens`, `@isnanme/ui`), so it looks and behaves like pay on phones and desktops.

## Layout

```
apps/
  server/        Node + Hono. Serves /api, and the web app (Vite middleware in dev,
                 apps/web/dist in production) on the same port.
  web/           React 19 + Vite + Tailwind v4 on @isnanme/ui.
    src/app/        providers, routes, nav (add a page to NAV and it shows in sidebar + tab bar)
    src/components/ app frame: AppShell (sidebar / app bar / tab bar), AuthLayout, PageHeader…
    src/features/   one folder per feature (auth, admin)
    src/lib/        API client, auth context, formatting
packages/
  contracts/     Wire types, routes and code rules shared by server and web (TS source).
```

The API speaks `@isnanme/core`'s wire contract: `{ data }` on success,
`{ error: { code, message, details? } }` on failure.

## Setup

`@isnanme/*` packages come from GitHub Packages, which needs a token with `read:packages`:

```sh
gh auth refresh -h github.com -s read:packages   # once
NODE_AUTH_TOKEN=$(gh auth token) npm install
```

In the devcontainer, every new shell sets `NODE_AUTH_TOKEN` from `gh` (see
[.devcontainer/post-start.sh](.devcontainer/post-start.sh)), so a plain `npm install` works after a rebuild.

## Run

```sh
npm run dev        # http://localhost:3000 (API + Vite with HMR on one port)
npm run build      # web → apps/web/dist, server → apps/server/dist
npm start          # production server
npm test           # server tests (node:test)
```

The devcontainer forwards port 3000.

## Configuration

Environment variables (see [.env.example](.env.example)):

| Variable | Default | |
| --- | --- | --- |
| `PORTAL_SERVER_CODE` | generated | Sign-in code. Unset: an 8-character code is generated at startup and printed in the log. |
| `PORTAL_HOST` | `0.0.0.0` | Bind address. |
| `PORTAL_PORT` | `3000` | Port. |
| `PORTAL_DATA_DIR` | `.data` (repo root) | Where the portal keeps its database (`portal.db`), backups and workspace creates in progress. Mode 0700. |
| `PORTAL_SECRET_KEY_FILE` / `PORTAL_SECRET_KEY` | none | Encrypts stored secrets: 32 random bytes, base64url. Easiest: leave the file empty and choose **Set up encryption** on the Access page; the portal writes the key there (never overwriting one) and shows it once. Without a key file the key lives in memory and you **Unlock** after restarts. Keep an offline copy: without it stored secrets can't be read. In the devcontainer the file is on the `claudepilot-portal-secrets` volume. |

Codes are exactly 8 letters and digits (one sign-in box each, shown as `XXXX-XXXX`). Case, spaces and
dashes are ignored. A `.env` at the repo root is loaded in dev.

## Workspaces

Shell boxes with Claude Code, git and gh ([images/workspace](images/workspace/Dockerfile)), managed
from the Workspaces page: create, start, stop, remove, live CPU/memory, and a browser terminal.

Targets (each shows up when reachable):

| Target | Where | Runs a workspace as |
| --- | --- | --- |
| `docker` | `PORTAL_DOCKER_SOCKET` (`/var/run/docker.sock`; in the devcontainer, its DinD daemon) | container `claudepilot-<name>` + volume `claudepilot-<name>-home` |
| `docker-host` | `PORTAL_DOCKER_HOST_SOCKET` (`/var/run/docker-host.sock`; the Mac's Docker Desktop) | same |
| `kubernetes` | current kubeconfig context, namespace `PORTAL_K8S_NAMESPACE` (`claudepilot-workspaces`) | Deployment `ws-<name>` (scaled 1/0 to start/stop) + PVC `ws-<name>-home` |

- The runtimes are the record: workspaces are found by label, so a portal restart loses nothing.
  Creates in progress (and failed ones, until removed) are saved in `PORTAL_DATA_DIR` and picked up
  again after a restart.
- `/home/node` persists. On Docker a fresh volume is seeded from the image; on Kubernetes an init
  container copies it in once.
- Docker targets build `PORTAL_WORKSPACE_IMAGE` (`claudepilot-workspace:latest`) from
  `images/workspace` the first time (a few minutes). Kubernetes pulls `PORTAL_K8S_IMAGE`
  (`ghcr.io/alfianisnan26/claudepilot-workspace:latest`), which
  [.github/workflows/workspace-image.yml](.github/workflows/workspace-image.yml) builds for amd64 and
  arm64 on changes to `images/workspace` and weekly (new Claude Code releases). If the GHCR package is
  private, set `PORTAL_K8S_IMAGE_PULL_SECRET` to a pull secret in the namespace. Also:
  `PORTAL_K8S_STORAGE` (`10Gi`), `PORTAL_K8S_STORAGE_CLASS`, `PORTAL_K8S_ENABLED=false` to turn it off.
- The shell is a WebSocket at `/api/workspaces/<target>/<name>/shell`; it needs a session cookie and a
  same-origin `Origin`.

## Accounts

The Accounts page holds API keys for Claude Code in workspaces: Anthropic API keys, or keys for your
own Anthropic-compatible gateways (custom hosts with base URL, model names, context limits). Keys
are encrypted (see Storage), never shown again after saving, and checked with `GET /v1/models`
(no inference, not billed), sending the key the way Claude Code does. Each check gives one result
(working, rate limited, invalid key, billing, spend limit, wrong URL, unreachable). Custom hosts on
private addresses (LAN, localhost) need "Allow private network". Adding keys to pools and workspaces
works through account pools ([docs/prd/account-pool.md](docs/prd/account-pool.md)).

**Pools.** Group keys into a pool (in priority order) and assign it to workspaces, when creating one
or later from its menu. Assigning to an existing workspace asks for confirmation, because the pool's
key overrides any sign-in there. The portal delivers the key natively: a managed-settings drop-in
(`/etc/claude-code/managed-settings.d/40-claudepilot-account.json`) points Claude Code's
`apiKeyHelper` at a key file only that account uses, so `claude` starts signed in. Disabling or
re-keying an account moves its workspaces to the next usable one; the next Claude Code request uses
the new key, with no restart. Unassigning first writes safe values, then removes the files a minute
later.

**Failover.** Workspaces report trouble through an outbox the portal pulls every 10 s: each run of the
key helper (Claude Code runs it again before every retry after a 401) and each turn that ends on an
API error (a `StopFailure` hook). A signal alone changes nothing: the portal probes the account with
one 1-token request, at most once a minute, and classifies the answer: **cooling** (429, until
`retry-after`), **exhausted** (spend cap or usage limit), **billing**, **invalid key** or **needs
attention**. Workspaces then move to the next usable key, preferring another organization after a rate
limit, spread over a few seconds. Cooldowns under 2 minutes are left to Claude Code's own retries. With
no usable key left, a workspace keeps its last one and shows "waiting for quota until …"; it moves on
once a probe finds an account back. Keys are also checked every 15 minutes, and **Check now**, **End
cooldown** and **Mark as working** override the state by hand. In tests with the real CLI, a key
revoked mid-request was replaced in about 10 s and the same request succeeded.

**Delivery** (Docker targets today, Kubernetes next). Files are written atomically (temp file, then
rename), into running and stopped workspaces alike; a hand-edited file is repaired within a minute.
A workspace whose delivered files this portal can't account for (another portal's, or an older
database's) is **Frozen** until you choose **Adopt workspace**.

## Storage

The portal keeps its state in SQLite (`node:sqlite`, WAL) at `$PORTAL_DATA_DIR/portal.db`, migrated on
start. Secret values are sealed with AES-256-GCM under `PORTAL_SECRET_KEY`, each bound to its row and
column. On start the portal checks its own state and reports it on the Access page:

- **OK**: deliveries to workspaces can run.
- **Locked**: the secret key is missing or doesn't match the database. Secrets stay sealed and nothing
  is delivered. The portal never makes up a new key.
- **Frozen**: the database is damaged, from a newer portal, or was just restored. Nothing is delivered
  until the cause is fixed or, after a restore, an admin chooses **Resume delivery**.

Backups go to `$PORTAL_DATA_DIR/backups`: before each migration (last 3 kept) and daily (last 7 kept),
each a single file with secrets still encrypted. The `portal` CLI handles the rest:

```sh
npm run portal -- status           # database, key and backups (safe while running)
npm run portal -- backup           # take a backup now (safe while running)
npm run portal -- restore <file>   # portal stopped; it then starts Frozen
npm run portal -- rotate-key       # PORTAL_NEW_SECRET_KEY(_FILE) = new key; portal stopped
npm run portal -- forget-secrets --yes   # key lost: drop all secrets, adopt the current key
```

One portal per data dir: a lock file (`portal.lock`) stops a second one, and stops `restore`,
`rotate-key` and `forget-secrets` while the portal runs.

## Behaviour

- The code and the sign-in switch live in memory: a restart goes back to `PORTAL_SERVER_CODE` (or a
  new generated code) and turns sign-in back on. Sign-ins survive restarts: they're kept in the
  database, which stores only a hash of each token.
- Rotating or setting a custom code signs out every other session.
- Turning sign-in off keeps existing sessions; nobody new can sign in until it's turned back on or
  the server restarts.
- Sessions: random token in an `HttpOnly; SameSite=Strict` cookie, 12 hours. Wrong codes are
  limited to 10 per address per 10 minutes. Cross-origin form posts are rejected (Hono `csrf`).
