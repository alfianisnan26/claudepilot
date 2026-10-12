import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const dir = mkdtempSync(join(tmpdir(), 'pu-race-'));
const file = join(dir, 'a.db');
const a = new DatabaseSync(file); const b = new DatabaseSync(file);
a.exec('PRAGMA journal_mode=WAL');
a.exec(`CREATE TABLE teams (id TEXT PRIMARY KEY) STRICT; CREATE TABLE team_members (team_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY (team_id,user_id)) STRICT;
CREATE TRIGGER keep BEFORE DELETE ON team_members WHEN OLD.role='owner' AND EXISTS (SELECT 1 FROM teams WHERE id=OLD.team_id)
 AND (SELECT count(*) FROM team_members WHERE team_id=OLD.team_id AND role='owner' AND user_id<>OLD.user_id)=0 BEGIN SELECT RAISE(ABORT,'TEAM_NEEDS_OWNER'); END;
INSERT INTO teams VALUES ('t'); INSERT INTO team_members VALUES ('t','o1','owner'),('t','o2','owner');`);
b.exec('PRAGMA busy_timeout=0');
a.exec('BEGIN IMMEDIATE'); a.exec("DELETE FROM team_members WHERE user_id='o1'");          // A removes owner 1 (o2 remains: allowed)
let busy = false;
try { b.exec("DELETE FROM team_members WHERE user_id='o2'"); } catch (e) { busy = /locked|busy/i.test(e.message); }   // B cannot act on a stale view
assert.ok(busy, 'the second writer must wait (or fail busy), never act on stale state');
a.exec('COMMIT');
assert.throws(() => b.exec("DELETE FROM team_members WHERE user_id='o2'"), /TEAM_NEEDS_OWNER/);   // after A committed B sees one owner left
assert.equal(b.prepare("SELECT count(*) n FROM team_members WHERE role='owner'").get().n, 1);
console.log('race ok: with two connections the second writer is blocked, then the trigger refuses removing the last owner');
a.close(); b.close(); rmSync(dir, { recursive: true, force: true });
