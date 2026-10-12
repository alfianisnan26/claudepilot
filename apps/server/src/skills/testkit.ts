// Test helpers for skillsets (not used by the portal): a zip builder that can also craft hostile archives,
// an in-memory Docker workspace that runs the delivery writer's commands and answers the verification
// script, and a harness with the store, pool service, skills module and reconciler wired as index.ts does.

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { treeHash } from '../delivery/marketplace.js';
import { Reconciler, type FragmentProvider } from '../delivery/reconciler.js';
import { MANIFEST_PATH, PLUGINS_DIR, type Manifest } from '../delivery/types.js';
import { PoolService } from '../pools/service.js';
import { MIGRATIONS } from '../store/migrations.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { DeliveryAccess, Runtime } from '../workspaces/runtime.js';
import { SkillsModule } from './module.js';

export interface ZipItem {
  name: string;
  data?: Buffer | string;
  /** Permission bits (default 0o644). */
  mode?: number;
  type?: 'file' | 'symlink' | 'dir' | 'fifo';
  /** 0 stored, 8 deflate (default). */
  method?: number;
  /** Lie about the uncompressed size (bomb tests). */
  declaredSize?: number;
  /** Lie about the CRC. */
  crc?: number;
  flags?: number;
}

/** A zip with Unix modes, built the way `zip` does; options make it hostile on purpose. */
export function makeZip(items: ZipItem[], opts: { overlap?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let firstOffset = 0;
  items.forEach((it, i) => {
    const type = it.type ?? 'file';
    const raw = Buffer.from(type === 'dir' ? '' : (it.data ?? ''));
    const method = type === 'dir' ? 0 : (it.method ?? 8);
    const packed = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(type === 'dir' && !it.name.endsWith('/') ? `${it.name}/` : it.name);
    const fmt = { file: 0o100000, symlink: 0o120000, dir: 0o040000, fifo: 0o010000 }[type];
    const crc = it.crc ?? crc32(raw) >>> 0;
    const size = it.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE((it.flags ?? 0) | 0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const at = opts.overlap && i > 0 ? firstOffset : offset;
    if (i === 0) firstOffset = offset;
    if (!(opts.overlap && i > 0)) {
      locals.push(local, name, packed);
      offset += 30 + name.length + packed.length;
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE((it.flags ?? 0) | 0x800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE((((fmt | (it.mode ?? (type === 'dir' ? 0o755 : 0o644))) << 16) >>> 0) as number, 38);
    c.writeUInt32LE(at, 42);
    central.push(c, name);
  });
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const unquote = (s: string) => s.replace(/'\\''/g, "'");

/** What the fake workspace's `claude plugin …` commands answer, per test. */
export interface FakeClaude {
  /** Set when no session has registered the marketplace yet. */
  unregistered?: boolean;
  /** Per prefix: override the skills `plugin details` lists. */
  details?: Record<string, string[]>;
  /** Per plugin id: load errors `plugin list --json` reports. */
  errors?: Record<string, string[]>;
  /** Make the verify script hang past its timeout. */
  hang?: boolean;
  version?: string;
}

/**
 * A Docker workspace in memory: what the archive API writes, and the writer's shell commands run in
 * order. `plugin details` and `plugin list --json` answer from the catalog and folders actually written.
 */
export function memoryWorkspace() {
  const files = new Map<string, { content: string; mode: number; bytes?: Buffer }>();
  const dirs = new Set<string>();
  const state = { running: true, claude: {} as FakeClaude, verifyRuns: 0 };
  const within = (root: string) => (p: string) => p === root || p.startsWith(`${root}/`);
  const removeTree = (root: string) => {
    for (const k of [...files.keys()]) if (within(root)(k)) files.delete(k);
    for (const d of [...dirs]) if (within(root)(d)) dirs.delete(d);
  };
  const moveTree = (from: string, to: string) => {
    for (const [k, v] of [...files]) if (within(from)(k)) (files.delete(k), files.set(to + k.slice(from.length), v));
    for (const d of [...dirs]) if (within(from)(d)) (dirs.delete(d), dirs.add(to + d.slice(from.length)));
  };
  const tree = (dir: string) =>
    dirs.has(dir)
      ? treeHash(
          [...files]
            .filter(([k]) => k.startsWith(`${dir}/`))
            .map(([k, v]) => (v.bytes ? { path: k.slice(dir.length + 1), content: v.bytes.toString('base64'), encoding: 'base64' as const, mode: v.mode } : { path: k.slice(dir.length + 1), content: v.content, mode: v.mode })),
        )
      : null;
  const catalog = () => JSON.parse(files.get('/etc/claudepilot/marketplace/.claude-plugin/marketplace.json')?.content ?? '{"plugins":[]}') as { plugins: { name: string; source: string; version: string }[] };

  const readApplied = (script: string) => {
    const raw = files.get(MANIFEST_PATH)?.content ?? '';
    let out = `${raw}<<<cp-hashes>>>\n`;
    if (raw) {
      const m = JSON.parse(raw) as Manifest;
      for (const p of Object.keys(m.files)) out += `${files.has(p) ? sha256(files.get(p)!.content) : '-'} ${p}\n`;
      if (script.includes('CP_TREES=1 ')) {
        out += '<<<cp-trees>>>\n';
        for (const p of m.plugins ?? []) {
          const d = `${PLUGINS_DIR}/${p.name}/${p.treeHash.slice(0, 12)}`;
          out += `${tree(d) ?? '-'} ${d}\n`;
        }
      }
      out += '<<<cp-claude>>>\n';
    }
    return `${out}<<<cp-version>>>\n${state.claude.version ?? '2.1.296 (Claude Code)'}\n`;
  };

  /** Answers the verification script like Claude Code 2.1.296 does. */
  const verify = (script: string) => {
    state.verifyRuns++;
    const prefixes = [...script.matchAll(/<<<cp-details ([a-z0-9-]+)>>>/g)].map((m) => m[1]!);
    const cat = catalog();
    let out = '';
    for (const p of prefixes) {
      out += `<<<cp-details ${p}>>>\n`;
      const entry = cat.plugins.find((x) => x.name === p);
      const dir = entry ? `/etc/claudepilot/marketplace/${entry.source.slice(2)}` : '';
      if (state.claude.unregistered) out += `✘ Could not load details for "${p}": Marketplace 'claudepilot' not found in configuration. Available marketplaces: anthropic-plugin-directory\n<<<cp-exit 1>>>\n`;
      else if (!entry || !dirs.has(dir)) out += `Plugin "${p}@claudepilot" not found. Run \`claude plugin list\` to see installed plugins.\n<<<cp-exit 1>>>\n`;
      else {
        const skills = state.claude.details?.[p] ?? [...new Set([...files.keys()].filter((k) => k.startsWith(`${dir}/skills/`) && k.endsWith('/SKILL.md')).map((k) => k.slice(dir.length + 8).split('/')[0]!))];
        out += `${p} ${entry.version}\n  Source: ${p}@claudepilot\n\nComponent inventory\n  Skills (${skills.length})  ${skills.join(', ')}\n  Agents (0)\n<<<cp-exit 0>>>\n`;
      }
    }
    const list = state.claude.unregistered
      ? []
      : cat.plugins.map((x) => {
          const dir = `/etc/claudepilot/marketplace/${x.source.slice(2)}`;
          const errors = state.claude.errors?.[`${x.name}@claudepilot`] ?? (dirs.has(dir) ? [] : [`Plugin directory not found at path: ${dir}. Check that the marketplace entry has the correct path.`]);
          return { id: `${x.name}@claudepilot`, version: x.version, scope: 'managed', enabled: true, readFromFolder: dir, ...(errors.length ? { errors } : { folderVersion: x.version }) };
        });
    return `${out}<<<cp-list>>>\n${JSON.stringify(list, null, 2)}\n<<<cp-end>>>\n`;
  };

  const run = (script: string) => {
    if (script.includes('<<<cp-hashes>>>')) return readApplied(script);
    if (script.includes('<<<cp-list>>>')) return verify(script);
    for (const line of script.split('\n')) {
      let m: RegExpExecArray | null;
      if (line === 'set -e') continue;
      if ((m = /^mv -f '([^']*)' '([^']*)'$/.exec(line))) {
        const [from, to] = [unquote(m[1]!), unquote(m[2]!)];
        if (!files.has(from)) throw new Error(`mv: ${from} missing`);
        files.set(to, files.get(from)!);
        files.delete(from);
      } else if ((m = /^mv -T -- '([^']*)' '([^']*)'$/.exec(line))) moveTree(m[1]!, m[2]!);
      else if ((m = /^if \[ -e '([^']*)' \]; then mv -T -- '([^']*)' '([^']*)'; fi$/.exec(line))) {
        if (dirs.has(m[1]!)) moveTree(m[2]!, m[3]!);
      } else if ((m = /^rm -rf -- '([^']*)'$/.exec(line))) removeTree(m[1]!);
      else if ((m = /^rmdir --ignore-fail-on-non-empty -- '([^']*)' 2>\/dev\/null \|\| true$/.exec(line))) {
        const dir = m[1]!;
        if (dirs.has(dir) && ![...dirs, ...files.keys()].some((p) => p.startsWith(`${dir}/`))) dirs.delete(dir);
      } else if ((m = /^rm -f '([^']*)'$/.exec(line))) files.delete(m[1]!);
      else if ((m = /^for x in '([^']*)'\/\.\*\.cp-tmp; do/.exec(line))) {
        for (const d of [...dirs]) if (dirname(d) === m[1] && basename(d).startsWith('.') && d.endsWith('.cp-tmp')) removeTree(d);
      } else throw new Error(`unexpected command: ${line}`);
    }
    return '';
  };

  const access: DeliveryAccess = {
    state: async () => ({ exists: true, running: state.running }),
    run: async (_name, script, opts) => {
      if (!state.running) throw new Error('not running');
      if (script.includes('<<<cp-list>>>') && state.claude.hang) throw new Error(`exec timed out after ${opts?.timeoutMs ?? 30_000} ms`);
      return { code: 0, stdout: run(script), stderr: '' };
    },
    put: async (_name, entries) => {
      for (const e of entries) {
        if (e.type === 'directory') dirs.add(e.path);
        else files.set(e.path, { content: e.content ?? '', mode: e.mode, ...(e.bytes ? { bytes: e.bytes } : {}) });
      }
    },
    read: async (_name, path) => files.get(path)?.content ?? null,
    watchStarts: () => () => {},
  };
  const runtime = { delivery: access, target: { id: 'docker', label: 'Docker', kind: 'docker', where: '' } } as unknown as Runtime;
  const manifest = () => JSON.parse(files.get(MANIFEST_PATH)?.content ?? 'null') as Manifest | null;
  /** Version folders of a plugin now on disk. */
  const folders = (name: string) => [...dirs].filter((d) => dirname(d) === `${PLUGINS_DIR}/${name}` && !basename(d).startsWith('.')).map((d) => basename(d)).sort();
  const dropIn = () => JSON.parse(files.get('/etc/claude-code/managed-settings.d/60-claudepilot-skills.json')?.content ?? 'null') as Record<string, unknown> | null;
  return { files, dirs, state, runtime, manifest, folders, dropIn, catalog };
}

export const WS = 'docker/ws1';


/** The store, pool service, skills module and a reconciler on an in-memory workspace, as index.ts wires them. */
export async function skillsHarness(opts: { minClaudeVersion?: string; runtime?: Runtime } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-skills-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()), migrations: MIGRATIONS });
  const providers: FragmentProvider[] = [];
  const service = new PoolService(store, { providers });
  const ws = memoryWorkspace();
  // A real runtime (the Docker integration tests) replaces the in-memory workspace.
  const runtime = opts.runtime ?? ws.runtime;
  const skills = new SkillsModule(store, service, { runtimes: () => runtime, minClaudeVersion: opts.minClaudeVersion });
  const reconciler = new Reconciler(store, () => runtime, () => [runtime], providers);
  service.reconciler = reconciler;
  const row = () => reconciler.row(WS);
  /** One reconcile of the workspace, plus whatever it queued, plus the verification it started. */
  const run = async (why = 'test') => {
    await reconciler.request(WS, why);
    await new Promise((r) => setTimeout(r, 30));
    await reconciler.request(WS, 'settle');
    await new Promise((r) => setTimeout(r, 30));
  };
  const done = () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { dataDir, store, service, skills, ws, reconciler, row, run, done };
}

/** A small skill folder's zip items. */
export function skillItems(folder: string, opts: { name?: string; description?: string; body?: string; extra?: ZipItem[]; frontmatter?: string } = {}): ZipItem[] {
  const fm = opts.frontmatter ?? `name: ${opts.name ?? basename(folder)}\ndescription: ${opts.description ?? `Does ${basename(folder)} things`}\nlicense: MIT\n`;
  return [{ name: `${folder}/SKILL.md`, data: `---\n${fm}---\n${opts.body ?? `Follow these steps for ${basename(folder)}.\n`}` }, ...(opts.extra ?? [])];
}
