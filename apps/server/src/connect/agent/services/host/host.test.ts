// T-HOST: the `host` service against the real executor, no tunnel (a duplex pair per stream). The portal's side is `HostOp`
// (testkit/hostOp.ts). Covers pipes and the pty, resize, exit codes and signals, process-group kill on a reset stream, the
// environment, path mapping, put (owner, mode, traversal, links, 100 MB streamed), read, usage and backpressure.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pack } from 'tar-stream';
import type { ConnectHostOpen } from '@portal/contracts';
import { collectingLogger } from '../../log.js';
import { HostOp, openHost } from '../../testkit/hostOp.js';
import { REC } from './channel.js';
import { createService, passwdUser, type HostService } from './index.js';

let dir: string;
let home: string;
let svc: HostService;
let lines: ReturnType<typeof collectingLogger>;

/** Whether the process still runs: a zombie nobody has reaped (the container's init may not) is dead. */
const alive = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    try {
      process.kill(pid, 0);
      return !existsSync('/proc/self');
    } catch {
      return false;
    }
  }
};
const until = async (fn: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const run = async (argv: string[], extra: Partial<Extract<ConnectHostOpen, { op: 'exec' }>> = {}) => {
  const op = await openHost(svc, { op: 'exec', argv, ...extra });
  op.eof();
  return { op, result: await op.result() };
};

describe('host service (Host mode)', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cx2-host-'));
    home = join(dir, 'home');
    mkdirSync(home);
    lines = collectingLogger();
    svc = createService({ mode: 'host', home, log: lines.logger, killGraceMs: 300 });
  });
  after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('exec with pipes', () => {
    it('runs a command and ends with exactly one RESULT', async () => {
      const { op, result } = await run(['sh', '-c', 'echo hello; echo oops >&2']);
      assert.deepEqual(result, { code: 0 });
      assert.equal(op.text(), 'hello\n');
      assert.equal(op.stderr().toString(), 'oops\n');
      assert.equal(op.records.filter((r) => r.kind === REC.result).length, 1);
      assert.equal(op.records.at(-1)!.kind, REC.result, 'RESULT is always the last record');
      await op.closed;
    });

    it('merges stderr into DATA when asked', async () => {
      const { op } = await run(['sh', '-c', 'echo out; echo err >&2'], { merge: true });
      assert.equal(op.stderr().length, 0);
      assert.deepEqual(op.text().split('\n').sort(), ['', 'err', 'out']);
    });

    it('feeds stdin from DATA records and ends it with EOF', async () => {
      const op = await openHost(svc, { op: 'exec', argv: ['cat'] });
      op.write('typed ');
      op.write('words\n');
      op.eof();
      assert.deepEqual(await op.result(), { code: 0 });
      assert.equal(op.text(), 'typed words\n');
    });

    it('reports exit codes and signals', async () => {
      assert.deepEqual((await run(['sh', '-c', 'exit 7'])).result, { code: 7 });
      assert.deepEqual((await run(['sh', '-c', 'kill -9 $$'])).result, { code: null, signal: 'SIGKILL' });
    });

    it('answers a command that can’t start with a typed error, not an exception', async () => {
      assert.equal((await run(['/nonexistent/prog'])).result.error?.code, 'ENOENT');
      const noDir = await run(['sh', '-c', 'true'], { cwd: '/nonexistent-dir' });
      assert.equal(noDir.result.error?.code, 'ENOENT');
      assert.match(noDir.result.error?.message ?? '', /working directory/, 'it says the folder is missing, not the program');
    });

    it('starts commands in the home folder with HOME, ~/.local/bin on PATH, and the agent’s own settings left behind', async () => {
      process.env.PILOT_ENROLL_TOKEN = ['cpen_', 'canary-token-canary-token-canary-token-0'].join('');
      process.env.PILOT_HEADERS = 'CF-Access-Client-Secret: canary-header';
      const probe = createService({ mode: 'host', home, log: lines.logger });
      const op = await openHost(probe, { op: 'exec', argv: ['sh', '-c', 'pwd; echo "$HOME"; echo "$PATH"; echo "$CLAUDEPILOT_FILES_ROOT"; env'], env: { EXTRA: 'one' } });
      op.eof();
      await op.result();
      delete process.env.PILOT_ENROLL_TOKEN;
      delete process.env.PILOT_HEADERS;
      const text = op.text();
      const [pwd, h, path, root] = text.split('\n');
      assert.equal(pwd, home);
      assert.equal(h, home);
      assert.equal(path!.split(':')[0], join(home, '.local', 'bin'));
      assert.equal(root, home);
      assert.match(text, /^EXTRA=one$/m);
      assert.equal(text.split('\n').some((l) => l.startsWith('PILOT_')), false, 'the agent’s settings are not the workspace’s environment');
      assert.equal(text.includes('canary'), false);
    });

    it('maps workspace paths: /home/node is the home, /etc/claudepilot is ~/.claudepilot/host, a script’s /etc/claudepilot/ too', async () => {
      const { op } = await run(['sh', '-c', 'printf "%s|%s|%s" "$1" "$2" "$3"', 'sh', '/home/node/project', '/etc/claudepilot/bin/cp-session', '/home/nodes']);
      assert.equal(op.text(), `${home}/project|${home}/.claudepilot/host/bin/cp-session|/home/nodes`);
      mkdirSync(join(home, '.claudepilot/host/bin'), { recursive: true });
      writeFileSync(join(home, '.claudepilot/host/bin/tool'), 'x');
      const script = await run(['sh', '-c', "cat '/etc/claudepilot/bin/tool'"]);
      assert.equal(script.op.text(), 'x');
      mkdirSync(join(home, 'work'));
      const cwd = await run(['pwd'], { cwd: '/home/node/work' });
      assert.equal(cwd.op.text().trim(), join(home, 'work'));
    });

    it('kills the process group when the stream is reset, and does not when it just ends', async () => {
      const pidFile = join(dir, 'pids');
      const op = await openHost(svc, { op: 'exec', argv: ['sh', '-c', `sleep 60 & echo $! > ${pidFile}; echo $$ >> ${pidFile}; wait`] });
      await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().split('\n').length === 2);
      const [child, shell] = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number) as [number, number];
      assert.ok(alive(child) && alive(shell));
      op.reset();
      await until(() => !alive(child) && !alive(shell));
    });

    it('a half-close ends stdin and the command finishes by itself', async () => {
      const op = await openHost(svc, { op: 'exec', argv: ['cat'] });
      op.write('one\n');
      op.stream.end(); // FIN, no EOF record
      assert.deepEqual(await op.result(), { code: 0 });
      assert.equal(op.text(), 'one\n');
    });

    it('SIGNAL records stop a command', async () => {
      const op = await openHost(svc, { op: 'exec', argv: ['sleep', '60'] });
      await new Promise((r) => setTimeout(r, 100));
      op.signal('SIGTERM');
      assert.deepEqual(await op.result(), { code: null, signal: 'SIGTERM' });
    });

    it('refuses what it can’t run before the stream is accepted', async () => {
      for (const bad of [
        { op: 'exec', argv: [] },
        { op: 'exec', argv: ['x', 1] },
        { op: 'exec', argv: ['x'], cwd: 'relative' },
        { op: 'exec', argv: ['x'], env: { 'BAD NAME': 'v' } },
        { op: 'exec', argv: ['x'], tty: { cols: 0, rows: 5 } },
        { op: 'bogus' },
      ] as unknown as ConnectHostOpen[]) {
        assert.equal((await svc.accept(bad))?.code, 'bad_open', JSON.stringify(bad));
      }
      assert.equal(await svc.accept({ op: 'exec', argv: ['true'] }), null);
    });
  });

  describe('exec with a terminal', () => {
    it('runs a shell on a pty, resizes it, and reports the exit', async () => {
      const op = await openHost(svc, { op: 'exec', argv: ['sh'], tty: { cols: 80, rows: 24 } });
      op.write('echo $((6*7))\n');
      await op.waitFor('42');
      op.write('stty size\n');
      await op.waitFor('24 80');
      op.resize(100, 30);
      op.write('stty size\n');
      await op.waitFor('30 100');
      op.write('exit 3\n');
      assert.deepEqual(await op.result(), { code: 3 });
      assert.equal(op.stderr().length, 0, 'a terminal has one output');
    });

    it('hangs up the terminal’s process group when the stream is reset', async () => {
      const pidFile = join(dir, 'tty-pid');
      const op = await openHost(svc, { op: 'exec', argv: ['sh', '-c', `echo $$ > ${pidFile}; exec sleep 60`], tty: { cols: 80, rows: 24 } });
      await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.ok(alive(pid));
      op.reset();
      await until(() => !alive(pid));
    });
  });

  describe('put', () => {
    const tarOf = (build: (p: ReturnType<typeof pack>) => void) => {
      const p = pack();
      build(p);
      p.finalize();
      return p;
    };
    const send = async (op: HostOp, archive: AsyncIterable<unknown>) => {
      for await (const chunk of archive) {
        op.write(chunk as Buffer);
        if (op.stream.writableNeedDrain) await new Promise((r) => op.stream.once('drain', r));
      }
      op.eof();
    };

    it('extracts files and folders with their modes under the path mapping and skips what must not be written', async () => {
      mkdirSync(join(dir, 'outside'));
      symlinkSync(join(dir, 'outside'), join(home, 'escape'));
      const archive = tarOf((p) => {
        p.entry({ name: 'home/node/', type: 'directory', mode: 0o755 });
        p.entry({ name: 'home/node/.claude/', type: 'directory', mode: 0o700 });
        p.entry({ name: 'home/node/.claude/settings.json', type: 'file', mode: 0o600 }, '{"a":1}');
        p.entry({ name: 'etc/claudepilot/bin/', type: 'directory', mode: 0o755 });
        p.entry({ name: 'etc/claudepilot/bin/cp-session', type: 'file', mode: 0o755 }, '#!/bin/sh\n');
        p.entry({ name: 'home/node/empty.txt', type: 'file', mode: 0o644 }, '');
        p.entry({ name: 'home/node/../../etc/evil', type: 'file', mode: 0o644 }, 'no');
        p.entry({ name: 'home/node/link', type: 'symlink', linkname: '/etc/passwd' });
        p.entry({ name: 'home/node/hard', type: 'link', linkname: 'home/node/empty.txt' });
        p.entry({ name: 'home/node/escape/stolen', type: 'file', mode: 0o644 }, 'no');
        p.entry({ name: 'home/node/fifo', type: 'fifo' });
        p.entry({ name: 'home/node/after.txt', type: 'file', mode: 0o640 }, 'after the skipped ones');
      });
      const op = await openHost(svc, { op: 'put' });
      await send(op, archive);
      const result = await op.result();
      assert.equal(result.code, 0);
      const mode = (p: string) => statSync(join(home, p)).mode & 0o7777;
      assert.equal(readFileSync(join(home, '.claude/settings.json'), 'utf8'), '{"a":1}');
      assert.equal(mode('.claude'), 0o700);
      assert.equal(mode('.claude/settings.json'), 0o600);
      assert.equal(mode('.claudepilot/host/bin/cp-session'), 0o755);
      assert.equal(readFileSync(join(home, 'empty.txt'), 'utf8'), '');
      assert.equal(readFileSync(join(home, 'after.txt'), 'utf8'), 'after the skipped ones');
      assert.equal(existsSync(join(dir, 'etc')), false);
      assert.equal(existsSync(join(home, 'link')), false);
      assert.equal(existsSync(join(home, 'hard')), false);
      assert.equal(existsSync(join(dir, 'outside', 'stolen')), false, 'a symlinked folder does not lead out of the home');
      const reasons = Object.fromEntries((result.skipped ?? []).map((s) => [s.path.replace(/^.*\//, ''), s.reason]));
      assert.deepEqual(reasons, { evil: 'path', link: 'link', hard: 'link', stolen: 'escape', fifo: 'type' });
    });

    it('reports a write it could not do and still writes the rest', { skip: process.getuid?.() === 0 ? 'root can write into a read-only folder' : false }, async () => {
      mkdirSync(join(home, 'ro'), { mode: 0o500 });
      const op = await openHost(svc, { op: 'put' });
      await send(
        op,
        tarOf((p) => {
          p.entry({ name: 'home/node/ro/nope.txt', type: 'file', mode: 0o644 }, 'x');
          p.entry({ name: 'home/node/fine.txt', type: 'file', mode: 0o644 }, 'y');
        }),
      );
      const result = await op.result();
      assert.equal(result.code, 1);
      assert.equal(result.error?.code, process.getuid?.() === 0 ? 'FAILED' : 'EACCES');
      assert.equal(readFileSync(join(home, 'fine.txt'), 'utf8'), 'y');
    });

    it('answers a damaged archive with EINVAL', async () => {
      const op = await openHost(svc, { op: 'put' });
      op.write(Buffer.alloc(512, 7));
      op.eof();
      const result = await op.result();
      assert.equal(result.code, 1);
      assert.equal(result.error?.code, 'EINVAL');
    });

    it('leaves nothing half-written when the stream is reset mid-file', async () => {
      const op = await openHost(svc, { op: 'put' });
      const p = pack();
      const entry = p.entry({ name: 'home/node/partial.bin', type: 'file', mode: 0o644, size: 4_000_000 });
      p.on('data', (chunk) => op.write(chunk as Buffer));
      entry.write(Buffer.alloc(1_000_000, 1)); // 1 MB of the 4 MB the header promised
      await until(() => existsSync(join(home, 'partial.bin')));
      op.reset();
      p.destroy();
      await until(() => !existsSync(join(home, 'partial.bin')));
    });

    it('streams 100 MB without holding it: a few MB of growth, not 100', async (t) => {
      const total = 100 * 1024 * 1024;
      const op = await openHost(svc, { op: 'put' });
      const p = pack();
      const entry = p.entry({ name: 'home/node/big.bin', type: 'file', mode: 0o644, size: total });
      const hash = createHash('sha256');
      const baseline = process.memoryUsage().rss;
      let peak = 0;
      const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss - baseline)), 25);
      const feeder = (async () => {
        const chunk = Buffer.alloc(256 * 1024, 9);
        for (let sent = 0; sent < total; sent += chunk.length) {
          hash.update(chunk);
          if (!entry.write(chunk)) await new Promise<void>((r) => entry.once('drain', () => r()));
        }
        entry.end(undefined);
        p.finalize();
      })();
      for await (const chunk of p) {
        op.write(chunk as Buffer);
        if (op.stream.writableNeedDrain) await new Promise((r) => op.stream.once('drain', r));
      }
      op.eof();
      await feeder;
      assert.equal((await op.result(60_000)).code, 0);
      clearInterval(sampler);
      assert.equal(statSync(join(home, 'big.bin')).size, total);
      assert.equal(createHash('sha256').update(readFileSync(join(home, 'big.bin'))).digest('hex'), hash.digest('hex'));
      t.diagnostic(`peak rss growth ${(peak / 1048576).toFixed(1)} MB for a 100 MB put (portal side and agent side in one process)`);
      assert.ok(peak < 50 * 1024 * 1024, `rss grew by ${(peak / 1048576).toFixed(1)} MB while 100 MB went through (both sides, one process)`);
      rmSync(join(home, 'big.bin'));
    });
  });

  describe('read', () => {
    it('reads a file as DATA, EOF and RESULT, under the path mapping', async () => {
      writeFileSync(join(home, 'note.txt'), 'hello\n'.repeat(30_000)); // 180 kB: several records
      const op = await openHost(svc, { op: 'read', path: '/home/node/note.txt' });
      assert.deepEqual(await op.result(), { code: 0 });
      assert.equal(op.text(), 'hello\n'.repeat(30_000));
      const kinds = op.records.map((r) => r.kind);
      assert.equal(kinds.at(-1), REC.result);
      assert.equal(kinds.at(-2), REC.eof);
      assert.ok(op.records.filter((r) => r.kind === REC.data).every((r) => r.payload.length <= 65_536));
    });

    it('says ENOENT, EINVAL and TOO_LARGE in RESULT, and sends no data for the last', async () => {
      assert.equal((await (await openHost(svc, { op: 'read', path: '/home/node/missing' })).result()).error?.code, 'ENOENT');
      assert.equal((await (await openHost(svc, { op: 'read', path: '/home/node' })).result()).error?.code, 'EINVAL');
      const big = await openHost(svc, { op: 'read', path: '/home/node/note.txt', maxBytes: 1000 });
      assert.equal((await big.result()).error?.code, 'TOO_LARGE');
      assert.equal(big.stdout().length, 0);
      assert.equal((await (await openHost(svc, { op: 'read', path: 'relative' })).result()).error?.code, 'EINVAL');
    });
  });

  describe('backpressure and usage', () => {
    it('stops the command when the portal isn’t reading, and delivers everything once it does', async () => {
      const bytes = 24 * 1024 * 1024;
      const op = await openHost(svc, { op: 'exec', argv: ['sh', '-c', `head -c ${bytes} /dev/zero`] });
      op.eof();
      op.stream.pause();
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(op.stream.readableLength < 2 * 1024 * 1024, `the agent buffered ${op.stream.readableLength} bytes for a reader that wasn't reading`);
      op.stream.resume();
      assert.deepEqual(await op.result(30_000), { code: 0 });
      assert.equal(op.stdout().length, bytes);
    });

    it('reports host usage in the status report, and its own status', () => {
      const { usage } = svc.report!();
      assert.ok(usage!.memoryBytes! > 0 && usage!.cores! >= 1 && usage!.memoryTotalBytes! >= usage!.memoryBytes!);
      assert.equal(svc.status().name, 'host');
      assert.equal(svc.status().ok, true);
      assert.ok(svc.status().version);
    });
  });

  it('never logs a command, an environment, a file name or any content (the canary run)', async () => {
    const canary = 'CANARY-7f3a91';
    const op = await openHost(svc, { op: 'exec', argv: ['sh', '-c', `echo ${canary}`, canary], env: { SECRET_VALUE: canary }, cwd: `/home/node/${canary}-dir` });
    op.eof();
    await op.result();
    const put = await openHost(svc, { op: 'put' });
    const archive = pack();
    archive.entry({ name: `home/node/${canary}.txt`, type: 'file', mode: 0o644 }, `content ${canary}`);
    archive.finalize();
    for await (const chunk of archive) put.write(chunk as Buffer);
    put.eof();
    await put.result();
    const read = await openHost(svc, { op: 'read', path: `/home/node/${canary}.txt` });
    await read.result();
    await (await openHost(svc, { op: 'read', path: `/home/node/${canary}-missing` })).result();
    assert.ok(lines.lines.length > 0, 'it did log (at debug level)');
    assert.equal(lines.text().includes(canary), false, lines.text());
  });
});

describe('host service (Container mode)', () => {
  it('maps nothing, finds the node user in passwd, and runs as the agent’s user when it isn’t root', async () => {
    const passwd = join(tmpdir(), `cx2-passwd-${process.pid}`);
    writeFileSync(passwd, 'root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash\n');
    assert.deepEqual(passwdUser(passwd, 'node'), { uid: 1000, gid: 1000, home: '/home/node' });
    assert.equal(passwdUser(passwd, 'nobody-here'), null);
    const work = mkdtempSync(join(tmpdir(), 'cx2-container-'));
    const svc2 = createService({ mode: 'container', home: work, passwdFile: passwd, log: collectingLogger().logger });
    const op = await openHost(svc2, { op: 'exec', argv: ['sh', '-c', 'printf "%s|%s|%s" "$1" "$HOME" "$(pwd)"', 'sh', '/home/node/x'] });
    op.eof();
    assert.deepEqual(await op.result(), { code: 0 });
    assert.equal(op.text(), `/home/node/x|${work}|${work}`, 'the path is passed through unmapped');
    rmSync(passwd);
    rmSync(work, { recursive: true, force: true });
    svc2.close();
  });

  it('refuses a terminal when there is no pty library, and says why', async () => {
    const svc3 = createService({
      mode: 'container',
      home: homedir(),
      loadPty: async () => {
        throw new Error('Terminal support (@lydell/node-pty) isn’t installed');
      },
      log: collectingLogger().logger,
    });
    const refusal = await svc3.accept({ op: 'exec', argv: ['sh'], tty: { cols: 80, rows: 24 } });
    assert.equal(refusal?.code, 'service_unavailable');
    assert.match(refusal?.message ?? '', /node-pty/);
    assert.equal(svc3.status().ok, true);
    assert.match(svc3.status().error ?? '', /node-pty/);
    assert.equal(await svc3.accept({ op: 'exec', argv: ['true'] }), null, 'commands without a terminal still work');
  });
});
