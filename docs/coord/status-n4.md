Spawn: model=opus effort=medium - Tier A: an automatic action that moves sessions between Claudes and spends quota (policy engine with safeguards, undo, audit); spec is detailed with hand-computed cases; escalate to opus/high if safeguards prove ambiguous
# N4 status (auto transfer) - 2026-10-12
STANDING RULES: K8s safety (env -u KUBECONFIG ... on every test), clean env portals (env -i), no third party, migrations 220-229 only, surgical edits, no edit in chat/controller.ts, heavy jobs behind flock heavy.lock, no commits, A.13: no container labelled claudepilot.managed (none started so far).
STABLE POINT (server): apps/server/src/autotransfer/{decide,store,settings,ports,engine,routes,authz,portalTools,index,testkit}.ts + tests (decide 29, engine 16, routes 4: all pass); server tsc clean for my files.
HOOKS MADE: store/migrations.ts (migration 220 appended); platform/index.ts (import + 1 register line); notify/templates.ts (1 line: auto_move warned title).
FOCUS NOW: web half (S2 done): features/autotransfer/** then mounts H13/H14/H15/H16.
RESUME HERE: check apps/web/src/features/autotransfer/ for what exists; continue with the missing piece.
