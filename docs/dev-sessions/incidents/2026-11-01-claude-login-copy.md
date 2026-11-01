# Incident 2026-11-01: copied Claude logins signed each other out (decommission of kubernetes/kohi-event)

Status: **open**. Severity: **high** (4 Claude sign-ins lost in every workspace, live sessions on two of them will fail on their next
token use; no production, no uat, no secret printed). Written by the incident analyst from the C.9 ops report and its logs.
Incident ticket: **not opened yet** (no ticket API in the analyst's brief; the coordinator opens it, tag `incident`, linked to this file).

Where incidents live: the charter puts the post-mortem note in the knowledge vault (`Incidents/`). The repo had no incidents folder; this
file starts `docs/dev-sessions/incidents/` so the note is also reviewable in git. The vault note should link here.

## Evidence

All under the coordinator session's scratchpad (`.../6b18418b-4e83-41b3-ab37-55ab385890a8/scratchpad/`), not in the repo:

| Source | What it shows |
| --- | --- |
| `c9-decom-report.md`, F1 to F4 | the ops agent's own account: copy times, `stat` size and mtime of the old `.credentials.json`, the re-copy, the parking, the glob bug |
| `c9/created.jsonl` | the 9 new Claude rows, created 00:06:11 to 00:06:13 UTC |
| `c9/claudes-copy.log` | first copies of the Claude dirs (kubectl exec pipe), retries and manifest results, 00:08 to about 00:50 |
| `c9/claudes-copy2.log` (mtime 03:16) | second copy round |
| `c9/claudes-after.txt` (mtime 03:20) | `loggedIn` per new Claude after the re-copy, before the parking |
| `c9/ncp.sh`, `nsend.py`, `nrecv.py` | the pod-to-pod copy method (one-shot listener, plain TCP on the node-local pod network) |

Nobody, including this analysis, opened a `.credentials.json`. States come from `claude auth status` (two fields: `loggedIn`, method) and
file size and mtime only. The logs were checked for token-shaped strings by count (0 matches in every log and script); none is quoted here.

## Timeline (UTC, 2026-11-01)

| Time | Event | Source |
| --- | --- | --- |
| before 00:05 | Owner chooses to copy the 8 signed-in Claude config dirs instead of signing in again. Coordinator tells the owner "the old pod is stopped right after, so the two copies never run at the same time". | coordinator's account in the incident brief |
| before 00:05 | Coordinator briefs the ops agent (C.9) to copy the Claude dirs while the old pod and its sessions keep running, with no cut ordering and no rule on credentials. | coordinator's account; C.9 report header ("old pod read only") |
| 00:05 | All 8 Claudes `loggedIn=true` on kubernetes/kohi-event. | C.9 report F1 |
| 00:06 | 9 Claudes created in isnan/isnan and konfersi/konfersi. | `created.jsonl` |
| 00:08 to about 00:50 | First copies, credentials included: regitha 00:08, rossi and sekar about 00:11 to 00:15, one.claude partly about 00:50 (several API-server stream drops). Two live copies of each refresh token exist from here on. | `claudes-copy.log`; report F1 |
| 00:09 | New regitha `loggedIn=true`: the copied login works. | report F1 |
| 01:41, 01:52, 02:22, 03:14 | The OLD pod rewrites `.credentials.json` to a 288-byte signed-out file for rossi, sekar, one.claude, regitha (signed-in files are 516 to 524 bytes). **Start of impact on the old side.** | `stat` in report F1 |
| about 03:15 | Ops agent copies these 4 dirs a second time without checking either side's state. The old signed-out files overwrite the new copies. **Start of impact everywhere.** | report F1; `claudes-copy2.log` mtime 03:16 |
| 03:20 | New rossi, regitha, sekar, one.claude `loggedIn=false`; new two.claude, fadlilah, hasyim, satria still `true` (same refresh token as the old pod). **Detected** by the ops agent's own check. | `claudes-after.txt` |
| 03:20 to 03:45 | Containment of the other 4: new `.credentials.json` renamed to `.credentials.json.parked-c9` (`mv -n`). | report F2 |
| about 03:26 to 03:43 | Secondary: a glob in the fallback-transcript script picked up other groups' chunk lists; a retry removed about 1,243 files in the new dirs. Re-copied and diffed old against new by size and path manifest; nothing missing. | report F3; `fbdone/` and `misc/` mtimes |
| 03:45 | Ops agent reports, failures first, naming the re-copy as its own error. | `c9-decom-report.md` |

Undetected for: 1 h 39 min from the first signed-out write in the old pod (01:41) to the check at 03:20. Nothing watched for it.

## Cause

### Proved

1. **The first wrong step is the brief, not the copy.** The coordinator promised the owner one order (stop the old pod, then copy) and
   briefed the opposite (copy while the old pod and its sessions run). The brief had no cut ordering and did not treat
   `.credentials.json` differently from transcripts. That statement to the owner was contradicted by the brief: under the charter
   that is a false claim, recorded here as the cause, not softened.
2. **Two live copies of one OAuth login.** A Claude Code login is one refresh token; refreshing it replaces it. Copying the file while
   the source runs leaves two holders of one token; the first to refresh invalidates the other. The old pod's files went to the
   signed-out size at 01:41 to 03:14 while the new copies had been signed in (regitha `true` at 00:09). The old side lost, so the
   refresh happened on the new side (or anywhere other than the old pod).
3. **The re-copy without a state check.** At about 03:15 the 4 dirs were copied again from a source that was already signed out (all
   four stub writes predate 03:15). No step compared `loggedIn` on both sides, or the file size, before overwriting.

### Suspected, not proved

- **What refreshed the token in the new pod.** No session was started there. The only Claude Code process run against those dirs is the
  portal's `claude auth status --json` probe (`apps/server/src/claudeusage/probe.ts`, `parse.ts`; also asked before a session start,
  `chat/controller.ts`). Whether `auth status` refreshes an expiring access token is not verified.
- **That the new copies were still valid just before 03:15.** Nobody checked their state between 00:09 and the re-copy. If the new side
  had also lost its token by then, the re-copy destroyed nothing that still worked; the outcome for the 4 accounts is the same either way.

## Containment

- **Done:** the remaining 4 (fadlilah, hasyim, satria, two.claude) are parked in the new pods (`.credentials.json.parked-c9` in konfersi
  `dd1af5c956617293`, `2fd6445d7a9236de`, `5589af6047eccee7`, isnan `11c75f46517a7c3c`), so only the old pod holds a live copy. Their
  live leads keep working.
- **Needed from the owner (a person):** sign in again for rossi, regitha, sekar and one.claude, once, in the NEW workspace
  (konfersi `ad72ce83e77dc0a2`, `e86293ac1bf54b12`, `0e4a55bd4b8f4eb3`; isnan `2e7e10a08c3c6640`).
- **At the cut (ordered):** stop every old session on fadlilah, hasyim, satria, two.claude; copy each old `.credentials.json` once,
  file to file, fresh (the parked one may be stale); run nothing in the old pod afterwards; delete the `.parked-c9` files; verify
  `loggedIn=true` in the new workspace.

### Still exposed

- Old live or asleep sessions on sekar ("Konfersi: Business" `4b69a73b`, `414d14d5`) and one.claude (`ca70df4e`, `2c7b3077`) will fail on
  their next token use, until the owner signs in and the sessions move.
- The parked files hold a refresh token that the old pod still uses. They are inert (Claude Code reads only `.credentials.json`), but they
  are a second copy at rest on the new PVCs until the cut.
- Credential files crossed k3s-node2's pod network as plain TCP (the later `ncp.sh` copies, seconds each, listener bound to the target
  pod IP). Not printed and not stored outside the pods. Whether that is acceptable for credentials is for a person to decide.
- The old PVC (Retain) and the C.2 backup (`~/migration-backup-2026-10-31` on that PVC) may hold more copies of the 4 still-valid logins.
  Not checked.

## The check that would have caught it

None existed. Any one of these stops it:

1. **A portal operation "Move Claude login"** (preferred, removes the hazard): from a source Claude to a target Claude. It refuses while
   the source Claude has any live or asleep session (or stops them after an explicit acknowledgement), moves `.credentials.json` once
   over the authenticated channel, leaves the source without a usable credentials file, and writes an audit row (ids only). A second move
   from the same source refuses. Two live copies can then never exist, and a re-copy is impossible by construction.
2. **A precondition in any ops copy of a Claude dir:** exclude `.credentials.json` from bulk dir copies by default; copy it only by its own
   step, which refuses while the source workspace has running sessions on that Claude, refuses when the target already has
   `loggedIn=true`, and refuses when the source reports `loggedIn=false`.
3. **A brief and review question** for every migration and decommission brief: "Does any step leave two live copies of a credential, and
   is the source stopped before the copy?" And for the coordinator: what the owner is told about ordering is copied into the brief word
   for word.

## Follow-up tickets (proposed; the analyst builds none of them)

| # | Ticket | The test it must carry |
| --- | --- | --- |
| 1 | **Move Claude login** between workspaces: server route through the authz seam plus a button on the Claude row; stop-or-refuse the source, move once, audit. | (a) 409 or the same denial when the source Claude has a live or asleep session; (b) after the move the source has no `.credentials.json` and the target has it, byte for byte (fixture built at runtime, no token-shaped literal); (c) a second move from the same source refuses; (d) the audit row and the response hold ids only, no file content. Each must fail on the parent commit. |
| 2 | **Decommission runbook with the cut ordering** (`docs/`, plus a line in the ops brief template): stop old sessions, copy each credential once, never two live copies, verify both sides before and after. | Review checklist item; the runbook is linked from the next decommission brief. |
| 3 | **Investigate whether `claude auth status` refreshes the token.** If it does, the probe must not be the thing that rotates a just-imported login; document it either way. | A probe test asserting the probe never writes the credentials file of the Claude dir it checks (mtime and size unchanged on a fixture dir), or a written finding that it cannot. |
| 4 | **Owner action, incident ticket:** sign in again for rossi, regitha, sekar, one.claude; then move their old sessions. | `loggedIn=true` read back per Claude. |

Process lessons, not product tickets: an ops script must never delete by a relative path list on retry (the F3 glob bug); work in one
folder per chunk. Credentials over plain TCP inside the pod network is a wall question for a person.

## Unit

Voided: the C.9 decommission-prep unit as far as the Claude dirs go (its "verify `auth.loggedIn` true" criterion is not met for any of the
8), and the coordinator's brief for it. The session-dir, CI-run and transfer copies in C.9 were each verified by manifest and are arguably
clean; a stricter reading re-verifies them at the cut, when the live sessions are re-synced anyway. The owner decides.

Lesson: a login is one token, not a file; move it once with the source stopped, never copy it.
