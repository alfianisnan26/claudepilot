# Orchestrator status (2026-10-13)

Session fe3df8bc in kubernetes/kohi-event, main folder ~/work/claudepilot, branch integration. Three packages, one sub-agent each.

## DONE
- B item 1, deploy waits -> "Deploy waits" notification (ci_waiting): merged as 9dd73e8 (notify tests 18/18 here). Migration 720 (existing devices that hear CI failures get it) is on B's branch, next merge.
- Pipeline gate script: shellcheck SC2015 fixed (1f045fe; the suite's shellcheck test failed on the coordinator's b6f141f).

## IN FLIGHT
- A slice 1 (fable, dispatched before the model rule): item 2 the rekey/limits hang, then T1 leftovers. The hang reproduced live in my gate at 05:56 (load 17 on 4 CPUs); A was given the PID to inspect read-only.
- B slice 2 (opus): item 2, V1 canary guards + deterministic service.test.ts + PRD report. B slice 1 finished: 41d4dc0 (boot leak, gate flake, usagespend side split), ad0b7e6 (migration 720), 98b2e09 (merge of integration); typecheck of the final tree not yet confirmed by B.
- C slice 1 (fable): item 1 btw UI against the real engine; two commits local, waiting on the heavy lock for its Chromium run.
- Gate on 9dd73e8 running (npm-ci, typecheck, web-build green; suite first pass: cpb-view and the deploy-pipeline e2e failed under load, shellcheck real and fixed; rerun-alone pass pending).

## DECISIONS
- Owner (2026-10-13 06:05): prioritise the auto-move web half (B item 5: suggestion card, divider mark, Undo, settings rows for threshold and destinations). It runs as its own slice in a new worktree dev-automove-web (branch dev/automove-web, opus) as soon as a sub-agent slot frees, ahead of N2 and N3.
- Model per slice (owner, 2026-10-13): sonnet for narrow checks, opus for implementation, fable only for hard diagnosis or after two failures. The first three slices ran on fable (dispatched before the rule); from slice 2 on the model is named next to each slice.
- Package B does item 6 (test leaks and flakes) right after item 1, before V1: the gate's reliability gates everything else. (Done.)
- The gate (b6f141f on integration) fails a hung test after GATE_TEST_TIMEOUT_MS and reruns failing files alone; package A fixes the cause, not the gate.
- Status-file-only commits are pushed to integration without a gate run (docs only, nothing executable). Same for a one-line script fix verified by its own test (shellcheck) when a gate is already queued behind it.
- B's branch merges integration instead of rebasing (its commits were already pushed; no force-push). Merge commits are kept as they are.
- A side question counts as a request for spike rules; "side" is a server-side split only, the Usage page does not show it yet (B's call, PRD claude-usage §22).

## NEEDS A HUMAN
- Multi-user (parked, not in this backlog): the owner wants the current single-owner access (workspace kohi-event, this session) reserved for a user `admin`; the password was given in chat on 2026-10-13 and must not be written anywhere: when that work starts, the owner sets it through the setup token or a Secret.
- After the next deploy: on the iPhone (Home Screen PWA, quiet hours off) confirm "Deploy waits" arrives when a deploy run holds for approval; migration 720 must have run on the real portal.
- Decide whether the Usage page should show "of which side questions".

## NEXT
- Gate green -> push integration (9dd73e8 + 1f045fe + status). Then merge B's 98b2e09 (migration 720 etc.), gate, push.
- A and C return -> review, targeted tests, gate, push; then A item 3 (T6 rig, opus), C item 2/3 (phone chrome, CI screens; opus), B item 3 (N2 web; opus).
- First deploy of the day once migration 720 and the notification are on integration with a green gate (ci_run_trigger, gate=false).
