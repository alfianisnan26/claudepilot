// T-AGENT: the CLI's contract with the installers (docs/prd/targets-connect.md §11.3; what install.sh and install.ps1 call): the exit codes of a failed
// enrollment, and `enroll` being a no-op that says so when the machine is already enrolled. The bundle-level behaviour (stdin, symlinks, real portal) is in build.test.ts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { CONNECT_INSTALL_EXIT } from '@portal/contracts';
import { EnrollError } from './enroll.js';
import { FileIdentityStore } from './identity.js';
import { enrollExitCode, main, type MainIo } from './main.js';
import { generateNodeKeyPair } from '../tunnel/auth.js';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const io = (stdin = ''): MainIo & { out: string; err: string } => {
  const o = { out: '', err: '', stdout: (t: string) => void (o.out += t), stderr: (t: string) => void (o.err += t), stdin: async () => stdin };
  return o;
};

describe('the exit codes of enroll, as the installers read them', () => {
  it('11 when the portal can’t be reached, 12 when it said no, 14 for anything else', () => {
    const e = (reason: ConstructorParameters<typeof EnrollError>[0]) => enrollExitCode(new EnrollError(reason, 'x'));
    assert.equal(e('unreachable'), CONNECT_INSTALL_EXIT.unreachable);
    for (const r of ['token_invalid', 'token_expired', 'token_used', 'token_revoked', 'target_enrolled', 'name_taken', 'bad_key', 'insecure_url', 'rate_limited'] as const) assert.equal(e(r), CONNECT_INSTALL_EXIT.tokenRejected, r);
    for (const r of ['store_locked', 'not_found', 'bad_response', 'server_error', 'cannot_save'] as const) assert.equal(e(r), CONNECT_INSTALL_EXIT.install, r);
    assert.deepEqual([CONNECT_INSTALL_EXIT.unreachable, CONNECT_INSTALL_EXIT.tokenRejected, CONNECT_INSTALL_EXIT.install], [11, 12, 14]);
  });
});

describe('main()', () => {
  it('enroll on an enrolled machine says so and exits 0 without touching the portal or the identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cx2-main-'));
    dirs.push(dir);
    const data = join(dir, 'agent');
    mkdirSync(data);
    const keys = generateNodeKeyPair();
    const identity = { node: 'nd_0123456789ab', target: 'lab', portalUrl: 'https://pilot.example.test', portalId: null, privateKey: keys.privateKey, publicKey: keys.publicKey, enrolledAt: new Date().toISOString() };
    await new FileIdentityStore(data).save(identity);
    const out = io(`${['cpen_', 'x'.repeat(43)].join('')}\n`);
    // PILOT_URL points nowhere: a request would be an unreachable (11); the answer must be the no-op.
    const code = await main(['enroll', '--token-stdin'], { PILOT_MODE: 'host', PILOT_DATA_DIR: data, PILOT_URL: 'http://127.0.0.1:1', PILOT_ALLOW_HTTP: '1' }, 'bbbbbbbbbbbb', out);
    assert.equal(code, 0);
    assert.match(out.err, /already enrolled/);
    assert.deepEqual(await new FileIdentityStore(data).load(), identity);
  });

  it('identity prints the node, the target and the fingerprint, never a key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cx2-main-'));
    dirs.push(dir);
    const keys = generateNodeKeyPair();
    await new FileIdentityStore(dir).save({ node: 'nd_0123456789ab', target: 'lab', portalUrl: 'https://pilot.example.test', portalId: null, privateKey: keys.privateKey, publicKey: keys.publicKey, enrolledAt: new Date().toISOString() });
    const out = io();
    assert.equal(await main(['identity'], { PILOT_MODE: 'host', PILOT_DATA_DIR: dir }, 'bbbbbbbbbbbb', out), 0);
    assert.match(out.out, /^node nd_0123456789ab\ntarget lab\nportal https:\/\/pilot\.example\.test\nfingerprint [0-9a-f]{32}\n$/);
    assert.equal(out.out.includes(keys.privateKey), false);
  });

  it('an unknown command is a usage error before any configuration is read', async () => {
    const out = io();
    assert.equal(await main(['frobnicate'], {}, 'bbbbbbbbbbbb', out), 2);
    assert.match(out.err, /Unknown command/);
  });
});
