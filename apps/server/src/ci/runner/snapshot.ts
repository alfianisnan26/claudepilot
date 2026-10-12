// `snapshot <repo> <sha>` (PRD §11.1): the commit's facts and the text of its pipeline files, read with `git cat-file`, so no
// repository code runs and the portal can parse and check the files itself. Bounded: a file too large, a link or a binary is
// reported as skipped, never read.

import { CI_LIMITS } from '../limits.js';
import { Fail, git, validSha } from './common.js';
import { needRepo } from './repo.js';

export interface SnapshotFile {
  path: string;
  text: string | null;
  skipped?: 'too_large' | 'symlink' | 'binary';
}

/** The files the portal reads: pipelines directly in `.pilot/`, and (later) steps and templates one folder down. */
const WANTED = /^\.pilot\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.ya?ml|(?:steps|templates)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.ya?ml)$/;

export async function snapshot(repo: unknown, sha: unknown): Promise<Record<string, unknown>> {
  const dir = needRepo(repo);
  if (!validSha(sha)) throw new Fail('bad_sha', 'That is not a commit id.');
  const meta = await git(['log', '-1', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B', sha], { gitDir: dir });
  if (meta.code !== 0) throw new Fail('no_commit', `There is no commit ${sha.slice(0, 7)} in ${repo as string}.`);
  const [full, parents, an, ae, at, ...body] = meta.stdout.toString('utf8').split('\0');
  const message = body.join('\0').trim();

  const tree = await git(['ls-tree', '-r', '-l', '-z', sha, '--', '.pilot'], { gitDir: dir });
  const entries = tree.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((e) => {
      const m = /^(\d{6}) (\w+) ([0-9a-f]{40}) +(\d+|-)\t(.*)$/s.exec(e);
      return m ? { mode: m[1]!, type: m[2]!, oid: m[3]!, size: m[4] === '-' ? 0 : Number(m[4]), path: m[5]! } : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null && e.type === 'blob' && WANTED.test(e.path));

  const files: SnapshotFile[] = [];
  const toRead: { path: string; oid: string }[] = [];
  let dropped = 0;
  for (const e of entries) {
    if (files.length + toRead.length >= CI_LIMITS.pipelineFiles * 3) {
      dropped++;
      continue;
    }
    if (e.mode === '120000') files.push({ path: e.path, text: null, skipped: 'symlink' });
    else if (e.size > CI_LIMITS.pipelineFileBytes) files.push({ path: e.path, text: null, skipped: 'too_large' });
    else toRead.push({ path: e.path, oid: e.oid });
  }

  if (toRead.length) {
    const batch = await git(['cat-file', '--batch'], { gitDir: dir, input: `${toRead.map((f) => f.oid).join('\n')}\n` });
    // `<oid> blob <size>\n<bytes>\n` for each object, in the order asked.
    const out = batch.stdout;
    let at2 = 0;
    for (const f of toRead) {
      const nl = out.indexOf(10, at2);
      if (nl < 0) break;
      const header = out.subarray(at2, nl).toString('utf8').split(' ');
      const size = Number(header[2]);
      if (header[1] !== 'blob' || !Number.isFinite(size)) {
        files.push({ path: f.path, text: null, skipped: 'binary' });
        at2 = nl + 1;
        continue;
      }
      const bytes = out.subarray(nl + 1, nl + 1 + size);
      at2 = nl + 1 + size + 1;
      files.push(bytes.includes(0) ? { path: f.path, text: null, skipped: 'binary' } : { path: f.path, text: bytes.toString('utf8') });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true,
    sha: full,
    parents: (parents ?? '').split(' ').filter(Boolean),
    author: { name: (an ?? '').slice(0, 100), email: (ae ?? '').slice(0, 100) },
    at: at ?? '',
    subject: message.split('\n')[0]?.slice(0, 200) ?? '',
    message: message.slice(0, 8192),
    hasPilot: entries.length > 0,
    files,
    dropped,
  };
}
