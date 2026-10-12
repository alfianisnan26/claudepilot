// Run INSIDE a container (by host.container.test.ts, opt-in): the host service in Container mode as root, with the `node` user of the image. Prints one
// JSON line: who commands run as, what they inherit, what `put` does with owners and modes, and what the cgroup says about usage.
import { silentLogger } from '../log.js';
import { createService } from '../services/host/index.js';
import { openHost } from './hostOp.js';

const svc = createService({ mode: 'container', log: silentLogger, killGraceMs: 300 });

async function run(argv: string[], extra: { user?: 'node' | 'root'; tty?: { cols: number; rows: number } } = {}) {
  const op = await openHost(svc, { op: 'exec', argv, ...extra });
  op.eof();
  const result = await op.result();
  return { text: op.text(), result };
}

const out: Record<string, unknown> = {
  uid: process.getuid?.(),
  asNode: await run(['sh', '-c', 'id -u; id -g; id -un; echo $HOME; pwd; env | grep -c "^PILOT_" || true; env | grep -c "^CLAUDEPILOT_FILES_ROOT=/home/node$"']),
  asRoot: await run(['sh', '-c', 'id -u; echo $HOME; pwd'], { user: 'root' }),
  tty: await run(['sh', '-c', 'id -un; stty size'], { tty: { cols: 100, rows: 30 } }).catch((e: Error) => ({ error: e.message })),
};

// put: a file owned by node with a private mode, a root-owned one, and a directory
const { pack } = await import('tar-stream');
const archive = pack();
archive.entry({ name: 'home/node/', type: 'directory', mode: 0o750, uid: 1000, gid: 1000 });
archive.entry({ name: 'home/node/secret.txt', type: 'file', mode: 0o600, uid: 1000, gid: 1000 }, 'hush');
archive.entry({ name: 'etc/claudepilot/', type: 'directory', mode: 0o755, uid: 0, gid: 0 });
archive.entry({ name: 'etc/claudepilot/by-root', type: 'file', mode: 0o644, uid: 0, gid: 0 }, 'root owns');
archive.finalize();
const put = await openHost(svc, { op: 'put' });
for await (const chunk of archive) put.write(chunk as Buffer);
put.eof();
out.put = await put.result();
out.stat = (await run(['sh', '-c', 'stat -c "%u:%g %a %n" /home/node/secret.txt /etc/claudepilot/by-root /home/node']))!.text;
const read = await openHost(svc, { op: 'read', path: '/home/node/secret.txt' });
out.read = { text: (await read.result(), read.text()) };

// usage from the cgroup (the container was started with --cpus 1 --memory 256m)
svc.report!();
await new Promise((r) => setTimeout(r, 300));
out.usage = svc.report!().usage;
console.log(JSON.stringify(out));
svc.close();
process.exit(0);
