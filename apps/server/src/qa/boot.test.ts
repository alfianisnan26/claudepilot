// QA regression: the real server starts, stays up and explains itself on a database it cannot use (foundation PRD §6.5:
// "the portal can still start and explain itself"). Every module added to index.ts runs its start-up against such a
// database; one that reads a table a failed migration never made used to take the whole process down (QA-011).
//
// Black box on purpose: it boots src/index.ts as the portal does, so a module added later is covered without a change here.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { SystemStatus } from '@portal/contracts';
import { MIGRATIONS } from '../store/migrations.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
const CODE = '24681357';
const KEY = generateSecretKey();
const children = new Set<ChildProcess>();
after(() => children.forEach((c) => c.kill('SIGKILL')));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Starts the portal on `dataDir`; resolves once it answers /healthz, with the way to ask it things and to see its output. */
async function boot(dataDir: string) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
      PORTAL_HOST: '127.0.0.1',
      PORTAL_PORT: String(port),
      PORTAL_DATA_DIR: dataDir,
      PORTAL_SERVER_CODE: CODE,
      PORTAL_SECRET_KEY: KEY,
      // Nothing outside this test: no Docker, no cluster, no machine workspace.
      PORTAL_DOCKER_SOCKET: '/nonexistent/docker.sock',
      PORTAL_DOCKER_HOST_SOCKET: '/nonexistent/docker-host.sock',
      PORTAL_K8S_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 160 && child.exitCode === null; i++) {
    up = await fetch(`${base}/healthz`).then((r) => r.ok, () => false);
    if (up) break;
    await sleep(250);
  }
  assert.ok(up, `the portal did not come up (exit ${child.exitCode}):\n${output.slice(-1500)}`);
  // Give start-up work (module scans, background tasks) the time that a crash would take.
  await sleep(1500);
  assert.equal(child.exitCode, null, `the portal died after starting:\n${output.slice(-1500)}`);
  const system = async (): Promise<SystemStatus> => {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ code: CODE }) });
    assert.equal(login.status, 200, 'sign-in works');
    const cookie = /portal_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1];
    const res = await fetch(`${base}/api/admin/system`, { headers: { cookie: `portal_session=${cookie}` } });
    assert.equal(res.status, 200);
    return ((await res.json()) as { data: SystemStatus }).data;
  };
  return { child, output: () => output, system };
}

/** A complete database whose last two migrations are marked as not run, so the next start applies them on top of themselves and fails. */
async function failedMigration(): Promise<string> {
  const dir = tempDirectory('cp-qa-boot-');
  (await Store.open({ dataDir: dir, secretKey: parseSecretKey(KEY) })).close();
  const db = new DatabaseSync(join(dir, 'portal.db'));
  const versions = MIGRATIONS.map((m) => m.version).sort((a, b) => a - b);
  const kept = versions.slice(0, -2);
  db.prepare("UPDATE portal_meta SET value = ? WHERE key = 'migrations_applied'").run(JSON.stringify(kept));
  db.exec(`PRAGMA user_version = ${kept.at(-1)}`);
  db.close();
  return dir;
}

test('a database whose migration failed: the portal stays up, signs you in and says why it is frozen', { timeout: 120_000 }, async () => {
  const portal = await boot(await failedMigration());
  const s = await portal.system();
  assert.equal(s.trust.state, 'frozen');
  assert.deepEqual(s.trust.reasons.map((r) => r.code), ['migration-failed']);
  assert.equal(s.secretKey.canUnlock, false);
  assert.ok(s.portalId);
  assert.equal(portal.child.exitCode, null, portal.output().slice(-1500));
});

test('a database from a newer portal: the portal stays up, read-only and frozen', { timeout: 120_000 }, async () => {
  const dir = tempDirectory('cp-qa-boot-');
  (await Store.open({ dataDir: dir, secretKey: parseSecretKey(KEY) })).close();
  const db = new DatabaseSync(join(dir, 'portal.db'));
  db.exec('PRAGMA user_version = 9999');
  db.close();
  const portal = await boot(dir);
  const s = await portal.system();
  assert.equal(s.trust.state, 'frozen');
  assert.deepEqual(s.trust.reasons.map((r) => r.code), ['db-newer']);
  assert.equal(s.schemaVersion, 9999);
  assert.equal(portal.child.exitCode, null, portal.output().slice(-1500));
});

test('a database file that is not a database: the portal stays up and frozen, and does not touch the file', { timeout: 120_000 }, async () => {
  const dir = tempDirectory('cp-qa-boot-');
  const { writeFileSync, readFileSync } = await import('node:fs');
  const junk = Buffer.from('this is not a database '.repeat(300));
  writeFileSync(join(dir, 'portal.db'), junk);
  const portal = await boot(dir);
  const s = await portal.system();
  assert.equal(s.trust.state, 'frozen');
  assert.deepEqual(s.trust.reasons.map((r) => r.code), ['db-unreadable']);
  assert.ok(readFileSync(join(dir, 'portal.db')).equals(junk), 'the file was left as it was (never replaced by an empty database)');
});

test('control: a fresh database comes up healthy', { timeout: 120_000 }, async () => {
  const portal = await boot(tempDirectory('cp-qa-boot-'));
  const s = await portal.system();
  assert.equal(s.trust.state, 'ok');
  assert.ok(s.schemaVersion && s.schemaVersion >= 15);
});
