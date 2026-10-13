// A large stdin through the Connect host transport (an attachment staged by cp-session `put` is several MB of base64 written in 256 KiB
// pieces, fire-and-forget): every byte arrives, in order, at the command in the workspace. The memory mux exercises the same framing,
// windows and scheduler as the real tunnel.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createService } from '../../connect/agent/services/host/index.js';
import { silentLogger } from '../../connect/agent/log.js';
import type { ExecSession } from '../runtime.js';
import { HostRuntime } from './host.js';
import { FakeLink, memoryDeps, targetRecord } from './testkit.js';

let home: string;
let link: FakeLink;
let rt: HostRuntime;
let hold: NodeJS.Timeout;
const ID = 'cx3-big';

const run = (s: ExecSession) =>
  new Promise<{ out: string; code: number | null }>((resolve) => {
    let out = '';
    s.onData((d) => (out += d.toString()));
    s.onExit((code) => resolve({ out, code }));
  });

before(async () => {
  hold = setInterval(() => undefined, 1000);
  home = mkdtempSync(join(tmpdir(), 'cx3-big-'));
  const host = createService({ mode: 'host', home, log: silentLogger, baseEnv: { PATH: process.env.PATH, HOME: home } });
  link = new FakeLink('n1', ID, { host }, {}).connect();
  rt = new HostRuntime(targetRecord({ id: ID, kind: 'host', label: 'Big' }), { record: { id: 'n1', targetId: ID, name: 'big', drained: false, keyFingerprint: 'x' }, link }, memoryDeps());
  await rt.start(ID);
});
after(() => {
  clearInterval(hold);
  rt.dispose();
  link.drop();
  rmSync(home, { recursive: true, force: true });
});

test('6 MB of base64 written in 256 KiB pieces arrives whole and in order', async () => {
  const bytes = Buffer.alloc(6_000_001);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) & 0xff;
  const b64 = bytes.toString('base64');
  const s = await rt.exec(ID, ['sh', '-c', `head -c ${b64.length} | base64 -d | sha256sum`]);
  const done = run(s);
  for (let at = 0; at < b64.length; at += 262144) {
    s.write(b64.slice(at, at + 262144));
    await new Promise<void>((r) => setImmediate(r));
  }
  const { out, code } = await done;
  assert.equal(code, 0, out);
  assert.equal(out.trim().split(/\s+/)[0], createHash('sha256').update(bytes).digest('hex'));
});
