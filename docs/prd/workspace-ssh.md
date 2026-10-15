# PRD: Workspace SSH and desktop agents (POC)

| | |
| --- | --- |
| Status | **Draft v0.1, POC.** Nothing built. |
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

Non-goals of the POC: isolation between people in one workspace (they share the Unix user `node`, which has `sudo`); other agent CLIs (D-54,
after the spike); driving a desktop session from pilot (it is observed, never driven); Connect targets (Docker and Kubernetes only); public
exposure (the desktop reaches the portal URL as the browser does: the private network today).

## 4. How a connection works

```
desktop: ssh ws-isnan-pod                      (~/.ssh/config: ProxyCommand pilot-ssh %h)
  -> pilot-ssh: WebSocket wss://<portal>/api/ssh/<workspaceId>, Authorization: Bearer <person's SSH access token>
  -> portal: token valid, not revoked, not expired; person may `operate` the workspace; audit row; connection row
  -> runtime exec, no TTY, binary: sshd -i -f /etc/claudepilot/ssh/sshd_config  (one process per connection, as `node`)
  -> sshd: public key of THAT person only (per-connection AuthorizedKeysFile), SetEnv PILOT_PERSON, PILOT_CONN_ID, CLAUDE_CONFIG_DIR
  -> ForceCommand /etc/claudepilot/bin/ssh-enter: consent once, welcome screen, then the login shell or the requested command
```

- **`sshd -i`** (inetd mode) speaks SSH on stdin and stdout: no daemon, no listening port, nothing to expose. Non-root `sshd` can only log
  in as itself, which is what we want. The host key lives on the volume (`~/.claudepilot/ssh/host_ed25519_key`, made at first use), so the
  fingerprint is stable; the portal shows it and puts it in the config block, so the desktop never trusts on first use.
- **`sshd_config`** (delivered, read only): `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PubkeyAuthentication yes`,
  `AllowTcpForwarding local` (VS Code Remote-SSH needs a local forward), `AllowAgentForwarding no` (a desktop's keys never reach a shared
  workspace), `X11Forwarding no`, `PermitTunnel no`, `GatewayPorts no`, `PermitUserEnvironment no`, `ClientAliveInterval 30`,
  `ForceCommand /etc/claudepilot/bin/ssh-enter`.
- **No secret in an argument.** The per-connection files (authorized keys, the Portal MCP token) are written by the portal through the
  runtime's put into `~/.claudepilot/ssh/conn/<connId>/` (mode 600) before `sshd -i` starts, and removed when the connection ends. The
  command line carries only paths and ids.
- **Revocation** closes the WebSocket: the exec ends, `sshd` ends, the shell gets SIGHUP. A process that detached (the VS Code server
  does, to survive reconnects) is ended by the portal by its `PILOT_CONN_ID` (S1 proves it).
- **`pilot-ssh`** is one Node file (Node 22's built-in WebSocket) downloaded from the access sheet; it reads the token from
  `~/.config/pilot/token` (mode 600), never from an argument. A single binary is a later step.

## 5. Identity and access

Until multi-user lands (MU1), a **person** is a label the owner creates (`hasyim`, `fadlilah`, …). Each person has:

- **SSH access tokens**: minted in the access sheet for one person and one or more workspaces, shown once, hashed at rest, TTL 30 days by
  default, revocable. Hashed like the Portal MCP agent tokens. Tests build fixtures at runtime (no token-shaped literal).
- **Public keys**: pasted in the sheet (`ssh-ed25519` and `ecdsa-sha2-*`; RSA ≥ 3072), fingerprint shown. A connection needs both the
  token (the portal's door) and the key (sshd's door).
- **Their own Claude** in each workspace: a `workspace_claudes` row gets `person`; `SetEnv CLAUDE_CONFIG_DIR` points the SSH session at that
  person's directory, so `claude` (terminal or the VS Code extension) uses their sign-in. No sign-in yet: the welcome screen says how.

When MU1 lands, the person label maps to a user id and `operate` comes from the evaluator; the tables keep a `person` column that a
migration fills with `owner_id`.

**Consent (D-53).** The first interactive connection of a person to a workspace shows, and records their `yes` to: sessions here are seen
in pilot (who, what ran, the transcript); everyone with access to this workspace shares its files, including signed-in agents' credentials;
pilot work you claim is attributed to you. A non-interactive command (VS Code's first connect) before consent is refused with "connect once
from a terminal to accept". The consent is an audit row.

## 6. Welcome screen

`ssh-enter` prints, on an interactive login only, from a file the portal writes at connect (`~/.claudepilot/ssh/conn/<connId>/welcome`):
the person, the workspace, the agent sign-in state (signed in as…, or `claude` then `/login`), who else is connected now, the top open
tickets of the workspace's queue (key and summary), the rules in three lines (work on `dev/*` branches, never `main`, claim a ticket before
you start), and how to reach pilot. Short; no secret; nothing that needs the network from inside.

## 7. Observing sessions

- **Hooks**, delivered as a managed drop-in (`/etc/claude-code/managed-settings.d/50-claudepilot-desktop.json`), for `SessionStart`,
  `UserPromptSubmit`, `Stop`, `SessionEnd`: `/etc/claudepilot/bin/desktop-event` reads the hook JSON from stdin (`session_id`,
  `transcript_path`, `cwd`, `hook_event_name`) and appends one line to `~/.claudepilot/outbox/desktop.jsonl` with `PILOT_PERSON`,
  `PILOT_CONN_ID`, `CLAUDE_CONFIG_DIR` and the git branch of `cwd`. It never posts to the network and never copies prompt text (the
  transcript has it). It runs only when `PILOT_CONN_ID` is set, so the portal's own chats are untouched.
- **Ingest.** While a workspace has a live SSH connection the portal reads that outbox every 10 s (else at the next connect), the same way
  as the account outbox, and keeps a **desktop session**: person, connection, agent (`claude`), Claude, Claude Code session id, folder,
  branch, transcript path, ticket, started, last event, ended.
- **Transcript.** The session view tails `transcript_path` through exec from a byte offset, read only, through `chat/redact.ts`, rendered
  as text and tool names (the full chat renderer is a later step).
- **In pilot:** the workspace shows "Connected now" (person, since, from); Sessions lists desktop sessions with a desktop badge and the
  person; the ticket shows "picked up by <person> (desktop)".

Monitoring is **cooperative**: someone in the workspace can stop the hooks or write the outbox (shared user, `sudo`). What cannot be
skipped is the connection record: every SSH connection goes through the portal.

## 8. Picking up pilot work

Each connection gets a Portal MCP token (scope `agent`, the workspace, the person, the connection; it ends with the connection, at most
12 h). The portal writes it to `~/.claudepilot/ssh/conn/<connId>/mcp-token`; a managed MCP entry for the portal reads it through a
headers helper keyed by `PILOT_CONN_ID` (to verify in the spike; fallback: `ssh-enter` exports it from that file into the session's environment).
The agent then has the ticket tools; a claim records the person and the connection, and the ingest links it to the desktop session. Agent
tokens keep their limits (`portalmcp/registry.ts:29`: no operate or admin tools).

## 9. Data and storage

| What | Where | Retention |
| --- | --- | --- |
| People (until MU1) | table `people` (label, name, created) | until removed |
| SSH access tokens | table, hash only, person, workspaces, expiry, revoked | 90 days after expiry or revocation |
| Public keys | table, person, key, fingerprint | until removed |
| Connections | table, person, workspace, token, start, end, end reason, bytes in and out | 90 days |
| Desktop sessions | table, see 7 | like chat sessions |
| Consent | audit row | like the audit |
| Host key, per-connection files | workspace volume `~/.claudepilot/ssh/` | host key kept; per-connection files removed at the end |

Migrations go in the next free block (`docs/coord/PLAN.md`); append only.

## 10. Slices

| Slice | What | Done when |
| --- | --- | --- |
| S0 spike | On the real workspace image and the pinned Claude Code: `sshd -i` as `node` over `docker exec -i` and kube exec (binary, no TTY); `SetEnv`; `AllowTcpForwarding local` with VS Code Remote-SSH through a ProxyCommand; hook input fields; a headers helper for an MCP server. Evidence file under `docs/prd/evidence/`. | each item ✅ or ❌ with the output |
| S1 transport | `openssh-server` in the image (no daemon); `sshd_config`, `ssh-enter`; the route `/api/ssh/<workspaceId>` (bearer, `operate`, audit, connection row, close on revoke); people, tokens, keys; `pilot-ssh`. | `ssh` and VS Code Remote-SSH from a second container as the desktop, on Docker and on a Kubernetes rig; a revoked token ends a live connection in < 2 s |
| S2 access UI | Workspace → SSH sheet: person, token (shown once), public key, config block with `HostKeyAlias` and the known-hosts line, download `pilot-ssh`; Connected now; revoke. 390 px first. | ux-checker PASS |
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
| People reading each other's agent sign-ins | **not solved in the POC**: one shared user with `sudo`. Said on the consent screen. Later: a Unix user per person and no `sudo` for SSH people |
| Skipping the monitoring | hooks are cooperative; the connection record is not |
| The bypass gates | untouched: a desktop session is the person's own Claude Code under the repository's own settings; pilot does not drive it |

## 12. Testing

A real `sshd` in the Docker tests (CLAUDEPILOT_DOCKER_TESTS=1): connect, key mismatch refused, token revoked mid-session ends it, forwarding
rules hold (remote forward refused), consent gate for non-interactive commands. Route tests: no token, wrong workspace, expired, revoked:
the same 404. A canary token planted in a test never reaches a log, a response, an audit row or an argument list. Hook script: fixture
stdin to one outbox line; ingest: outbox to desktop session. The real-job check of section 10 with evidence.
