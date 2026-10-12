# S2 status (btw UI) - DONE (pending engine wiring by S1)

RESUME HERE: nothing required. Scratch portal stopped (tmux bvportal), Chromium closed by the harness.
Built: apps/web/src/features/chat/btw/{BtwCard,BtwSheet,BtwSidePanel,PinnedBtw,layout,slash,state}.ts(x), Composer (slash list + btw button), SessionPage wiring, useChatSocket btw state, Transcript pinned card, tools/qa/btw-layout.mjs + btw-fake.js, PRD chat-sessions.md 20.12, COORD/s2-checklist-items.md.
Verified: matrix 12 configs (6 sizes x light/dark, reduced motion at 1280): 555/562 first full run, the 7 failures were test races (synthetic scroll) and one hot-update break from other agents; fixed and re-run per config: phone-landscape 82/82, desktop-1280-dark 53/53, 1280-light 52/52. Not re-run as ONE full matrix after the last test fixes.
Unit tests: slash.test.ts, state.test.ts pass (6). web tsc: only error is targets/TargetSheet.tsx (not mine).
Not verified: real engine (btw_ask is not handled by the server socket yet), production build (heavy lock), real iOS.
