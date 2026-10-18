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
import { FOUNDING_USER_ID, type SystemStatus } from '@portal/contracts';
import { ManagerTokens } from '../portalmcp/managers.js';
import { MIGRATIONS } from '../store/migrations.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';

const SERVER_DIR = fileURLToPath(new URL('../../', import.meta.url));
const CODE = '24681357';
const KEY = generateSecretKey();
/** How long a portal may take to answer /healthz before the test gives up (and kills it). */
const BOOT_DEADLINE_MS = 60_000;

// Every portal this file starts, killed whatever happens: at the end of its test (`withPortal`'s finally), when the file ends, and when the
// runner process exits (a test runner killed by a timeout never reaches `after`; `exit` is synchronous, so `kill` still runs). Each portal
// is its own process group (`detached`), so what it started dies with it; a portal left behind kept 50-97 % of a CPU for half an hour once.
const children = new Set<ChildProcess>();
function killGroup(c: ChildProcess, signal: NodeJS.Signals): void {
  if (c.exitCode !== null || c.signalCode !== null || !c.pid) return;
  try {
    process.kill(-c.pid, signal);
  } catch {
    try {
      c.kill(signal);
    } catch {
      // gone already
    }
  }
}
const killAll = () => children.forEach((c) => killGroup(c, 'SIGKILL'));
process.on('exit', killAll);
after(() => {
  killAll();
  process.off('exit', killAll);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

interface Portal {
  child: ChildProcess;
  base: string;
  output(): string;
  system(): Promise<SystemStatus>;
}

/** Ends a portal: SIGTERM to its process group, SIGKILL two seconds later if it is still there, and waits until it has gone. */
async function stop(child: ChildProcess): Promise<void> {
  children.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  killGroup(child, 'SIGTERM');
  const hard = setTimeout(() => killGroup(child, 'SIGKILL'), 2000);
  await gone;
  clearTimeout(hard);
}

/** Starts the portal on `dataDir`, runs `fn` once it answers /healthz, and kills it whatever `fn` does (a thrown assertion, a hang up to the deadline). */
async function withPortal(dataDir: string, fn: (portal: Portal) => Promise<void>): Promise<void> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: SERVER_DIR,
    detached: true,
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
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + BOOT_DEADLINE_MS;
    let up = false;
    while (!up && child.exitCode === null && Date.now() < deadline) {
      up = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) }).then(
        (r) => r.ok,
        () => false,
      );
      if (!up) await sleep(250);
    }
    assert.ok(up, `the portal did not come up within ${BOOT_DEADLINE_MS / 1000} s (exit ${child.exitCode}):\n${output.slice(-1500)}`);
    // Give start-up work (module scans, background tasks) the time that a crash would take.
    await sleep(1500);
    assert.equal(child.exitCode, null, `the portal died after starting:\n${output.slice(-1500)}`);
    const system = async (): Promise<SystemStatus> => {
      const login = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ code: CODE }),
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(login.status, 200, 'sign-in works');
      const cookie = /portal_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1];
      const res = await fetch(`${base}/api/admin/system`, {
        headers: { cookie: `portal_session=${cookie}` },
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(res.status, 200);
      return ((await res.json()) as { data: SystemStatus }).data;
    };
    await fn({ child, base, output: () => output, system });
  } finally {
    await stop(child);
  }
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
  await withPortal(await failedMigration(), async (portal) => {
    const s = await portal.system();
    assert.equal(s.trust.state, 'frozen');
    assert.deepEqual(
      s.trust.reasons.map((r) => r.code),
      ['migration-failed'],
    );
    assert.equal(s.secretKey.canUnlock, false);
    assert.ok(s.portalId);
    assert.equal(portal.child.exitCode, null, portal.output().slice(-1500));
  });
});

test('a database from a newer portal: the portal stays up, read-only and frozen', { timeout: 120_000 }, async () => {
  const dir = tempDirectory('cp-qa-boot-');
  (await Store.open({ dataDir: dir, secretKey: parseSecretKey(KEY) })).close();
  const db = new DatabaseSync(join(dir, 'portal.db'));
  db.exec('PRAGMA user_version = 9999');
  db.close();
  await withPortal(dir, async (portal) => {
    const s = await portal.system();
    assert.equal(s.trust.state, 'frozen');
    assert.deepEqual(
      s.trust.reasons.map((r) => r.code),
      ['db-newer'],
    );
    assert.equal(s.schemaVersion, 9999);
    assert.equal(portal.child.exitCode, null, portal.output().slice(-1500));
  });
});

test(
  'a database file that is not a database: the portal stays up and frozen, and does not touch the file',
  { timeout: 120_000 },
  async () => {
    const dir = tempDirectory('cp-qa-boot-');
    const { writeFileSync, readFileSync } = await import('node:fs');
    const junk = Buffer.from('this is not a database '.repeat(300));
    writeFileSync(join(dir, 'portal.db'), junk);
    await withPortal(dir, async (portal) => {
      const s = await portal.system();
      assert.equal(s.trust.state, 'frozen');
      assert.deepEqual(
        s.trust.reasons.map((r) => r.code),
        ['db-unreadable'],
      );
      assert.ok(readFileSync(join(dir, 'portal.db')).equals(junk), 'the file was left as it was (never replaced by an empty database)');
    });
  },
);

test('control: a fresh database comes up healthy, and is gone when its test is over', { timeout: 120_000 }, async () => {
  let child: ChildProcess | undefined;
  await withPortal(tempDirectory('cp-qa-boot-'), async (portal) => {
    child = portal.child;
    const s = await portal.system();
    assert.equal(s.trust.state, 'ok');
    assert.ok(s.schemaVersion && s.schemaVersion >= 15);
  });
  assert.ok(child && (child.exitCode !== null || child.signalCode !== null), 'the portal was stopped when its test ended');
  assert.equal(children.size, 0, 'nothing left to kill');
});

test(
  'T-968 Q3 (#11136), through the wiring in index.ts: a sign-out on the real server revokes the person’s manager token',
  { timeout: 120_000 },
  async () => {
    const dir = tempDirectory('cp-qa-boot-');
    // A manager token of the code's person (the founding user), minted on the same database before the portal starts.
    const store = await Store.open({ dataDir: dir, secretKey: parseSecretKey(KEY) });
    const minted = new ManagerTokens(store).mint({ userId: FOUNDING_USER_ID, sessionId: 'gm-boot' });
    store.close();
    assert.ok(minted, 'a token was minted');
    const tokenId = minted.tokenId;
    const row = () => {
      const db = new DatabaseSync(join(dir, 'portal.db'), { timeout: 5000 });
      try {
        return {
          ...(db.prepare('SELECT revoked_at, revoked_reason FROM pmcp_manager_tokens WHERE id = ?').get(tokenId) as {
            revoked_at: string | null;
            revoked_reason: string | null;
          }),
        };
      } finally {
        db.close();
      }
    };
    await withPortal(dir, async (portal) => {
      const headers = { 'content-type': 'application/json', origin: portal.base };
      const login = await fetch(`${portal.base}/api/login`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: CODE }),
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(login.status, 200);
      const cookie = /portal_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1];
      // The twin: signed in, the token is still good.
      assert.deepEqual(row(), { revoked_at: null, revoked_reason: null });
      const out = await fetch(`${portal.base}/api/logout`, {
        method: 'POST',
        headers: { ...headers, cookie: `portal_session=${cookie}` },
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(out.status, 200);
      const after = row();
      assert.equal(after.revoked_reason, 'signed out', JSON.stringify(after));
      assert.ok(after.revoked_at);
    });
  },
);

test('a test that throws still takes its portal down with it', { timeout: 120_000 }, async () => {
  let child: ChildProcess | undefined;
  await assert.rejects(
    withPortal(tempDirectory('cp-qa-boot-'), async (portal) => {
      child = portal.child;
      throw new Error('an assertion that failed');
    }),
    /an assertion that failed/,
  );
  assert.ok(child && (child.exitCode !== null || child.signalCode !== null), 'killed in finally');
});
