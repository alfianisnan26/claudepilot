Spawn: P7 data placement audit (READ-ONLY) | opus | high | Tier A: audit across the whole schema, no code changes; stages a migration plan | 2026-10-12T06:56Z
# P7 status (prefix ps-, port 3331, CDP 9461, no migrations)
Focus now: inventory (3 read-only Explore helpers running: non-SQL stores, table write paths/retention, planned stores).
Done: plans read; tables listed from migrations.ts (~118 CREATE TABLE); wrote tools/db-measure.mjs (read-only measuring script, dbstat works on node 22.23 / sqlite 3.51.3).
Findings so far: QA-017's "500 MB" is browser JS heap, not DB size (API payload ~8 MB at 25k events); chat event text capped at 16,000 chars (chat/store.ts EVENT_TEXT_MAX); workspace_id = "<target>/<name>" (not stable across moves).
Next: synthetic seeder on a scratch data dir (/tmp/ps-data), measurements, then docs.
RESUME HERE: write seeder (scratchpad/ps-seed.mts) -> run -> db-measure -> backup timing -> write COORD/p7-inventory.md and docs/prd/data-placement.md.
