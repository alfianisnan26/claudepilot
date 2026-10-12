// Knowledge: importing a vault from a zip (Knowledge PRD §15.1, FR31). The zip is untrusted: its structure
// is checked and capped before anything is inflated (zip.ts), a path that could leave the folder fails the
// whole import, and everything else is classified: kept as a note, kept as an attachment, or skipped with a
// reason the person is shown. `.obsidian` and the other dot-folders are never imported; two hints are read
// from `.obsidian/daily-notes.json` (the folder, and the format only to see that it's the one we support).

import { basename } from 'node:path';
import type { VaultImportReport, VaultImportSkip } from '@portal/contracts';
import { classifyFile } from './attachments.js';
import { isKnowledgeError, KnowledgeError } from './errors.js';
import type { Actor } from './journal.js';
import { cleanPath, foldPath, isHiddenName } from './paths.js';
import type { CallerScope, KnowledgeService } from './service.js';
import { openZip, ZipError, type ZipFile } from './zip.js';
import type { ConflictPolicy } from './vault.js';

export interface ImportOptions {
  /** The zip's file name: a wrapper folder named like it is removed. */
  filename?: string;
  /** A new vault with this name... */
  name?: string;
  /** ...or an existing vault (id or name). */
  into?: string;
  policy: ConflictPolicy;
  actor: Actor;
  scope?: CallerScope | null;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/** Fails the whole import for paths that could only be an attempt to leave the folder. */
function assertSafeName(raw: string): void {
  // eslint-disable-next-line no-control-regex
  const bad = /[\u0000-\u001f\u007f]/.test(raw) || raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.split('/').some((s) => s === '..');
  if (bad) throw new KnowledgeError('INVALID_PATH', `The zip has an unsafe path (${JSON.stringify(raw.slice(0, 80))}), so none of it was imported.`);
}

const hiddenRaw = (name: string): boolean => name.split('/').some((s) => s !== '' && isHiddenName(s));

/** The folder a wrapper strip would remove, or null: one top-level folder that holds `.obsidian`, or is named like the zip. */
function wrapperOf(names: string[], filename: string | undefined): string | null {
  const tops = new Set<string>();
  let rootFiles = 0;
  for (const n of names) {
    if (hiddenRaw(n) && !n.includes('/')) continue;
    const i = n.indexOf('/');
    if (i < 0) {
      rootFiles++;
      continue;
    }
    const top = n.slice(0, i);
    if (isHiddenName(top)) continue;
    tops.add(top);
  }
  if (tops.size !== 1 || rootFiles > 0) return null;
  const top = [...tops][0]!;
  const zipName = filename ? basename(filename).replace(/\.zip$/i, '') : '';
  if (names.some((n) => n.startsWith(`${top}/.obsidian/`))) return top;
  if (zipName && foldPath(zipName) === foldPath(top)) return top;
  return null;
}

function dailyHint(zip: ZipFile[], strip: string): string | null {
  const f = zip.find((e) => !e.isDir && e.name === `${strip ? `${strip}/` : ''}.obsidian/daily-notes.json`);
  if (!f || f.size > 4096) return null;
  try {
    const j = JSON.parse(f.read().toString('utf8')) as { folder?: unknown; format?: unknown };
    if (j.format !== undefined && j.format !== '' && j.format !== 'YYYY-MM-DD') return null;
    if (typeof j.folder !== 'string') return null;
    return cleanPath(j.folder.trim().replace(/^\/+/, ''), { strict: true, folder: true });
  } catch {
    return null;
  }
}

export async function importZip(service: KnowledgeService, buf: Buffer, o: ImportOptions): Promise<VaultImportReport> {
  const started = Date.now();
  const lim = service.limits;
  const skips = new Map<VaultImportSkip['reason'], VaultImportSkip>();
  const skip = (reason: VaultImportSkip['reason'], example: string) => {
    const s = skips.get(reason) ?? { reason, count: 0, examples: [] };
    s.count++;
    if (s.examples.length < 5 && !s.examples.includes(example)) s.examples.push(example);
    skips.set(reason, s);
  };
  const warnings: string[] = [];

  let zip: ZipFile[];
  try {
    zip = openZip(buf, { packedBytes: lim.importPackedBytes, unpackedBytes: lim.importUnpackedBytes, files: lim.vaultFiles, ratio: lim.importRatio }, hiddenRaw);
  } catch (e) {
    if (e instanceof ZipError) throw new KnowledgeError('INVALID_INPUT', e.message);
    throw e;
  }
  const files = zip.filter((e) => !e.isDir);
  for (const f of files) assertSafeName(f.name);

  const wrapper = wrapperOf(files.map((f) => f.name), o.filename);
  if (wrapper) warnings.push(`Removed the wrapper folder “${wrapper}”.`);
  const prefix = wrapper ? `${wrapper}/` : '';
  const hint = dailyHint(zip, wrapper ?? '');

  // Classify everything first, so the whole plan is known before any file is written.
  interface Planned {
    file: ZipFile;
    path: string;
    kind: 'note' | 'file';
  }
  const plan: Planned[] = [];
  const seen = new Map<string, string>();
  let nonPortable = 0;
  const dailyDirs = new Map<string, number>();
  for (const f of files) {
    const name = prefix && f.name.startsWith(prefix) ? f.name.slice(prefix.length) : f.name;
    if (hiddenRaw(name)) {
      skip('hidden', name.split('/').find((s) => isHiddenName(s)) ?? name);
      continue;
    }
    if (f.type !== 'file') {
      skip('symlink', name);
      continue;
    }
    let path: string;
    try {
      path = cleanPath(name, { strict: false });
    } catch {
      skip('invalid-name', name);
      continue;
    }
    const cls = classifyFile(path);
    if (cls.kind === 'skip') {
      skip(cls.reason === 'dangerous' ? 'dangerous' : 'not-allowed', path);
      continue;
    }
    if (f.size > (cls.kind === 'note' ? lim.noteBytes : lim.attachmentBytes)) {
      skip('too-large', path);
      continue;
    }
    const key = foldPath(path);
    if (seen.has(key)) {
      skip('duplicate', path);
      continue;
    }
    seen.set(key, path);
    try {
      cleanPath(path, { strict: true });
    } catch {
      nonPortable++;
    }
    if (cls.kind === 'note') {
      const m = /^(?:(.*)\/)?\d{4}-\d{2}-\d{2}\.md$/.exec(path);
      if (m) dailyDirs.set(m[1] ?? '', (dailyDirs.get(m[1] ?? '') ?? 0) + 1);
    }
    plan.push({ file: f, path, kind: cls.kind === 'note' ? 'note' : 'file' });
  }
  if (nonPortable) warnings.push(`${nonPortable} file name${nonPortable === 1 ? '' : 's'} can’t be linked with [[ ]] or may not work on Windows or macOS (they contain one of # ^ [ ] | : * ? " < >). They were kept as they are.`);
  if (!plan.length) {
    const why = [...skips.values()].map((s) => `${s.count} ${s.reason}`).join(', ');
    throw new KnowledgeError('INVALID_INPUT', `There is nothing to import in that zip${why ? ` (skipped: ${why})` : ''}.`);
  }
  if (plan.length > lim.vaultFiles) throw new KnowledgeError('LIMIT_REACHED', `That is ${plan.length.toLocaleString('en')} files; a vault holds at most ${lim.vaultFiles.toLocaleString('en')}.`);

  // The target: an existing vault, or a new one named for the zip.
  let created = false;
  let target: { vault: ReturnType<KnowledgeService['openForImport']>['vault']; id: string; name: string };
  if (o.into) {
    const { vault, row } = service.openForImport(o.into, o.scope);
    if (vault.readOnly) throw new KnowledgeError('READ_ONLY', 'That vault is read-only.');
    target = { vault, id: row.id, name: row.name };
  } else {
    const base = (o.name ?? (o.filename ? basename(o.filename).replace(/\.zip$/i, '') : '')).trim() || 'Imported vault';
    let name = base.slice(0, 60);
    const taken = new Set(service.list().map((v) => v.name.toLowerCase()));
    for (let i = 2; taken.has(name.toLowerCase()) && i < 1000; i++) name = `${base.slice(0, 55)} (${i})`;
    const made = service.createForImport(name, o.actor);
    created = true;
    target = { vault: made.vault, id: made.summary.id, name: made.summary.name };
  }

  let notes = 0;
  let attachments = 0;
  let renamed = 0;
  let overwritten = 0;
  let skippedExisting = 0;
  try {
    for (let i = 0; i < plan.length; i += 50) {
      for (const p of plan.slice(i, i + 50)) {
        try {
          const r = target.vault.importFile(p.path, p.file.read(), o.policy, o.actor);
          if (r.outcome === 'skipped') skippedExisting++;
          else {
            if (p.kind === 'note') notes++;
            else attachments++;
            if (r.outcome === 'renamed') renamed++;
            if (r.outcome === 'overwritten') overwritten++;
          }
        } catch (e) {
          if (isKnowledgeError(e) && (e.reason === 'TOO_LARGE' || e.reason === 'UNSUPPORTED_TYPE')) {
            skip(e.reason === 'TOO_LARGE' ? 'too-large' : 'not-text', p.path);
            continue;
          }
          throw e;
        }
      }
      await tick();
    }
  } catch (e) {
    if (created) service.remove(target.id, target.name, o.actor);
    if (e instanceof ZipError) throw new KnowledgeError('INVALID_INPUT', `${e.message}${created ? ' Nothing was imported.' : ` ${notes + attachments} files were imported before it stopped.`}`);
    throw e;
  }

  if (created) {
    const adopt = hint !== null ? hint : [...dailyDirs.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (adopt !== undefined && adopt !== null) {
      try {
        service.setDailyFolder(target.id, adopt);
        warnings.push(`Daily notes are in “${adopt || 'the vault root'}”${hint !== null ? ' (from the vault’s daily-notes settings)' : ''}.`);
      } catch {
        // an unusable folder name: keep the default
      }
    }
  }
  service.journal.audit({ vaultId: target.id, actor: o.actor.id, op: 'vault.import', outcome: 'ok', detail: `${notes} notes, ${attachments} files, ${[...skips.values()].reduce((n, s) => n + s.count, 0)} skipped` });
  return {
    vaultId: target.id,
    vaultName: target.name,
    created,
    notes,
    attachments,
    renamed,
    overwritten,
    skippedExisting,
    skipped: [...skips.values()],
    warnings,
    ms: Date.now() - started,
  };
}
