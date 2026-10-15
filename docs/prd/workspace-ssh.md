# PRD: Workspace SSH and desktop agents (POC)

| | |
| --- | --- |
| Status | **Draft v0.3, POC.** S0 done locally on Docker: [evidence](evidence/t370-poc-byoa-ssh.md) (works; 14 findings folded in here). Nothing built in the portal. Slices: T-370 (S0 spike), T-371 (S1), T-372 (S2), T-373 (S3), T-374 (S4). v0.2: one Unix user per person (owner, 2026-10-15). |
| Owner | Alfian Isnan |
| Last updated | 2026-10-15 |
| Decisions | D-53 (bring your own agent, consent twice, internal only), D-54 (other agent CLIs later), D-56 (this design) |
| Depends on | [Workspace Claudes](workspace-claudes.md) (one Claude directory per sign-in), [Portal MCP](portal-mcp.md) (agent tokens, ticket tools), the delivery reconciler (managed settings under `/etc/claude-code`), the authorization seam (`apps/server/src/authz/seam.ts`) |
| Related | [Multi-user](multi-user.md) (people as users, MU1), [Targets and Connect](targets-connect.md) |

## 1. Summary

Today every piece of work runs inside pilot: a chat the portal starts, in the workspace, on a Claude signed in through the portal. This POC
adds a second door: a person connects **from their own desktop** (a terminal, or VS Code Remote-SSH) into the **same shared workspace**,
signs in **their own agent** there by hand, and works as they like. Pilot still **knows and shows** it: who is connected, which agent and
session they run, the session's transcript (read only), and the ticket they picked up through the Portal MCP.

The door is SSH, carried **through the portal** (no new port, no new host on the network): the desktop's `ssh` uses a small
`ProxyCommand` that opens a WebSocket to the portal with the person's access token; the portal checks it and pipes the bytes into
`sshd -i` started for that one connection inside the workspace, through the exec path the web shell already uses.

## 2. What exists (evidence)

| Piece | Today | Gap |
| --- | --- | --- |
| Web shell | WebSocket `GET /api/workspaces/<target>/<name>/shell` (`workspaces/shell.ts:41-62`), a pty through `docker exec` (`docker.ts:375`), kube `Exec` (`kubernetes.ts:551`) or Connect `host exec` (`connect/host.ts:144`); terminals are tmux sessions (`terminals.ts`) | cookie and same-origin only, no `can()`; no non-browser client |
| Claude sign-in | `claudeLogin.ts` runs `claude` in the workspace; the credential stays in `~/.claude` or `~/.claudepilot/claudes/<16 hex>`; registry `workspace_claudes` (`migrations.ts:383`) | no owner (person) on a Claude |
| SSH | `openssh-client` only (`images/workspace/Dockerfile:14`); nothing listens | no `sshd`, keys, forwarding or proxy |
| Managed settings | the reconciler writes `/etc/claude-code/managed-settings.d/*.json` with `hooks`, `env`, `permissions` (`delivery/ownership.ts:122-198`); the account pool's `StopFailure` hook appends to `~/.claudepilot/outbox/account.jsonl`, read later by the portal (`accounts/pools.ts:83-94, 586`) | no hook reports a session the portal did not start |
| Transcripts | the portal tails its own `out.*.jsonl` via `cp-session tail` (`chat/controller.ts:4039`) | nothing reads `~/.claude/projects/*.jsonl` |
| Portal MCP | `cpst_` agent tokens per chat session, scope `agent`, one workspace, 7-day TTL, in the process env (`portalmcp/agents.ts`); ticket tools incl. `ticket_claim_next` | no token for a person's desktop session |
| Sessions | `chat_sessions.origin` (`'ui'` default), `claude_id`, `ticket_id`, `started_by` | no notion of a session pilot observes but does not drive |

The workspace user is `node` (uid 1000) with passwordless `sudo` (`Dockerfile:33, 62`; pod `runAsUser: 1000`, `kubernetes.ts:385`).

## 3. Goals and non-goals

| ID | Goal |
| --- | --- |
| G1 | A person reaches a workspace from their desktop with plain `ssh` and VS Code Remote-SSH, through the portal only. |
| G2 | Every connection is authorized (`operate` on the workspace), attributed to a person, audited, visible live and revocable at once. |
| G3 | A person signs in their own Claude inside the workspace by hand; it is theirs (a person on the Claude), one sign-in per workspace (D-33). |
| G4 | Every agent session started over SSH appears in pilot within 15 s: person, agent, Claude, folder, branch, ticket, a read-only transcript. |
| G5 | The desktop agent picks up pilot work through the Portal MCP (`ticket_claim_next`, `ticket_update`), attributed to the person. |
| G6 | One Unix user per person: a person can use only their own agent sign-in; never another person's, never the portal's own Claudes, never the workspace's pool keys or secrets, in the workspace or through pilot. |

Non-goals of the POC: other agent CLIs (D-54, after the spike); driving a desktop session from pilot (it is observed, never driven); a
person's agent joining a crew's pool (the D-53 invitation is the next step: in the POC a person's Claude is never picked by `claude: auto`,
the factory or auto move); Connect targets (Docker and Kubernetes only); public exposure (the desktop reaches the portal URL as the browser
does: the private network today).

## 4. How a connection works

```
desktop: ssh ws-isnan-pod                      (~/.ssh/config: ProxyCommand pilot-ssh %h)
  -> pilot-ssh: WebSocket wss://<portal>/api/ssh/<workspaceId>, Authorization: Bearer <person's SSH access token>
  -> portal: token valid, not revoked, not expired; person may `operate` the workspace; audit row; connection row
  -> runtime exec, no TTY, binary: sudo sshd -i -f /etc/claudepilot/ssh/sshd_config  (one process per connection)
  -> sshd: logs in as the person's Unix user p-<label>, with THAT person's key only (per-connection AuthorizedKeysFile),
     SetEnv PILOT_PERSON, PILOT_CONN_ID
  -> ForceCommand /etc/claudepilot/bin/ssh-enter: consent once, welcome screen, then the login shell or the requested command
```

- **`sshd -i`** (inetd mode) speaks SSH on stdin and stdout: no daemon, no listening port, nothing to expose. It starts as root through
  `node`'s `sudo` only to authenticate and switch to the person's user, as any `sshd` does; `PermitRootLogin no`, `AllowGroups
  pilot-people`. The host key lives on the volume (`node`'s `~/.claudepilot/ssh/`, 700, made at first use), so the fingerprint is stable;
  the portal shows it and puts it in the config block, so the desktop never trusts on first use.
- **`sshd_config`** (delivered, read only): `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PubkeyAuthentication yes`,
  `AllowTcpForwarding local` (VS Code Remote-SSH needs a local forward), `AllowAgentForwarding no` (a desktop's keys never reach a shared
  workspace), `X11Forwarding no`, `PermitTunnel no`, `GatewayPorts no`, `PermitUserEnvironment no`, `ClientAliveInterval 30`,
  `ForceCommand /etc/claudepilot/bin/ssh-enter`.
- **No secret in an argument.** Before `sshd -i` starts, the portal writes, through the runtime's put: the person's public keys to
  `/etc/claudepilot/ssh/conn/<connId>/authorized_keys` (**root**, 644: in the person's home they could add keys of their own; S0 5.3), and the
  Portal MCP token to the person's `~/.claudepilot/ssh/conn/<connId>/` (their uid, 600). `-o AllowUsers=p-<label>` goes with every connection,
  or the person's key would log in as anyone (S0 5.2). The command line carries only paths and ids; the files go when the connection ends.
- **Unix users** are created with the password `*` (no password, not locked): `useradd`'s default `!` makes `sshd` refuse keys (S0 5.1).
- **Revocation** closes the person's WebSockets and ends every process of their Unix user (`pkill -u p-<label>`), also when they have no
  live connection: a detached process (the VS Code server) outlives its connection on purpose. A normal disconnect leaves it running so
  VS Code can reconnect. Measured in S0: disconnect in about 90 ms, processes 4 to 0 (S0 4.4).
- **`pilot-ssh`** is one Node file (Node 22's built-in WebSocket) downloaded from the access sheet; it reads the token from
  `~/.config/pilot/token` (mode 600), never from an argument. A single binary is a later step.

## 5. Identity and access

Until multi-user lands (MU1), a **person** is a label the owner creates (`hasyim`, `fadlilah`, …). Each person has:

- **SSH access tokens**: minted in the access sheet for one person and one or more workspaces, shown once, hashed at rest, TTL 30 days by
  default, revocable. Hashed like the Portal MCP agent tokens. Tests build fixtures at runtime (no token-shaped literal).
- **Public keys**: pasted in the sheet (`ssh-ed25519` and `ecdsa-sha2-*`; RSA ≥ 3072), fingerprint shown. A connection needs both the
  token (the portal's door) and the key (sshd's door).
- **A Unix user** `p-<label>` with a fixed uid the portal assigns (from 20001), so files on the volume keep their owner across pod
  restarts. It is created again (idempotent) before each `sshd -i`, since `/etc/passwd` is not on the volume. Group `pilot-people`; no
  `sudo`, not in `node`'s group, no password (so no `su`). The home is on the workspace volume, mode 700, mounted at `/home/people/<label>`
  (Kubernetes `subPath`, Docker volume subpath), so a person never crosses `/home/node`, which goes to 700.
- **Their own agent sign-in** in their home (`~/.claude`), readable by them only, made by hand with `claude` (terminal or the VS Code
  extension). The portal knows it as a `workspace_claudes` row with `person` and reads its state with `sudo -u p-<label> claude auth
  status`, never its files. No sign-in yet: the welcome screen says how.
- **Their own code and git identity**: a clone in their home, pushed with their own credentials, so every commit traces to them. The
  shared checkout under `/home/node` is not theirs to write.

**What a person can never use through this workspace** (G6; each one is a test in S1):

- another person's home, sign-in, outbox or connection files (homes 700, files 600, different uids);
- the portal's own Claudes and chats (`/home/node` 700, tmux sockets per uid);
- the account pool's keys (`/etc/claudepilot/account`, `root:node` 0750 and 0440, `accounts/pools.ts:577-579`) and the Secrets pool's
  env drop-in (0440, group `node`): `pilot-people` cannot read them. The managed drop-ins meant for `node` must not reach a person's
  Claude at all (an account `apiKeyHelper` it cannot run would break their own sign-in): they move to a path only `node`'s sessions load,
  or carry a guard. S0 measures what the pinned Claude Code does with an unreadable drop-in;
- the pod's Kubernetes service account token (mounted by default today: `kubernetes.ts` sets no `automountServiceAccountToken`): not
  mounted, or `node`-only if something in the workspace needs it (S0 finds out);
- another person's agent through pilot: the per-connection Portal MCP token has no session tools (section 8), and a person's Claude is
  never picked by `claude: auto`, the factory or auto move until that person accepts a crew invitation (D-53);
- `sudo`, `su`, a mounted Docker socket, other users' `/proc/<pid>/environ` (Linux allows that only to the same uid).

When MU1 lands, the person label maps to a user id and `operate` comes from the evaluator; the tables keep a `person` column that a
migration fills with `owner_id`.

**Consent (D-53).** The first interactive connection of a person to a workspace shows, and records their `yes` to: sessions here are seen
in pilot (who, what ran, the transcript); your home and your agent sign-in are yours only, but the workspace's administrator (the portal)
can reach every file in it; pilot work you claim is attributed to you. A non-interactive command (VS Code's first connect) before consent is refused with "connect once
from a terminal to accept". The consent is an audit row.

## 6. Welcome screen

`ssh-enter` prints, on an interactive login only, from a file the portal writes at connect (`~/.claudepilot/ssh/conn/<connId>/welcome`):
the person, the workspace, the agent sign-in state (signed in as…, or `claude` then `/login`), who else is connected now, the top open
tickets of the workspace's queue (key and summary), the rules in three lines (work on `dev/*` branches, never `main`, claim a ticket before
you start), and how to reach pilot. Short; no secret; nothing that needs the network from inside.

## 7. Observing sessions

- **Hooks**, delivered as a managed drop-in (`/etc/claude-code/managed-settings.d/50-claudepilot-desktop.json`), for `SessionStart`,
  `UserPromptSubmit`, `Stop`, `SessionEnd`: `/etc/claudepilot/bin/desktop-event` reads the hook JSON from stdin (`session_id`,
  `transcript_path`, `cwd`, `hook_event_name`) and appends one line to the person's own `~/.claudepilot/outbox/desktop.jsonl` (so nobody
  can write another person's events) with `PILOT_PERSON`, `PILOT_CONN_ID` and the git branch of `cwd`. It never posts to the network and never copies prompt text (the
  transcript has it). It runs only when `PILOT_CONN_ID` is set, so the portal's own chats are untouched.
- **Ingest.** While a workspace has a live SSH connection the portal reads that outbox every 10 s (else at the next connect), the same way
  as the account outbox, and keeps a **desktop session**: person, connection, agent (`claude`), Claude, Claude Code session id, folder,
  branch, transcript path, ticket, started, last event, ended.
- **Transcript.** The session view tails `transcript_path` through exec from a byte offset, read only, through `chat/redact.ts`, rendered
  as text and tool names (the full chat renderer is a later step).
- **In pilot:** the workspace shows "Connected now" (person, since, from); Sessions lists desktop sessions with a desktop badge and the
  person; the ticket shows "picked up by <person> (desktop)".

Monitoring is **cooperative** (owner acknowledged, 2026-10-15): the managed drop-in is root's, but a person can still work around the hooks
(another binary, another agent). What cannot be skipped is the connection record: every SSH connection goes through the portal. The portal
reads each person's outbox and transcript as root (`sudo`), never as them.

## 8. Picking up pilot work

Each connection gets a Portal MCP token (scope `agent`, the workspace, the person, the connection; it ends with the connection, at most
12 h). The portal writes it to the person's `~/.claudepilot/ssh/conn/<connId>/mcp-token` (600); a managed MCP entry for the portal reads it through a
headers helper keyed by `PILOT_CONN_ID` (to verify in the spike; fallback: `ssh-enter` exports it from that file into the session's environment).
The agent then has the ticket tools; a claim records the person and the connection, and the ingest links it to the desktop session. Agent
tokens keep their limits (`portalmcp/registry.ts:29`: no operate or admin tools), and a desktop token gets less: the read tools and the
ticket tools only, no `session_*` tool, so a desktop agent cannot start or steer a session on any Claude through pilot.

## 8a. Managing logins, sessions and people

Owner, 2026-10-15: logins and sessions in a workspace can be managed (removed) from pilot. Who: the person for their own; the admin for
anyone (offboarding). Every action is an audit row with ids only; the destructive ones ask for a confirmation.

| Action | How | Never |
| --- | --- | --- |
| Sign out one agent | the portal runs that CLI's own logout **as the person**: `claude auth logout`, `codex logout`, `cursor-agent logout` (each checked in S0's image). Gemini has no logout command: the portal removes its credential files under the person's `~/.gemini` (the Google token, the stored API key). Then it reads the sign-in state again | reads or copies a credential |
| Delete a desktop session | its row, and its transcript in the person's home (Claude `~/.claude/projects/<folder>/<id>.jsonl`, Codex `~/.codex/sessions/.../rollout-*.jsonl`, Gemini `~/.gemini/tmp/<proj>/chats/session-*.jsonl`, Cursor's chat store). A live session is ended first (revoke, or the person exits) | deletes another person's files without the admin's confirmation |
| Remove a person from a workspace | revoke their tokens, end their processes, sign out every agent; their home is **kept** until the admin deletes it with a second confirmation (destructive data, D-10) | deletes the home in the same step |
| Retention | desktop sessions follow the chat sessions' retention | |

UI: the SSH sheet gets **People**: per person their connections (Revoke), agents (state, Sign out), sessions (Delete) and Remove. None of
these are Portal MCP tools (people's data and sign-ins are `humanOnly`).

## 8b. What the pools give a person

Pools are delivered to system paths (`/etc/claude-code/managed-settings.d/`, `/etc/claude-code/CLAUDE.md` and `.claude/{agents,output-styles,
rules,skills}/`, the plugin marketplace at `/etc/claudepilot/marketplace`; `delivery/ownership.ts`, `delivery/types.ts:185`), so a
person's own Claude Code picks up whatever is world-readable there, with no extra step. Checked in the PoC as `p-bob` (2026-10-15): a
managed `CLAUDE.md` and a managed skill both reached the model request, and the skill was listed at init.

| Pool | A person's Claude Code over SSH | Other agent CLIs (D-54) |
| --- | --- | --- |
| Persona (CLAUDE.md, agents, output styles) | works (checked) | not yet: needs a translation (AGENTS.md, GEMINI.md, Cursor rules) |
| Context (rules) | works (same managed tree; from the code) | not yet |
| Skillset | works (checked for a managed skill; plugins from the marketplace: readable, not yet checked) | not yet (no shared format) |
| Policy (deny rules, models, effort) | applies (root 0644 drop-in; from the code) | not yet |
| MCP set | servers without a secret work; servers whose helper reads a secret fail (secrets are `node`-only) | not yet: translate to each CLI's MCP config |
| Secrets & env | not given, by design (0440 `node`; skipped with a warning, S0 4.5) | not given |
| Account pool | not given, by design: the person signs in themselves | n/a |
| Portal MCP (tickets, knowledge) | through the per-connection token (S4) | the CLIs that speak MCP, through the same token |
| Bypass | the portal's gates do not apply: a person can start their own Claude with `--dangerously-skip-permissions` (checked: `permissionMode: bypassPermissions`). Owner decision pending: allow with a visible badge, or forbid for people only | the same per CLI (`--yolo`, full-access modes) |

## 9. Data and storage

| What | Where | Retention |
| --- | --- | --- |
| People (until MU1) | table `people` (label, name, uid, created) | until removed |
| SSH access tokens | table, hash only, person, workspaces, expiry, revoked | 90 days after expiry or revocation |
| Public keys | table, person, key, fingerprint | until removed |
| Connections | table, person, workspace, token, start, end, end reason, bytes in and out | 90 days |
| Desktop sessions | table, see 7 | like chat sessions |
| Consent | audit row | like the audit |
| Host key | `node`'s `~/.claudepilot/ssh/` (700) on the volume | kept |
| Person homes | the volume, folder `people/<label>` (700, the person's uid) | kept when the person is removed, until the owner deletes it |
| Per-connection files | the person's `~/.claudepilot/ssh/conn/<connId>/` | removed at the end of the connection |

Migrations go in the next free block (`docs/coord/PLAN.md`); append only.

## 10. Slices

| Slice | What | Done when |
| --- | --- | --- |
| S0 spike (**done on Docker**, [evidence](evidence/t370-poc-byoa-ssh.md); Kubernetes items open) | On the real workspace image and the pinned Claude Code: `sshd -i` as `node` over `docker exec -i` and kube exec (binary, no TTY); `SetEnv`; `AllowTcpForwarding local` with VS Code Remote-SSH through a ProxyCommand; hook input fields; a headers helper for an MCP server; `sudo sshd -i` in the pod (privilege escalation allowed?); `useradd` with a fixed uid at runtime and the home mount; what the pinned Claude Code does for a person with an unreadable managed drop-in and with the account `apiKeyHelper`; whether anything in the workspace uses the service account token. Evidence file under `docs/prd/evidence/`. | each item ✅ or ❌ with the output |
| S1 transport | `openssh-server` in the image (no daemon); `sshd_config`, `ssh-enter`; the route `/api/ssh/<workspaceId>` (bearer, `operate`, audit, connection row, close on revoke); people, Unix users, tokens, keys; `pilot-ssh`; the G6 list as tests. | `ssh` and VS Code Remote-SSH from a second container as the desktop, on Docker and on a Kubernetes rig; a revoked token ends a live connection in < 2 s |
| S2 access UI | Workspace → SSH sheet: person, token (shown once), public key, config block with `HostKeyAlias` and the known-hosts line, download `pilot-ssh`; Connected now; revoke; People (8a): sign out an agent, delete a session, remove a person. 390 px first. | ux-checker PASS |
| S3 observe | Hooks drop-in, `desktop-event`, outbox ingest, desktop sessions, read-only transcript, welcome screen, consent. | a `claude` started over SSH shows in pilot in ≤ 15 s with person, branch and transcript |
| S4 work pickup | Per-connection Portal MCP token and managed MCP entry; claims attributed. | the desktop agent claims a ticket and the ticket shows the person and the desktop session |

The POC is done on the real job, not the mechanism (lesson of T-294): two people, each from their own machine, connected to the dev
workspace at the same time, each signed in to their own Claude, each claiming and working a ticket, both visible in pilot side by side.

## 11. Security

| Threat | Answer |
| --- | --- |
| A new way in from the network | none: no port, no host; only the portal's existing URL, the person's token and key |
| Stolen token | useless without the key; revocable; expires; per-workspace |
| Stolen key | useless without a valid token |
| A desktop's keys exposed to the workspace | agent forwarding off |
| Tunnels into the cluster | only local forwarding (VS Code needs it), no remote, no gateway, no tun; the reach is what `node` in the workspace can already reach |
| Secrets in process lists or logs | tokens only in mode-600 files; `pilot-ssh` never logs the token; audit rows carry ids, never values |
| A person using another's agent sign-in, the portal's Claudes, pool keys or secrets | a Unix user per person (section 5): 700 homes, no `sudo`, `node`-only paths, no service account token; desktop MCP tokens without session tools; never picked by `claude: auto` without an accepted invitation |
| Root in the workspace | only `sshd`, through `node`'s `sudo`, to switch user; people get none |
| A managed drop-in a person cannot read | Claude Code skips it with a warning ("policies from the failed source are NOT in effect"), it does not fail (S0 4.5). So a rule that must hold for people (a deny rule) never sits in a `node`-only drop-in: it goes in a root 0644 drop-in without secrets; pool drop-ins (`apiKeyHelper`, Secrets env) apply to `node`'s sessions only |
| Skipping the monitoring | hooks are cooperative (owner acknowledged); the connection record is not |
| The bypass gates | untouched: a desktop session is the person's own Claude Code under the repository's own settings; pilot does not drive it |

## 12. Testing

A real `sshd` in the Docker tests (CLAUDEPILOT_DOCKER_TESTS=1): connect, key mismatch refused, token revoked mid-session ends it, forwarding
rules hold (remote forward refused), consent gate for non-interactive commands; isolation: person A cannot read B's home, `node`'s home, an account key or the service
account token, cannot `sudo` or `su`, and A's desktop MCP token gets the same 404 on every `session_*` tool. Route tests: no token, wrong workspace, expired, revoked:
the same 404. A canary token planted in a test never reaches a log, a response, an audit row or an argument list. Hook script: fixture
stdin to one outbox line; ingest: outbox to desktop session. The real-job check of section 10 with evidence.
