---
description: Add a database migration the way this repository does it
argument-hint: <what it stores>
---
Migrations are append only (`apps/server/src/store/migrations.ts`, by set): never edit one that has been released (anything on `main`). Pick the next number in the block of the area
(`docs/coord/PLAN.md` lists the blocks; the latest number in the file is the end of the sequence), add the migration at the end with its DDL, keep it additive (new tables and columns with defaults),
and add or extend a test in `apps/server/src/store/` (`migrating an existing database takes a backup first` and the old-database tests show the pattern). Sealed columns go through `ENCRYPTED_COLUMNS`.
Run the store tests and `apps/server/src/qa/migrations.test.ts`. A migration that rewrites data needs the owner's approval first.
