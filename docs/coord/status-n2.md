Spawn: model=sonnet effort=medium - Tier B/C: web UI and a small service worker against a detailed spec and a landed contract; the server verifies the answer tokens (N1), so the worker only posts; verified by Node vm tests and Chromium; escalate to opus if the worker or tests stall
# N2 status (notify web) - DONE (web side), final report sent
BUILT: public/sw.js (push/click/subscriptionchange, __pilotPush hook), features/notify/** (page, Inbox, Setup: device, devices, channels, events matrix, quiet hours, answers; usePush, presence, Root, store, sessionFlag), 31 tests; web suite 295 green; tsc + build green.
HOOKS: H10 nav.ts + App.tsx (route, NotifyRoot), H11 lib/live.tsx (setPresence), H12 lib/auth.tsx (logout removes registration), H13 SessionPage menu item.
VERIFIED: Chromium vs stand-in portal (/tmp/n2-test, scripts kept, profile removed): worker, cookie fetch, refusal line, sign-out removal, live toast, 390/1280 light/dark.
RESUME HERE (if resumed): when N1 lands, rerun against real routes; replace 'notify' topic cast after H3; nav Bell unread count (AppShell); GET for session flag (request in outbox).
