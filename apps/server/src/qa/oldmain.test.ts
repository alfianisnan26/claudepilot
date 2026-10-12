// QA-013: a database written by the older build (pool migrations numbered 9-12) freezes at start, and the frozen reason now names the one
// statement that repairs it. This builds such a database (schema 1-8 and the pool migrations, numbered the old way), checks the reason, runs
// the statement from the reason itself on it, and checks the portal then migrates it and is healthy.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../store/migrations.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';

test('an old-numbering database freezes with the repair in its reason, and the repair works', async () => {
  const dataDir = tempDirectory('qa-oldmain-');
  const secretKey = parseSecretKey(generateSecretKey());

  // What the older build had: migrations 1-8 and its four pool migrations, which are 12-15 in this build.
  const oldSet = [1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15];
  (await Store.open({ dataDir, secretKey, migrations: MIGRATIONS.filter((m) => oldSet.includes(m.version)) })).close();
  const raw = new DatabaseSync(`${dataDir}/portal.db`);
  raw.exec(`UPDATE portal_meta SET value = '[1,2,3,4,5,6,7,8,9,10,11,12]' WHERE key = 'migrations_applied'; PRAGMA user_version = 12;`);
  raw.close();

  const frozen = await Store.open({ dataDir, secretKey });
  try {
    assert.equal(frozen.trust.state, 'frozen');
    const reason = frozen.trust.reasons.find((r) => r.code === 'migration-failed');
    assert.ok(reason, JSON.stringify(frozen.trust.reasons));
    assert.match(reason.message, /already exists/, 'the failure itself is still reported');
    const statement = /run: (UPDATE portal_meta SET value='[^']+' WHERE key='migrations_applied'; PRAGMA user_version=\d+;)/.exec(reason.message)?.[1];
    assert.ok(statement, `the reason names the repair: ${reason.message}`);
    frozen.close();

    // The statement, exactly as printed, on the database; then the next start.
    const fix = new DatabaseSync(`${dataDir}/portal.db`);
    fix.exec(statement);
    fix.close();
    const healed = await Store.open({ dataDir, secretKey });
    try {
      assert.equal(healed.trust.state, 'ok', JSON.stringify(healed.trust.reasons));
      assert.ok(healed.db!.prepare("SELECT 1 FROM sqlite_master WHERE name = 'workspace_claudes'").get(), 'the workspace-claudes tables were created');
    } finally {
      healed.close();
    }
  } finally {
    try {
      frozen.close();
    } catch {
      // closed above
    }
  }
});

test('a failed migration that is not that signature gets no repair sentence', async () => {
  const dataDir = tempDirectory('qa-oldmain-other-');
  const secretKey = parseSecretKey(generateSecretKey());
  const broken = { version: 999, name: 'always fails', up: () => { throw new Error('boom'); } };
  const store = await Store.open({ dataDir, secretKey, migrations: [...MIGRATIONS, broken] });
  try {
    const reason = store.trust.reasons.find((r) => r.code === 'migration-failed');
    assert.ok(reason?.message.includes('boom'));
    assert.ok(!/UPDATE portal_meta/.test(reason!.message));
  } finally {
    store.close();
  }
});
