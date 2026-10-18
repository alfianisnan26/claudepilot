import { resolve } from 'node:path';
import { config } from './config.js';
import { isPortalRunning } from './store/lock.js';
import { generateSecretKey, loadSecretKey, parseSecretKey } from './store/secretBox.js';
import { nightlyBackup, nightlyStatus, restoreAny, restoreDrill } from './store/nightly.js';
import { backupDatabase, forgetSecrets, inspectStore, rotateKey } from './store/store.js';

const USAGE = `Usage: portal <command>

  status            Database, key and backup state (read-only; safe while the portal runs)
  backup            Take a backup now (safe while the portal runs)
  backup --nightly [--dir <dir>]
                    The nightly backup: checked, gzipped, kept 7 daily plus 4 weekly in
                    <data dir>/backups/nightly (or <dir>). Safe while the portal runs.
  restore <file>    Replace the database with a backup (.db or .db.gz). The portal must be
                    stopped; it then starts Frozen until an admin resumes delivery.
  drill <file>      Restore a backup (.db or .db.gz) into a scratch folder, time it and compare
                    every table's row count. Never touches the live database.
  rotate-key        Re-encrypt every secret. PORTAL_SECRET_KEY(_FILE) is the current key,
                    PORTAL_NEW_SECRET_KEY(_FILE) the new one. The portal must be stopped.
  forget-secrets    The key is lost: delete every secret and make PORTAL_SECRET_KEY(_FILE) the
                    new key. Pools and assignments stay. Needs --yes. The portal must be stopped.
  generate-key      Print a new random secret key

Data dir: ${config.paths.data} (PORTAL_DATA_DIR)`;

const dataDir = config.paths.data;
const currentKey = () => loadSecretKey({ value: config.secretKey.value, file: config.secretKey.file });
const fmtBytes = (n: number) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

async function main(argv: string[]) {
  const [command, ...args] = argv;
  switch (command) {
    case 'status': {
      const s = inspectStore({ dataDir, secretKey: currentKey() });
      const pid = isPortalRunning(dataDir);
      console.log(`Data dir     ${dataDir}`);
      console.log(`Portal       ${pid ? `running (pid ${pid})` : 'not running'}`);
      if (!s.exists) return console.log('Database     none yet (created when the portal starts)');
      if (s.error) return console.log(`Database     unreadable: ${s.error}`);
      console.log(`Database     schema ${s.schemaVersion} (this portal knows ${s.latestSchemaVersion})`);
      console.log(`Portal ID    ${s.portalId ?? '-'}${s.createdAt ? `, created ${s.createdAt}` : ''}`);
      const key = {
        opens: 'opens the database',
        wrong: "doesn't match the database",
        'no-key': 'not set',
        none: 'set; the database has no key check yet',
      }[s.key];
      console.log(`Secret key   ${key}${s.keyId ? ` (key ${s.keyId})` : ''}`);
      if (s.frozen) console.log(`Frozen       ${(JSON.parse(s.frozen) as { message: string }).message}`);
      console.log(
        `Backups      ${s.backups.length}${s.backups[0] ? `, latest ${s.backups[0].at.toISOString()} (${s.backups[0].kind})` : ''}`,
      );
      for (const b of s.backups.slice(0, 5)) console.log(`  ${b.file}  ${fmtBytes(b.bytes)}`);
      const n = nightlyStatus({ dataDir });
      console.log(`Nightly      ${n.count}${n.lastAt ? `, latest ${n.lastAt}` : ''}${n.stale ? ' (STALE: none in the last 26 h)' : ''}`);
      return;
    }
    case 'backup': {
      if (!args.includes('--nightly')) return console.log(`Backed up to ${await backupDatabase({ dataDir })}`);
      const at = args.indexOf('--dir');
      if (at >= 0 && !args[at + 1]) throw new Error('Usage: portal backup --nightly [--dir <dir>]');
      const { file, bytes, removed } = await nightlyBackup({ dataDir, dir: at >= 0 ? resolve(args[at + 1]!) : undefined });
      console.log(`Nightly backup ${file} (${fmtBytes(bytes)}); pruned ${removed.length}.`);
      return;
    }
    case 'drill': {
      if (!args[0]) throw new Error('Usage: portal drill <file>');
      const r = await restoreDrill({ file: resolve(args[0]), secretKey: currentKey() });
      console.log(`Restored ${r.tables} tables, ${r.rows} rows in ${Math.round(r.ms)} ms.`);
      for (const m of r.mismatches) console.log(`  MISMATCH ${m.table}: backup ${m.backup ?? '-'}, restored ${m.restored ?? '-'}`);
      if (r.mismatches.length) throw new Error(`The drill failed: ${r.mismatches.length} table(s) differ.`);
      return console.log('Drill passed: every table has the same row count.');
    }
    case 'restore': {
      if (!args[0]) throw new Error('Usage: portal restore <file>');
      const { replaced } = await restoreAny({ dataDir, file: resolve(args[0]), secretKey: currentKey() });
      if (replaced) console.log(`The current database was saved as ${replaced}.`);
      console.log('Restored. The portal starts Frozen: check the workspaces, then choose "Resume delivery".');
      return;
    }
    case 'rotate-key': {
      const oldKey = currentKey();
      if (!oldKey) throw new Error('Set PORTAL_SECRET_KEY (or PORTAL_SECRET_KEY_FILE) to the current key.');
      const raw = process.env.PORTAL_NEW_SECRET_KEY?.trim();
      const file = process.env.PORTAL_NEW_SECRET_KEY_FILE?.trim();
      const newKey = raw ? parseSecretKey(raw, 'PORTAL_NEW_SECRET_KEY') : loadSecretKey({ file });
      if (!newKey) throw new Error('Set PORTAL_NEW_SECRET_KEY (or PORTAL_NEW_SECRET_KEY_FILE) to the new key.');
      const { resealed, backup } = await rotateKey({ dataDir, oldKey, newKey });
      console.log(`Re-encrypted ${resealed} secret(s). Backup taken first: ${backup}`);
      console.log('Now start the portal with the new key, and keep an offline copy of it.');
      return;
    }
    case 'forget-secrets': {
      if (!args.includes('--yes')) throw new Error('This deletes every stored secret. Run `portal forget-secrets --yes` to confirm.');
      const newKey = currentKey();
      if (!newKey) throw new Error('Set PORTAL_SECRET_KEY (or PORTAL_SECRET_KEY_FILE) to the new key first.');
      const { cleared, backup } = await forgetSecrets({ dataDir, newKey });
      console.log(`Deleted ${cleared} secret(s); the database now uses the new key. Backup taken first: ${backup}`);
      console.log('Every secret shows "Re-enter" until it is entered again.');
      return;
    }
    case 'generate-key':
      return console.log(generateSecretKey());
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return console.log(USAGE);
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`portal: ${(e as Error).message}`);
  process.exit(1);
});
