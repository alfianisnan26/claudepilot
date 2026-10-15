// cp-ci: the command the portal runs in a workspace, and the hook git calls on a push (PRD §11.1). Every command prints one
// line, `@cpci ` and a JSON object, and nothing else; arguments are an argument array, never a shell string.

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { CI_LIMITS } from '../limits.js';
import { Fail, git, reply } from './common.js';
import { hookPostReceive } from './events.js';
import { repoBranches, repoConnect, repoCreate, repoDelete, repoInfo, repoList, repoMerge, repoRev, ensureHooks, needRepo } from './repo.js';
import { approveRun, archiveLogs, cancelRun, gc, poll, readLog, startRun } from './runs.js';
import { changes } from './changes.js';
import { snapshot } from './snapshot.js';
import { supervise } from './supervise.js';
import { repoSync } from './upstream.js';

type Flags = Record<string, string | true>;

/** `--name value` and `--flag`; anything else is a positional. A flag that isn't known is an error, so a typo is never silently ignored. */
function parse(args: string[], known: Record<string, 'value' | 'bool'>): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const kind = known[a.slice(2)];
    if (!kind) throw new Fail('bad_flag', `Unknown option ${a}.`);
    if (kind === 'bool') flags[a.slice(2)] = true;
    else {
      const v = args[++i];
      if (v === undefined) throw new Fail('bad_flag', `${a} needs a value.`);
      flags[a.slice(2)] = v;
    }
  }
  return { pos, flags };
}

const num = (v: string | true | undefined, fallback: number, lo: number, hi: number): number => {
  if (v === undefined || v === true) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Fail('bad_flag', `A number from ${lo} to ${hi} is needed.`);
  return n;
};
const list = (v: string | true | undefined): string[] => (typeof v === 'string' && v ? v.split(',').filter(Boolean) : []);
const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

async function readAll(limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of process.stdin as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > limit) break;
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function dispatch(cmd: string | undefined, args: string[], self: string): Promise<Record<string, unknown> | null> {
  switch (cmd) {
    case 'version': {
      const v = await git(['--version']);
      return { ok: true, version: createHash('sha256').update(readFileSync(self)).digest('hex').slice(0, 16), node: process.version, git: v.stdout.toString('utf8').trim().replace(/^git version /, '') };
    }
    case 'repo': {
      const [sub, ...rest] = args;
      switch (sub) {
        case 'create': {
          const { pos, flags } = parse(rest, { from: 'value', branch: 'value', connect: 'bool' });
          return repoCreate(pos[0], { from: str(flags.from), branch: str(flags.branch), connect: flags.connect === true }, self);
        }
        case 'list':
          return { ok: true, repos: await repoList(self) };
        case 'info':
          return { ok: true, ...(await repoInfo(parse(rest, {}).pos[0] as string, self)) };
        case 'ensure': {
          const name = parse(rest, {}).pos[0] as string;
          needRepo(name);
          return { ok: true, hook: await ensureHooks(name, self) };
        }
        case 'connect': {
          const { pos } = parse(rest, {});
          return repoConnect(pos[0] as string, pos[1], self);
        }
        case 'delete':
          return repoDelete(parse(rest, {}).pos[0]);
        case 'branches': {
          const { pos, flags } = parse(rest, { limit: 'value' });
          return repoBranches(pos[0], num(flags.limit, 200, 1, 500));
        }
        case 'rev': {
          const { pos } = parse(rest, {});
          return repoRev(pos[0], pos[1]);
        }
        case 'sync': {
          const { pos, flags } = parse(rest, { url: 'value', secret: 'value', pin: 'value' });
          return repoSync(pos[0], { url: str(flags.url), secret: str(flags.secret), pin: str(flags.pin) });
        }
        default:
          throw new Fail('bad_command', 'Unknown repo command.');
      }
    }
    case 'merge': {
      const { pos, flags } = parse(args, { strategy: 'value', expect: 'value', message: 'value', author: 'value' });
      return repoMerge(pos[0], { source: pos[1], target: pos[2], strategy: str(flags.strategy), expect: str(flags.expect), message: str(flags.message), author: str(flags.author) });
    }
    case 'hook': {
      if (args[0] !== 'post-receive') throw new Fail('bad_command', 'Unknown hook.');
      return hookPostReceive(() => readAll(1_048_576));
    }
    case 'poll': {
      const { flags } = parse(args, { ack: 'value', runs: 'value', max: 'value' });
      return poll({ ack: list(flags.ack), runs: list(flags.runs), max: num(flags.max, CI_LIMITS.eventsPerPoll, 1, CI_LIMITS.eventsPerPoll) }, self);
    }
    case 'snapshot': {
      const { pos } = parse(args, {});
      return snapshot(pos[0], pos[1]);
    }
    case 'changes': {
      const { pos, flags } = parse(args, { show: 'value' });
      return changes(pos[0], pos[1], pos[2], str(flags.show));
    }
    case 'start': {
      const { pos, flags } = parse(args, { bytes: 'value' });
      return startRun(pos[0], num(flags.bytes, 0, 0, 1_048_576));
    }
    case 'exec': {
      const id = args[0];
      if (!id) throw new Fail('bad_run', 'No run.');
      await supervise(id);
      return null;
    }
    case 'log': {
      const { pos, flags } = parse(args, { max: 'value' });
      return readLog(pos[0], pos[1], Number(pos[2]), Number(pos[3] ?? 0), num(flags.max, CI_LIMITS.logChunkBytes, 1024, CI_LIMITS.logChunkBytes));
    }
    case 'archive': {
      const { pos, flags } = parse(args, { head: 'value', tail: 'value', total: 'value' });
      return archiveLogs(pos[0], num(flags.head, CI_LIMITS.archiveHeadBytes, 0, 1_048_576), num(flags.tail, CI_LIMITS.archiveTailBytes, 0, 1_048_576), num(flags.total, CI_LIMITS.archiveRunBytes, 0, 8_388_608));
    }
    case 'cancel':
      return cancelRun(parse(args, {}).pos[0]);
    case 'approve': {
      const { pos, flags } = parse(args, { bytes: 'value', reject: 'bool' });
      return approveRun(pos[0], pos[1], flags.reject === true ? 'reject' : 'approve', num(flags.bytes, 0, 0, 64));
    }
    case 'gc': {
      const { flags } = parse(args, { days: 'value' });
      return gc(num(flags.days, CI_LIMITS.runDirDays, 0, 3650));
    }
    default:
      throw new Fail('bad_command', `Unknown command${cmd ? ` ${cmd}` : ''}. See docs/prd/local-git-ci.md.`);
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const self = realpathSync(process.argv[1]!);
  try {
    const out = await dispatch(cmd, rest, self);
    // A hook never prints (git shows its output to whoever pushed), and the supervisor has no one to answer.
    if (out === null || cmd === 'hook') return 0;
    process.stdout.write(reply(out));
    return 0;
  } catch (e) {
    const f = e instanceof Fail ? e : new Fail('internal', e instanceof Error ? e.message : String(e));
    // A hook must never print or fail loudly: git shows its output to whoever pushed.
    if (cmd === 'hook') return 0;
    process.stdout.write(reply({ ok: false, error: f.code, message: f.message, ...f.extra }));
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.stdout.write('', () => process.exit(code)),
  () => process.exit(1),
);
