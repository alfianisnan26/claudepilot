# PRD: Claude Code version pinning and the compatibility canary

| | |
| --- | --- |
| Status | **v1 built** (2026-10-13). Pin, registry, version reading, recreate, Apply and Rollback, the canary with its safe-mode guards, the scheduler, routes and the web are built; §16 says what was observed and what was not, §16.2 is the final report. |
| Owner | Alfian Isnan |
| Last updated | 2026-10-13 |
| Depends on | [Pools foundation](foundation-pools.md) §9 (the pinned image, detection, gates), [Workspace Claudes](workspace-claudes.md) (the runtime is the record), [MCP set pool](mcpset-pool.md) (FR14, §13.3), [Claude usage](claude-usage.md) (`get_usage`, `rate_limit_event`), [Settings & policies](settings-policies.md) (managed MCP lockdown), [Chat sessions](chat-sessions.md) (the stream-json protocol) |
| Related | [Targets: Connect](targets-connect.md) (images reach remote hosts by tag), [Portal MCP server](portal-mcp.md) (the read tools) |

## 1. Summary

Claude Code is the one dependency the portal cannot version itself: it ships weekly, and the portal parses its output
(the stream, `claude mcp list`, `claude plugin details`), writes its managed settings and relies on switches that
appeared in specific releases. Today the workspace image runs `npm install -g @anthropic-ai/claude-code` with nothing
pinned, so a rebuild can silently change what every new workspace runs, and nothing says which version a workspace has,
which features it is too old for, or whether a newer one would break the portal.

This PRD makes the version a **fact the portal pins, shows and changes only on purpose**:

- **Pinned.** The image installs an exact version from a build argument, labels itself with it and is tagged with it
  (`claudepilot-workspace:cc-2.1.296`). Claude Code's own updater is off in the image and in its managed settings.
- **Shown.** Each workspace shows what it is pinned to (the image label) next to what it really runs (`claude
  --version`, read inside it, with the time), says when they differ, and says which features its version is too old for.
- **One registry** of "feature → minimum version" shared by the server and the web, replacing the constants scattered
  through the areas.
- **Upgrade is an action with a canary.** A person picks a version; the portal builds its image, runs the **canary** (the
  stand-in Anthropic API, the existing testkits and the REAL CLI, in a throwaway container) and only a green canary
  offers **Apply**, which recreates the workspace's container from the new tag **keeping its home volume**. **Rollback**
  recreates it from the previous tag.
- **A scheduled canary** runs the behaviours the portal relies on against the **installed** version and the latest
  **candidate** (the npm registry's newest), reports each item as pass, fail or skipped with the real output, and warns
  when the candidate breaks something the installed version passes.

## 2. Background and problem

- `images/workspace/Dockerfile` installs Claude Code unpinned; the Docker target builds the image on first use and never
  again, so two portals (or one portal a month later) get different Claude Codes under the same tag.
- Version knowledge is scattered: `MIN_CLAUDE_VERSION` (settings/lockdown.ts), `MCP_MIN_CLAUDE` and `VERIFY_TESTED_CLAUDE`
  (mcp/spec.ts), `BROWSER_MIN_CLAUDE`, the account pool's `MIN_CLAUDE`, `SKILLSET_MIN_CLAUDE_VERSION`, each with its own
  copy of the comparison. Nothing shows a person which version a workspace has or why a feature is off.
- Several behaviours were observed on 2.1.296 only (every ✅ in the pool PRDs). A release can change any of them with no
  warning: the stream lines, the control requests, the `claude mcp login` flow, the `.mcp.json` fields, the managed
  settings keys. The first the portal hears of it is a broken session.
- Claude Code updates itself when it can write its install folder. The workspace user has `sudo`, so "it cannot" is luck.

## 3. Goals

1. Exact pin in the build argument, the image tag and the image label; auto-update off in the image and in the managed
   settings, proven by a check.
2. The version shown per workspace: pinned, running, checked-at; a warning dot when they differ or a feature is below its
   minimum; unknown shown as unknown.
3. One feature-minimum registry (contracts), each entry naming the feature, the minimum, why, and how it is known
   (observed or documented).
4. Upgrade by explicit action: build, canary, Apply (recreate keeping the home volume, after a confirm that names the
   running sessions). Rollback in one action. History per workspace.
5. A scheduled canary of the installed version and the latest candidate, per-item results with the real output, and a
   warning when the candidate breaks something.
6. Checks are data: another area adds one by adding a definition and a runner.

## 4. Non-goals

- Updating Claude Code in place (`claude update`, `npm install -g` through `exec`). The pin moves by recreating from
  another tag, so what runs is always an image someone can name.
- Keeping software a person installed outside the home folder (it lives in the container's layer; Apply says so).
- Running the canary against real accounts or the real Anthropic API: it uses a fake login and a stand-in; nothing leaves
  the machine.
- Bisecting an older minimum automatically. A registry entry says `observed on` the oldest version it was run on.
- Publishing images to a registry (Kubernetes and Connect pull tags; the image pipeline publishes `cc-<x.y.z>`).

## 5. Users and stories

One user (the owner); multi-user is coming (§17).

- *I see which Claude Code every workspace runs, and a dot when it is not what it should be.*
- *I pick 2.1.300, see whether it passes the portal's checks, apply it to one workspace, and if it misbehaves go back.*
- *Every week I get a report of what the newest Claude Code does to the behaviours the portal relies on, and a warning
  before I upgrade into a break.*
- *A feature that needs a newer Claude Code says which version it needs, on the screen where it is off.*

## 6. Facts observed on Claude Code 2.1.296 (this machine, the workspace image, offline)

| Fact | Observed |
| --- | --- |
| Install kind | `claude doctor` prints `Running: npm-global (2.1.296)`; the install folder is root-owned, so the `node` user's own `claude update` says "npm global folder isn't writable" |
| `DISABLE_AUTOUPDATER=1` | `claude doctor`: `Auto-updates: disabled (set by env: DISABLE_AUTOUPDATER)`; `claude update` still tries (the manual path) |
| `DISABLE_UPDATES=1` | `claude doctor`: `Auto-updates: disabled (set by env: DISABLE_UPDATES)`; `claude update` prints `Updates are disabled by your administrator.` and does nothing |
| As a managed `env` entry | The same two lines, with the switch set only in `/etc/claude-code/managed-settings.d/05-claudepilot-pin.json`; two drop-ins with `env` blocks merge; a user's own `settings.json` `env` cannot switch it back on |
| Legacy `autoUpdates: false` in `~/.claude.json` | `claude doctor` reports `DISABLE_AUTOUPDATER` (Claude Code migrates it) |
| `claude doctor` | Non-interactive, offline, prints the lines above: the canary asserts them |
| Registry | `https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags` answers `{ "stable": "2.1.287", "next": "2.1.296", "latest": "2.1.296" }` on 2026-10-12 |

## 7. Flow

```
 Overview  ──────────────►  scheduled canary: installed + candidate  ──►  report, warning
    │
 pick a version (a workspace's Claude Code section)
    │
    ├─ Build   docker build --build-arg CLAUDE_CODE_VERSION=x.y.z -t claudepilot-workspace:cc-x.y.z   (if missing)
    ├─ Canary  throwaway container from that image, stand-in API, real CLI: 11 checks, each pass / fail / skipped
    ├─ Plan    sessions that would be interrupted, what a recreate does not keep, the canary's failed items
    ├─ Apply   stop → recreate from the new tag, same home volume → start → deliver again   (history row)
    └─ Rollback  recreate from the previous tag                                              (history row)
```

## 8. Functional requirements

| # | Requirement |
| --- | --- |
| FR1 | The workspace image has `ARG CLAUDE_CODE_VERSION` (default = `DEFAULT_CLAUDE_CODE_VERSION`, a test keeps them equal), installs exactly `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`, labels itself `claudepilot.claude-version`, and sets `DISABLE_AUTOUPDATER=1` and `DISABLE_UPDATES=1` in its environment and in a managed drop-in. |
| FR2 | The Docker target builds an image for an exact version with that build argument and tags it `claudepilot-workspace:cc-<x.y.z>`; a version that is not exact x.y.z is refused. New workspaces get the default pin. `PORTAL_WORKSPACE_IMAGE` still overrides the whole reference. |
| FR3 | Containers carry `claudepilot.claude-version` and `claudepilot.image`. A workspace's `pinned` is the label; `running` is `claude --version` read inside it and cached with its time; both unknown stay null. |
| FR4 | `Workspace.claude` carries pinned, running and flags (`differs`, `below-minimum`, `auto-update-on`, `untested`). |
| FR5 | One registry (`CLAUDE_FEATURES`): feature, minimum, basis, observed-on, why, whether the portal degrades below it, source. The areas' constants derive from it and keep their exports. |
| FR6 | `claude doctor` is read for the auto-update state (`off`, `on`, `unknown`); a workspace whose updater is not off is flagged. |
| FR7 | The Runtime can recreate a workspace from another image keeping its home volume (Docker; Kubernetes patches the Deployment image). A failed recreate puts the previous container back. |
| FR8 | Apply needs: an exact version, its image on the target, a canary run on it that is green (failed items accepted by name only), and a confirm that names the running sessions and terminals when any run. Nothing is applied without that action. |
| FR9 | Rollback recreates from the previous tag of the workspace's history; pruning removes only unused, non-default, non-rollback images and lists first. |
| FR10 | The history table keeps per workspace: kind, from, to, images, when, who, canary run and verdict, accepted items, outcome. |
| FR11 | The canary runs in ONE throwaway container at a time, from the version's image (`image` mode) or from the installed image with the candidate installed in a scratch folder (`scratch` mode); the container is removed afterwards, with no network except `scratch`'s install. |
| FR12 | The checks are data (`CLAUDE_CANARY_CHECKS`) with one runner each; each reports pass, fail or skipped with the real output (redacted, clipped). |
| FR13 | The scheduled canary runs every `claude.canaryDays` days (default 7; 0 is off) for the installed version and the registry's newest; offline or an unreadable registry is recorded as `unavailable`, never as a pass. |
| FR14 | A warning when the candidate fails an item the installed version passes, when the installed version fails an item, when a workspace is below a minimum, when pinned and running differ and when its updater is on; through the existing alert hook now (notifications later). |
| FR15 | Portal MCP read tools: `claude_versions` (per workspace and the default) and `claude_minimums` (the registry). |
| FR16 | Every upgrade, rollback, build, prune, canary run and default change is audited with its actor. |

## 9. Data model

Migration block 300–319. `actor` is `u_owner` today (§17).

- `claude_version_history`: one row per apply or rollback (§FR10).
- `claude_canary_runs`: one row per run, results as JSON.
- `claude_version_events`: the audit trail.
- The default pin and the last candidate reading live in `portal_meta` (`claude_version:default`, `claude_version:candidate`).

## 10. API

See `CLAUDE_VERSION_API` in `packages/contracts/src/claudeversion.ts`; every route is behind the session guard and mutating
routes check the Origin like the rest.

## 11. Security requirements

- The canary never uses a real credential: a fake login (`FAKE-…`), a throwaway CA and a stand-in that lets only
  `api.anthropic.com` through its proxy. Nothing leaves the container except the candidate's npm install.
- Output shown to a person is the CLI's own text, redacted (`chat/redact.ts` patterns) and clipped; it is untrusted text.
- Apply, Rollback and prune need an explicit action; a prompt-injected agent cannot reach them (no Portal MCP write tool).
- Image tags and versions are validated as exact x.y.z before they reach a Docker call or a shell.

## 12. Observability and audit

`claude_version_events` and the history; a `claudeversion` live topic; warnings through the alert hook.

## 13. Testing and verification

Unit tests for the registry, the tag scheme, the version reading, the history, the check runners (against recorded
output) and the routes; a REAL canary run on this machine against 2.1.296 and a failing path (§16).

## 14. UX (text diet)

A compact chip where workspaces show (pinned and running, a dot when something is off, details in an InfoTip); a small
"Claude Code" section in the workspace's Configuration (Upgrade: pick, Test, the checks, Apply with a confirm; History,
Rollback); the canary report (history, per-item results, Run now, the cadence setting) and the candidate warning.

## 15. Decisions taken for the owner (2026-10-12), provisional

See §18.

## 16. Milestones and status

| Milestone | Scope | Status |
| --- | --- | --- |
| V1a | Contracts, registry, this PRD | **Built** (contracts typecheck) |
| V1b | Image pin, build argument, labels, tag scheme, auto-update off | **Built**; images `cc-2.1.296` and `cc-2.1.287` built through the portal's build-argument path (V1, 2026-10-12) |
| V1c | Version reading, flags, warnings plumbing, constants derived from the registry | **Built**; unit tests (`info.test.ts`, `service.test.ts`) |
| V1d | Recreate, history, Apply, Rollback, prune | **Built**; Apply recreated a real Docker workspace on 2.1.287 keeping its home volume (a marker file in home kept, a file outside home lost, as §4 says), then Rollback to 2.1.296 (V1, 2026-10-12) |
| V1e | The canary and its checks | **Built**: 13 checks; a real run on 2.1.296 passed 13 of 13, a real run on 2.1.287 failed `rate-limit-event` (no `usage_limit_reached` line: a real difference) (V1, 2026-10-12). The four safe-mode guards: §16.1 |
| V1e2 | The scheduled canary, candidate, report, warning | **Built**; the scheduled canary ran by itself in a scratch portal as `system:claude-canary` (V1, 2026-10-12) |
| V1f | Routes, Portal MCP tools, audit | **Built**; `routes.test.ts` |
| V2 | Web: version chip (workspace row and sheet), Claude Code section in Configuration (Upgrade with canary, per-item checks, accept by name, Apply confirm naming sessions, Rollback, history), Settings panel (installed, candidate, report, Run now, run history, warnings), MCP `claude_too_old` ⓘ | **Built** against the contract; looked at in Chromium at 390 and 1280 px, light and dark, with a stubbed API (server routes had not landed). Not seen against the real server. Refused actions show disabled with the reason; a 403 on Apply or Rollback disables them with the server's message. Cadence is the Claude group's Canary setting. |

### 16.1 The safe-mode guards (check `probe-safe-mode`)

The usage probe and the side-question one-shot start Claude Code with `--safe-mode` so a person's own hooks never run on a poll
(found 2026-10-12: the probe ran without it and every poll ran the workspace's SessionStart and SessionEnd hooks). The check runs the
portal's own probe command (`probeCommand`) three times in a project whose `.claude/settings.json` and the Claude's own settings both
carry SessionStart and SessionEnd hooks that each leave a marker file: with the flag, without it, and with `CLAUDE_CODE_SAFE_MODE=1`
in the environment alone. `judgeSafeMode` (`canary/checks.ts`) then applies four guards, in order; the first that fails fails the check:

| Guard | Passes when | Fails when |
| --- | --- | --- |
| (a) flag present | `claude --help` lists `--safe-mode` | the help does not list it (2.1.168 and older answer `unknown option`); nothing else is run |
| (b) hook marker | no marker under the flag, and markers without it | a marker under the flag; or no marker without it either (the test would prove nothing, so it is a fail, not a pass) |
| (c) `get_usage` still answers | under the flag the reply reads as a plan with at least two windows, the same windows as without the flag | no reply, not a plan, or other windows |
| (d) the variable is not a substitute | the probe's own command passes `--safe-mode` as an argument of `claude` | the command sets `CLAUDE_CODE_SAFE_MODE` instead, or carries no flag; what the variable alone does is reported (2.1.296: it stopped no hook) |

Requiring the control in (b) changed the check's meaning: `CLAUDE_CANARY_SUITE` is 2, so a canary run before it is "old" for Apply.

### 16.2 Final report (2026-10-13)

**Built.** Everything in §16's table; this round added the four guards as one pure judge (`judgeSafeMode`) and made the version
service's reading pass safe to call twice at once.

**Observed in tests** (`apps/server`, 2026-10-13):
- `canary/safemode.test.ts`, 6 tests, pass: each guard passing and failing on recorded observations, and the whole check against a
  fake CLI in a fake container (passes as 2.1.296 behaves; a CLI without the flag fails on the help and runs no probe; a CLI whose hooks
  never run fails (b)).
- `service.test.ts`, 21 tests: 5 runs in a row with a busy loop (`yes`) on the machine, 21 of 21 each time. Two new tests: two reading
  passes started together read each workspace once (`[2, 1]`), and `stop()` cancels the first scheduled tick; both fail on the old code.
- All `claudeversion` tests together with `claudeusage/probe.test.ts`: 91 tests, 89 pass, 2 skipped (the Docker canary, below).
- The "at most two per pass" failure was reported once, from a full-suite run made while that test file was still being written in a
  shared tree (the report is from about 07:05, the file was committed at 07:14 on 2026-10-12). It did not come back in 8 runs under load
  on the committed code. Two real timing faults were found by reading and are fixed: two passes side by side both saw an empty cache
  (it is written after each read's await) and read the same workspaces twice, and `stop()` left the first scheduled tick armed, so a
  stopped service still ran one pass.

**Not built or not seen.**
- The guards have not run against the real CLI: `canary.integration.test.ts` needs Docker (`CLAUDEPILOT_DOCKER_TESTS=1`) and the image,
  neither of which this workspace has. The real behaviour they encode (hooks run without the flag, none with it, the variable alone
  stops none, `get_usage` the same either way) was observed on 2.1.296 on 2026-10-12 by the usage track (claude-usage.md §11).
- The web against the real server (§16, V2).
- Kubernetes and Connect targets keep no image per version yet (`canRecreate` is false there).

## 17. Multi-user (light touch)

The version registry, the canary schedule and the candidate report are platform-level (admin acts: run a canary, Apply,
Rollback, prune). Applying an upgrade to one workspace will need manage rights on that workspace. Today every history row,
canary run and audit entry records `actor = 'u_owner'`, and workspaces are fetched through one helper so a check can be
added in one place. Today's single-owner behaviour is unchanged.

## 18. Decisions

- (2026-10-13) Guard (b) requires its control: without the flag the hooks must leave their markers, or the check fails. A marker test
  that cannot see a hook run proves nothing, and a pass there would be a guess.
- (2026-10-13) Guard (d) is judged on the portal's own command (the flag as an argument of `claude`), not on what the variable does: a
  later Claude Code that honours the variable alone passes and says so, but the probe keeps passing the flag.
- (2026-10-13) `CLAUDE_CANARY_SUITE` is 2 because (b) changed meaning; older runs need a new canary before an Apply.

## 19. Open questions

(filled in as built)
