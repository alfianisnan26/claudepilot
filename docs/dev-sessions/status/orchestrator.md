# Orchestrator status (2026-10-13)

Session in kubernetes/kohi-event (moved from hasyim to alfian.isnan at 06:45 after a session limit), main folder ~/work/claudepilot, branch integration. Three packages, one sub-agent each.

## DONE (on local integration, push waits for the gate on b893ac8)
- B item 1, deploy waits -> "Deploy waits" notification (ci_waiting): 9dd73e8; migration 720 (existing devices that hear CI failures get it): ad0b7e6 via cc838d9.
- B item 6, tests that leak or flake, side-usage split: 41d4dc0 via cc838d9. B item 2, V1 canary guards + report: e818540, af7bf08.
- A items 1 and 2: the gate hang's cause (a stop landing while the agent dials; 7d41bc7), scratch-portal observations (f31f6ca) via e653847.
- C item 1, btw UI against the real engine (tools/qa/btw-real.mjs, the card says how many messages the answer saw): a97a950.
- Gate hygiene: shellcheck SC2015 (1f045fe), repo-find sorted (8b3316a), deploy-pipeline e2e test: the fakes' PATH in ~/.profile (b893ac8; /etc/profile resets PATH in a login shell and the real kubectl installed today at /usr/local/bin won; the test's wait now says which step failed). Passes alone 7/7.

## IN FLIGHT
- Owner requests (07:00, in the main folder, branch integration, uncommitted until typecheck + gate): (1) phone layout scrolls sideways: an audit at 390 px is queued on the lock (/tmp/cp-qa/hscroll.mjs against scratch portal 3417); (2) Pinned sessions: contracts, migration 381, pin/unpin routes, chips Pinned · Idle · Needs you · Working · Ended · Archived · All, default chip Pinned or Idle, pinned first in a group, ⋯ Pin/Unpin on rows and the session page; (3) swipe right = Pin, left = Archive on rows (apps/web/src/features/chat/swipe.ts, tested); (4) image upload "could not save the file in the workspace (exit 4)": the host's put now reports `#short <got> <expected>`, the portal says "X of Y bytes arrived" and tries once more (stage.test.ts); the transport was checked whole with 6 MB over the real Kubernetes exec from this pod and over the Connect host transport in memory (host.bigstdin.test.ts): the cut is not reproduced here.
- Gate on b893ac8 (started 06:58 under the heavy lock, log /tmp/orch-gate-b893ac8.out). Green -> push integration.
- B item 5, auto-move web half (opus, worktree dev-automove-web, branch dev/automove-web, scratch port 3411): continues the uncommitted wiring the first sub-agent left (card, divider, Undo, menu item, settings rows).
- A item 3, T6 acceptance and abuse (opus, dev-track-a-connect, port 3413, rig namespace dev-rig-connect).
- C item 2, phone chrome all states (opus, dev-track-c-ui, port 3415).

## DECISIONS
- Owner (06:05): the auto-move web half runs ahead of N2 and N3.
- Model per slice (owner): sonnet for narrow checks, opus for implementation, fable only for hard diagnosis or after two failures.
- The gate fails a hung test after GATE_TEST_TIMEOUT_MS and reruns failing files alone; the cause is fixed in the package, not the gate.
- Status-file-only commits are pushed without a gate run (docs only). B's branch merges integration instead of rebasing. Merge commits are kept.
- A side question counts as a request for spike rules; "side" is a server-side split only (PRD claude-usage §22); the Usage page does not show it yet.
- Housekeeping at the move: two orphaned `yes` processes (a load simulation from B's worktree, 2 CPUs for 45 min) and the scratch portals 3405 and 3409 were stopped.

## NEEDS A HUMAN
- Upload exit 4 (owner, 07:05): which workspace was it (kohi-event on the cluster, or a Connect target on the Mac: Docker or host)? After the next deploy the error names the byte counts; that tells whether the transfer is cut (transport) or the size is wrong (blob). A Docker-via-Connect exec goes through the agent's proxied hijack (connect/agent/services/docker/proxy.ts), not covered by the in-memory check.
- Multi-user (parked, not in this backlog): the owner wants the current single-owner access (workspace kohi-event, this session) reserved for a user `admin`; the password was given in chat on 2026-10-13 and is written nowhere: when that work starts, the owner sets it through the setup token or a Secret.
- After the next deploy: on the iPhone (Home Screen PWA, quiet hours off) confirm "Deploy waits" arrives when a deploy run holds for approval; migration 720 must have run on the real portal.
- Decide whether the Usage page should show "of which side questions".
- T6: whatever still needs Docker, macOS, Windows or a second cluster (A's report will list it).

## NEXT
- Gate green -> push integration (19+ commits). Then merge each branch as it reports, targeted tests, gate, push.
- After the three slices: B item 3 (N2 web, opus), B item 4 (N3 triggers, sonnet/opus), C item 3 (CI screens, opus), A item 4 (T5 second pass, opus), then C items 4 and 5.
- First deploy of the day once integration is pushed with a green gate (ci_run_trigger, gate=false): the deploy-waits notification and migration 720 are user-visible.
