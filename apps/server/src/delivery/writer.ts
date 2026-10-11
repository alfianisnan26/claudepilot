import { basename, dirname } from 'node:path';
import type { DeliveryAccess, TarEntry } from '../workspaces/runtime.js';
import { folderPlugin, TREE_HASH_JS } from './marketplace.js';
import { CLAUDE_AGES_JS, parseClaudeAges } from './tombstones.js';
import { DROPIN_DIR, MANIFEST_PATH, MARKETPLACE_JSON, PLUGINS_DIR, ROOT, type Bundle, type BundlePlugin, type DeliveredFile, type HookLine, type Manifest } from './types.js';

/** Single-quoted for sh; paths are ours, but quote anyway. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const tmpName = (path: string) => `${dirname(path)}/.${path.slice(dirname(path).length + 1)}.cp-tmp`;
/** A version folder's hidden temp name, per generation, so a write that died halfway never merges into a later one. */
const tmpDir = (dir: string, generation: number) => `${dirname(dir)}/.${basename(dir)}.g${generation}.cp-tmp`;

/** The catalog and the drop-ins name other files, so they move into place after them (§6.4). */
const late = (path: string) => path === MARKETPLACE_JSON || path.startsWith(`${DROPIN_DIR}/`);

const manifestEntry = (manifest: Manifest, path = MANIFEST_PATH): TarEntry => ({
  path,
  type: 'file',
  content: `${JSON.stringify(manifest, null, 2)}\n`,
  mode: 0o644,
  uid: ROOT,
  gid: ROOT,
});

const fileEntry = (f: DeliveredFile, path = f.path): TarEntry => ({
  path,
  type: 'file',
  ...(f.encoding === 'base64' ? { content: '', bytes: Buffer.from(f.content, 'base64') } : { content: f.content }),
  mode: f.mode,
  uid: f.uid,
  gid: f.gid,
});

/** A version folder's tar entries, rooted at `root` (its final path, or its temp name). */
const folderEntries = (p: BundlePlugin, root: string): TarEntry[] => [
  { path: root, type: 'directory', mode: 0o755, uid: ROOT, gid: ROOT },
  ...p.dirs.map((d): TarEntry => ({ path: root + d.path.slice(p.dir.length), type: 'directory', mode: d.mode, uid: d.uid, gid: d.gid })),
  ...p.files.map((f) => fileEntry(f, root + f.path.slice(p.dir.length))),
];

/**
 * Deletions in a safe order: drop-ins stop naming things first, then plain files, then the catalog, and
 * version folders (paths ending in `/`) last, so nothing ever points at something already gone.
 */
export function deleteOrder(paths: string[]): string[] {
  const rank = (p: string) => (p.startsWith(`${DROPIN_DIR}/`) ? 0 : p === MARKETPLACE_JSON ? 2 : p.endsWith('/') ? 3 : 1);
  return [...paths].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * One deletion as sh. Folders only ever inside the marketplace's plugin folder, whatever the input says;
 * the plugin's own folder goes too once its last version is gone.
 */
function rm(path: string): string {
  if (!path.endsWith('/')) return `rm -f ${q(path)}`;
  if (!folderPlugin(path)) throw new Error(`Refusing to delete ${path}: not a plugin version folder.`);
  const dir = path.slice(0, -1);
  return `rm -rf -- ${q(dir)}\nrmdir --ignore-fail-on-non-empty -- ${q(dirname(dir))} 2>/dev/null || true`;
}

/**
 * Moves a complete version folder from its temp name into place. A folder that is already there (a
 * rollback to a retained version, or drift repair) is moved aside first, so its name is free for a moment
 * only in those cases. Leftover temp folders of earlier failed writes go too.
 */
function swapIn(dir: string, tmp: string): string[] {
  const old = `${dirname(dir)}/.${basename(dir)}.cp-old`;
  return [
    `rm -rf -- ${q(old)}`,
    `if [ -e ${q(dir)} ]; then mv -T -- ${q(dir)} ${q(old)}; fi`,
    `mv -T -- ${q(tmp)} ${q(dir)}`,
    `rm -rf -- ${q(old)}`,
    `for x in ${q(dirname(dir))}/.*.cp-tmp; do if [ -e "$x" ]; then rm -rf -- "$x"; fi; done`,
  ];
}

/**
 * Writes a bundle into one Docker workspace so Claude Code only ever sees a whole old file or a whole
 * new one (foundation PRD §6.2, §6.4):
 * - running: every file goes to a hidden temp name first, and each version folder to a hidden temp
 *   folder; then one root `exec` moves them into place in write order (referenced files, version folders,
 *   the catalog, drop-ins, manifest last), then deletes what's due;
 * - stopped: final names directly, in the same order (nothing reads them), manifest last; deleted files
 *   become empty files and folders wait, both finished at the next start.
 * `plugins` lists the version folders to write (default: all of the bundle's); folders already in place
 * are left alone. `lines` (hook lines, secrets A3) are appended when missing, after the drop-ins and
 * before the manifest, on a running workspace only. Returns the paths it couldn't delete yet.
 */
export async function writeBundle(
  access: DeliveryAccess,
  name: string,
  bundle: Bundle,
  opts: { running: boolean; deletes: string[]; plugins?: BundlePlugin[]; lines?: HookLine[] },
): Promise<{ deferred: string[] }> {
  const dirs: TarEntry[] = bundle.dirs.map((d) => ({ path: d.path, type: 'directory', mode: d.mode, uid: d.uid, gid: d.gid }));
  const plugins = opts.plugins ?? bundle.plugins;
  const early = bundle.files.filter((f) => !late(f.path));
  const after = bundle.files.filter((f) => late(f.path));

  if (!opts.running) {
    const blanks: TarEntry[] = opts.deletes.filter((p) => !p.endsWith('/')).map((path) => ({ path, type: 'file', content: '', mode: 0o644, uid: ROOT, gid: ROOT }));
    await access.put(name, [
      ...dirs,
      ...early.map((f) => fileEntry(f)),
      ...plugins.flatMap((p) => folderEntries(p, p.dir)),
      ...after.map((f) => fileEntry(f)),
      ...blanks,
      manifestEntry(bundle.manifest),
    ]);
    return { deferred: opts.deletes };
  }

  const generation = bundle.manifest.generation;
  const stage = (f: DeliveredFile) => ({ ...f, tmp: tmpName(f.path) });
  const stagedEarly = early.map(stage);
  const stagedLate = after.map(stage);
  const manifest = { ...manifestEntry(bundle.manifest), tmp: tmpName(MANIFEST_PATH) };
  await access.put(name, [
    ...dirs,
    ...plugins.flatMap((p) => folderEntries(p, tmpDir(p.dir, generation))),
    ...[...stagedEarly, ...stagedLate].map((f) => fileEntry(f, f.tmp)),
    { path: manifest.tmp, type: 'file', content: manifest.content, mode: manifest.mode, uid: manifest.uid, gid: manifest.gid },
  ]);
  const script = [
    'set -e',
    ...stagedEarly.map((f) => `mv -f ${q(f.tmp)} ${q(f.path)}`),
    ...plugins.flatMap((p) => swapIn(p.dir, tmpDir(p.dir, generation))),
    ...stagedLate.map((f) => `mv -f ${q(f.tmp)} ${q(f.path)}`),
    ...(opts.lines ?? []).map((l) => `grep -qxF -- ${q(l.line)} ${q(l.path)} 2>/dev/null || printf '%s\\n' ${q(l.line)} >> ${q(l.path)}`),
    `mv -f ${q(manifest.tmp)} ${q(MANIFEST_PATH)}`,
    ...deleteOrder(opts.deletes).map(rm),
  ].join('\n');
  const r = await access.run(name, script, { user: 'root' });
  if (r.code !== 0) throw new Error(`Moving files into place failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return { deferred: [] };
}

/**
 * Secrets PRD FR12: checks, as the workspace user, that delivered files are readable. Claude Code starts
 * without a drop-in it can't read, so a group or owner that doesn't match the image fails the delivery
 * instead of silently dropping its settings. Paths go on stdin; nothing is read but permissions.
 */
export async function checkReadable(access: DeliveryAccess, name: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const r = await access.run(name, `while IFS= read -r f; do [ -r "$f" ] || printf '%s\\n' "$f"; done`, { user: 'node', stdin: `${paths.join('\n')}\n` });
  const unreadable = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (r.code !== 0 || unreadable.length)
    throw new Error(`The workspace user can’t read ${unreadable.length ? unreadable.join(', ') : 'the delivered files'}; Claude Code starts without a drop-in it can’t read.`);
}

/** Deletes files (and version folders: paths ending in `/`) on a running workspace, in `deleteOrder`. */
export async function deleteFiles(access: DeliveryAccess, name: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const r = await access.run(name, ['set -e', ...deleteOrder(paths).map(rm)].join('\n'), { user: 'root' });
  if (r.code !== 0) throw new Error(`Deleting files failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}

export interface AppliedState {
  manifest: Manifest | null;
  /** path → sha256 of what is on disk now (running workspaces only). */
  hashes: Record<string, string | null> | null;
  /** `claude --version`, when the workspace is running. */
  claudeVersion: string | null;
  /** Version folder → its tree hash on disk now (null: missing or unreadable), when asked for on a running workspace. */
  trees: Record<string, string | null> | null;
  /** Age in seconds of each running `claude` process (running workspaces with a manifest only). */
  claudeAges: number[] | null;
}

/** What the workspace runs after printing the manifest: file hashes, version folder tree hashes on request, `claude` ages. */
const APPLIED_JS = `const fs=require("fs"),c=require("crypto"),m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for(const p of Object.keys(m.files||{})){let h="-";try{h=c.createHash("sha256").update(fs.readFileSync(p,"utf8")).digest("hex")}catch{}console.log(h+" "+p)}
if(process.env.CP_TREES){console.log("<<<cp-trees>>>");const tree=${TREE_HASH_JS};
for(const p of Array.isArray(m.plugins)?m.plugins:[]){if(!p||!/^[a-z0-9-]{1,64}$/.test(p.name)||!/^[0-9a-f]{64}$/.test(p.treeHash))continue;
const d="${PLUGINS_DIR}/"+p.name+"/"+p.treeHash.slice(0,12);let h="-";try{h=tree(d)}catch{}console.log(h+" "+d)}}
console.log("<<<cp-claude>>>");for(const a of (${CLAUDE_AGES_JS})(Number(process.env.CP_HZ)||100))console.log(a)`;

/**
 * Reads what the portal last delivered: the manifest, and on a running workspace the hash of every
 * file it lists, the Claude Code version and the age of each running `claude` process (for tombstones;
 * never an environment), plus on request the tree hash of each version folder it lists. On a stopped
 * workspace only the manifest is read, so secrets are never read back (§6.3).
 */
export async function readApplied(access: DeliveryAccess, name: string, running: boolean, opts: { trees?: boolean } = {}): Promise<AppliedState> {
  if (!running) {
    const raw = await access.read(name, MANIFEST_PATH);
    return { manifest: parseManifest(raw), hashes: null, claudeVersion: null, trees: null, claudeAges: null };
  }
  const script = `
    cat ${q(MANIFEST_PATH)} 2>/dev/null || true
    echo '<<<cp-hashes>>>'
    if [ -s ${q(MANIFEST_PATH)} ]; then
      CP_TREES=${opts.trees ? '1' : "''"} CP_HZ=$(getconf CLK_TCK 2>/dev/null || echo 100) node -e ${q(APPLIED_JS)} ${q(MANIFEST_PATH)} 2>/dev/null || true
    fi
    echo '<<<cp-version>>>'
    (claude --version 2>/dev/null || true) | head -1`;
  const r = await access.run(name, script, { user: 'root', timeoutMs: 20_000 });
  const [manifestPart = '', rest = ''] = r.stdout.split('<<<cp-hashes>>>\n');
  const [checks = '', versionPart = ''] = rest.split('<<<cp-version>>>\n');
  const [beforeAges = '', agesPart] = checks.split('<<<cp-claude>>>\n');
  const [hashPart = '', treePart] = beforeAges.split('<<<cp-trees>>>\n');
  const pairs = (text: string) => {
    const out: Record<string, string | null> = {};
    for (const line of text.split('\n')) {
      const m = /^(\S+) (.+)$/.exec(line.trim());
      if (m) out[m[2]!] = m[1] === '-' ? null : m[1]!;
    }
    return out;
  };
  return {
    manifest: parseManifest(manifestPart.trim() || null),
    hashes: pairs(hashPart),
    claudeVersion: versionPart.trim() || null,
    trees: treePart === undefined ? null : pairs(treePart),
    claudeAges: agesPart === undefined ? null : parseClaudeAges(agesPart),
  };
}

function parseManifest(raw: string | null): Manifest | null {
  if (!raw || !raw.trim()) return null;
  try {
    const m = JSON.parse(raw) as Manifest;
    return typeof m.portalId === 'string' && typeof m.generation === 'number' ? m : null;
  } catch {
    return null;
  }
}
