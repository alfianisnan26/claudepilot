# P5 tools (scratch, not repo code)

Run from `/workspaces/claudepilot/apps/server` with `NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx <file>` (the `.mts` ones) or `node <file>`.

- `dump-routes.mts`: builds the real `createApp` with stub services and prints `app.routes` (writes nothing). Redirect to `routes.txt`. The enumeration test of work package MU2 does the same inside the suite.
- `policy-gen.mjs`: the route policy v0 (rules by pattern) -> a markdown table; prints coverage (routes, covered, unmatched, rules that match nothing). Needs `routes.txt` beside it. Appendix A of docs/prd/authorization.md is its output.
- `tools-gen.mjs` + `tools.tsv`: the same for the 87 Portal MCP tools (Appendix B).
- `dump-schema.mts`: runs every migration in memory and prints each table's columns.
- `../p5-schema-check.mts`: the DDL of identity, authorization and teams run on top of the real migrations with every invariant asserted.
- `hono-routes.mjs`: shows `c.req.matchedRoutes` and `app.routes` for a composed Hono app (the basis of the central policy middleware).
- `scrypt-bench.mjs`: the scrypt parameter benchmark. `race-check.mjs`: the two-connection race on a team's last owner.
- `tablecheck.mjs <md files>`: GFM table column check (a pipe inside a code span splits a cell unless escaped). `coverage.mjs`: object type by door counts.
