# Track C: the phone and desktop UI, checked for real

The owner uses ClaudePilot daily from an iPhone (installed PWA, Safari) and a laptop. Read: `CLAUDE.md` (the UI rules), `docs/coord/QA-STANDARDS.md`
(A1-A9), `docs/prd/web-app-pwa.md` (section 10.5 is the phone chrome and the real-device checklist E1-E7), `docs/prd/chat-sessions.md` (btw, restart,
modes), and the earlier work: `docs/coord/prompts/s2.md` `ur.md` `ga.md` `gb.md`, `docs/coord/RESUME-BLOCKS.md` (status-s2, ur), `docs/coord/PLAN-21.md`.
Tools: Chromium with touch emulation and safe-area insets (`tools/qa/*.mjs`: `scroll-lock`, `mobile-drag`, `session-chrome` are the examples), a scratch
portal (`scripts/scratch-portal.sh`). Look at real screenshots; a green script is not a look.

## Items, in this order

1. **S2b, the btw UI against the real engine.** The engine is verified on the real Claude Code CLI; the UI (the `/btw` command with suggestions, the
   composer icon, the card above the composer, the side panel from 1280 px, the phone bottom sheet, a stable main transcript scroll) was only
   checked against a scripted socket. Run the S2 harness against a scratch portal with the stand-in API (`docs/coord/outbox-s1.md`, "THE REAL ENGINE
   ANSWERS"), fix what differs, keep the checks.
2. **The phone chrome, all the states.** The floating glass header and tab bar, the composer, the context ring and the five permission modes (Plan, Ask,
   Edit, Auto, Bypass) were built and checked at 390 px in one theme. Check dark and light, 360, 390, 430, 768 and 1280 px, landscape, the keyboard
   open (visualViewport), a long title, a long approval, Bypass on, a session with an approval waiting and one that restarts, the btw sheet over the
   header. Fix every overlap, cut-off, shift and double scroll. Do not undo the no-drag rules in `CLAUDE.md`.
3. **CI and deploy screens.** The run page with an approval waiting (Approve and Reject), the environments list in CI > Remotes, the raised-hand status
   in lists, the attention widget: phone first, both themes, keyboard, every control named, 44 px targets, no horizontal scroll.
4. **UI resilience (UR)**, only after 1 to 3 are merged: the shared `ChipList`, `ClampText` and live-list/skeleton helpers, a dev-only UI lab with
   extreme-data fixtures, the automatic browser checks (overflow, truncation without a tooltip, overlap, neighbour shift, layout shift, hit areas),
   the first audit of all screens and the standards update (`docs/coord/PLAN-21.md`, principles UR1-UR6). Migrate screens in small slices; every slice is
   merged on its own with its check.
5. **Onboarding and guidance (GA, GB)**, only if 1 to 4 are done: the first-run guidance and the in-product help the PRDs ask for.

## Done when

Items 1 to 3 are on `integration` with the gate green, the checks that keep them fixed are in `tools/qa/` or in tests, and your status file lists
what only a real iPhone can confirm (merge those into the checklist in `docs/prd/web-app-pwa.md` section 10.5). Items 4 and 5 are best effort: merge
each finished slice, leave the rest under NEXT.
