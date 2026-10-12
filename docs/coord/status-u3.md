# U3 status (glance framework + Quota widget) - 2026-10-12  -- FINISHED, final report sent

DONE: frame (chip, strips, popover, sheet, dock, GlanceRoot, badge, Settings > Glance, Quiet boundary), Quota widget (compact + lazy full),
settings keyed claudepilot.glance.u_owner, manifest shortcuts, ?glance=<id> and ?new=1 deep links, PRD docs/prd/glance-widgets.md (my
sections; §10 is U4's to fill), web-app-pwa.md surgical edits (status, FR6, 10.1, W4, A11), README index line.
Checks: web tests 222 green (29 mine), tsc clean, `npm run build -w @portal/web` passes, production build smoke-tested under the CSP.
Browser: fixtures and the REAL server (pace figures equal hand computation; reasons single_sample/signed_out/no_limits/stale; live push
30 % -> 8 %; badge spy 4), 390/800/1280, light+dark, every placement.
Cleanup done: scratch portal stopped, Docker workspace ugx deleted (container + volume gone), /tmp/ug* removed. No server code touched.

RESUME HERE (only if asked to extend): U4 fills PRD §10.1-10.4; when push lands (PLAN-5) the service worker can set the badge and open
/admin/sessions?glance=attention; when accounts land swap glance/user.ts currentUserId() for the auth user id and `mayUse` in
widgets/quota/quota.ts for the rows' rights.
