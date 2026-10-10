import { dirname } from 'node:path';
import type { DeliveryAccess, TarEntry } from '../workspaces/runtime.js';
import { MANIFEST_PATH, ROOT, type Bundle, type Manifest } from './types.js';

/** Single-quoted for sh; paths are ours, but quote anyway. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const tmpName = (path: string) => `${dirname(path)}/.${path.slice(dirname(path).length + 1)}.cp-tmp`;

const manifestEntry = (manifest: Manifest, path = MANIFEST_PATH): TarEntry => ({
  path,
  type: 'file',
  content: `${JSON.stringify(manifest, null, 2)}\n`,
  mode: 0o644,
  uid: ROOT,
  gid: ROOT,
});

/**
 * Writes a bundle into one Docker workspace so Claude Code only ever sees a whole old file or a whole
 * new one (foundation PRD §6.2, §6.4):
 * - running: every file goes to a hidden temp name first, then one root `exec` renames them in write
 *   order, manifest last, then deletes what's due;
 * - stopped: final names directly (nothing reads them), manifest last; deletions become empty files
 *   and are finished at the next start.
 * Returns the paths it couldn't delete yet.
 */
export async function writeBundle(
  access: DeliveryAccess,
  name: string,
  bundle: Bundle,
  opts: { running: boolean; deletes: string[] },
): Promise<{ deferred: string[] }> {
  const dirs: TarEntry[] = bundle.dirs.map((d) => ({ path: d.path, type: 'directory', mode: d.mode, uid: d.uid, gid: d.gid }));

  if (!opts.running) {
    const blanks: TarEntry[] = opts.deletes.map((path) => ({ path, type: 'file', content: '', mode: 0o644, uid: ROOT, gid: ROOT }));
    await access.put(name, [
      ...dirs,
      ...bundle.files.map((f): TarEntry => ({ path: f.path, type: 'file', content: f.content, mode: f.mode, uid: f.uid, gid: f.gid })),
      ...blanks,
      manifestEntry(bundle.manifest),
    ]);
    return { deferred: opts.deletes };
  }

  const staged = [...bundle.files.map((f) => ({ ...f, tmp: tmpName(f.path) })), { ...manifestEntry(bundle.manifest), tmp: tmpName(MANIFEST_PATH) }];
  await access.put(name, [
    ...dirs,
    ...staged.map((f): TarEntry => ({ path: f.tmp, type: 'file', content: f.content, mode: f.mode, uid: f.uid, gid: f.gid })),
  ]);
  const script = [
    'set -e',
    ...staged.map((f) => `mv -f ${q(f.tmp)} ${q(f.path)}`),
    ...opts.deletes.map((p) => `rm -f ${q(p)}`),
  ].join('\n');
  const r = await access.run(name, script, { user: 'root' });
  if (r.code !== 0) throw new Error(`Moving files into place failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return { deferred: [] };
}

/** Deletes files on a running workspace (stopped-time blanks, or files whose grace period has passed). */
export async function deleteFiles(access: DeliveryAccess, name: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const r = await access.run(name, ['set -e', ...paths.map((p) => `rm -f ${q(p)}`)].join('\n'), { user: 'root' });
  if (r.code !== 0) throw new Error(`Deleting files failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}

export interface AppliedState {
  manifest: Manifest | null;
  /** path → sha256 of what is on disk now (running workspaces only). */
  hashes: Record<string, string | null> | null;
  /** `claude --version`, when the workspace is running. */
  claudeVersion: string | null;
}

/**
 * Reads what the portal last delivered: the manifest, and on a running workspace the hash of every
 * file it lists plus the Claude Code version. On a stopped workspace only the manifest is read, so
 * secrets are never read back (§6.3).
 */
export async function readApplied(access: DeliveryAccess, name: string, running: boolean): Promise<AppliedState> {
  if (!running) {
    const raw = await access.read(name, MANIFEST_PATH);
    return { manifest: parseManifest(raw), hashes: null, claudeVersion: null };
  }
  const script = `
    cat ${q(MANIFEST_PATH)} 2>/dev/null || true
    echo '<<<cp-hashes>>>'
    if [ -s ${q(MANIFEST_PATH)} ]; then
      node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=require("crypto");for(const p of Object.keys(m.files||{})){let h="-";try{h=c.createHash("sha256").update(require("fs").readFileSync(p,"utf8")).digest("hex")}catch{}console.log(h+" "+p)}' ${q(MANIFEST_PATH)} 2>/dev/null || true
    fi
    echo '<<<cp-version>>>'
    (claude --version 2>/dev/null || true) | head -1`;
  const r = await access.run(name, script, { user: 'root', timeoutMs: 20_000 });
  const [manifestPart = '', rest = ''] = r.stdout.split('<<<cp-hashes>>>\n');
  const [hashPart = '', versionPart = ''] = rest.split('<<<cp-version>>>\n');
  const hashes: Record<string, string | null> = {};
  for (const line of hashPart.split('\n')) {
    const m = /^(\S+) (.+)$/.exec(line.trim());
    if (m) hashes[m[2]!] = m[1] === '-' ? null : m[1]!;
  }
  return { manifest: parseManifest(manifestPart.trim() || null), hashes, claudeVersion: versionPart.trim() || null };
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
