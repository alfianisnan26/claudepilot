// The branch release report (T-1079, PRD local-git-ci "Release reports"), the PURE part: a remote that follows an upstream and has the setting
// `{kind:'branch', branch, vaultId, folder}` gets one note each time the upstream sync moves that branch (a deploy: for Konfersi, a PR merged
// into `stg`). This file decides nothing about runs or vaults: it reads the merged pull requests out of the commit subjects, builds the note
// and says where it goes. `branchReporter.ts` gathers the facts (read only, through cp-ci in the workspace) and writes. Every fact has a source;
// one with none reads "unavailable". Free text from a commit goes through chat/redact, and so does the whole note.

import { shortSha } from '@portal/contracts';
import { redact } from '../chat/redact.js';
import { UNAVAILABLE, type ReportTicket } from './releaseReport.js';

/** A pull request a commit subject says was merged (Gitea's and GitHub's merge and squash subjects). */
export interface MergedPr {
  number: number;
  title: string;
}

/**
 * The pull request a commit subject names, or null:
 * - a merge commit: `Merge pull request '<title>' (#12) from <branch> into stg` (Gitea), `Merge pull request #12 from <owner/branch>` (GitHub);
 * - a squash or rebase merge: `<title> (#12)`.
 */
export function mergedPr(subject: string): MergedPr | null {
  const s = subject.trim();
  const gitea = /^Merge pull request '(.+)' \(#(\d{1,9})\) from \S+ into \S+$/.exec(s);
  if (gitea) return { number: Number(gitea[2]), title: gitea[1]! };
  const github = /^Merge pull request #(\d{1,9}) from \S+$/.exec(s);
  if (github) return { number: Number(github[1]), title: '' };
  const squash = /^(.+?) \(#(\d{1,9})\)$/.exec(s);
  if (squash) return { number: Number(squash[2]), title: squash[1]! };
  return null;
}

/**
 * The web address of the upstream for links (`https://host/owner/repo`), or null. Only https, never a user, password, query or fragment (the
 * runner refuses an upstream with them too), and a trailing `.git` dropped.
 */
export function upstreamWeb(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !/^\/[A-Za-z0-9._~/-]+$/.test(u.pathname)) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`;
}

export interface BranchCommit {
  sha: string;
  subject: string;
  author: string | null;
  /** ISO, the author date. */
  at: string | null;
  tickets: string[];
}

export interface BranchFacts {
  /** The remote's name (the module). */
  module: string;
  branch: string;
  /** Where the branch was before the move; null when the portal did not see it (a backfill of the first move). */
  from: string | null;
  to: string;
  /** The head commit's date (ISO): the note's date, so the same head always has the same note. */
  headAt: string | null;
  /** When the portal saw the move (ISO). */
  seenAt: string;
  web: string | null;
  /** The commits the branch gained, newest first (first parents), or why they could not be read. */
  commits: { list: BranchCommit[]; truncated: boolean } | { unavailable: string };
  tickets: ReportTicket[];
  /** Paths in the range under a `migration(s)` folder; null when the range can not be read. */
  migrations: string[] | null;
}

const oneLine = (s: string, max = 200): string =>
  redact(s)
    .replace(/\s+/g, ' ')
    .replace(/[|[\]]/g, (c) => (c === '|' ? '/' : c === '[' ? '(' : ')'))
    .trim()
    .slice(0, max);
const day = (iso: string | null): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : 'undated');

/** `<folder>/<module>/<date>-<short sha>`, without `.md`: the same head of the same module is the same note every time (idempotent). */
export function branchNoteName(folder: string, f: Pick<BranchFacts, 'module' | 'to' | 'headAt'>): string {
  const module = f.module.replace(/[^A-Za-z0-9._-]/g, '-');
  return `${folder}/${module}/${day(f.headAt)}-${shortSha(f.to)}`;
}

/** Paths that look like a migration (a `migration` or `migrations` folder anywhere), sorted. */
export function migrationPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => /(^|\/)migrations?\//i.test(p)).sort();
}

export function buildBranchReport(f: BranchFacts): string {
  const out: string[] = [];
  const title = `Release ${oneLine(f.module, 80)} ${day(f.headAt)} ${shortSha(f.to)}`;
  out.push(
    '---',
    `module: ${oneLine(f.module, 80)}`,
    `branch: ${oneLine(f.branch, 100)}`,
    `from: ${f.from ?? UNAVAILABLE}`,
    `to: ${f.to}`,
    `released_at: ${f.headAt ?? UNAVAILABLE}`,
    'tags: [release]',
    '---',
    '',
    `# ${title}`,
    '',
  );
  out.push('## Release', '');
  out.push(`- Module: ${oneLine(f.module, 80)}, branch \`${oneLine(f.branch, 100)}\``);
  out.push(`- Commits: ${f.from ? shortSha(f.from) : UNAVAILABLE}..${shortSha(f.to)}`);
  out.push(`- Head commit date: ${f.headAt ?? UNAVAILABLE}; seen by the portal ${f.seenAt}`);
  out.push(`- Upstream: ${f.web ?? UNAVAILABLE}`, '');

  if ('unavailable' in f.commits) {
    out.push('## Pull requests', '', `Commits in the range: unavailable (${oneLine(f.commits.unavailable, 160)}).`, '');
  } else {
    const { list, truncated } = f.commits;
    const prs = list.flatMap((c) => {
      const pr = mergedPr(c.subject);
      return pr ? [{ pr, c }] : [];
    });
    out.push('## Pull requests', '');
    if (!prs.length) out.push('None named in the commit subjects.');
    for (const { pr, c } of prs) {
      const label = `#${pr.number}`;
      const link = f.web ? `[${label}](${f.web}/pulls/${pr.number})` : label;
      out.push(`- ${link} ${pr.title ? oneLine(pr.title) : UNAVAILABLE}, merged by ${c.author ? oneLine(c.author, 80) : UNAVAILABLE}`);
    }
    out.push('');
    const authors = [...new Set(list.map((c) => c.author).filter((a): a is string => !!a))].sort();
    out.push('## Commits', '');
    out.push(`${list.length} commit${list.length === 1 ? '' : 's'} on the first-parent line${truncated ? ' (the walk stopped: older commits are not listed)' : ''}; authors: ${authors.length ? authors.map((a) => oneLine(a, 80)).join(', ') : UNAVAILABLE}.`, '');
    for (const c of list) out.push(`- ${shortSha(c.sha)} ${oneLine(c.subject)}${c.author ? ` (${oneLine(c.author, 80)})` : ''}`);
    out.push('');
  }

  out.push('## Tickets', '');
  if (!f.tickets.length) out.push(`None in the commit trailers${'unavailable' in f.commits ? ' (the commits are unavailable)' : ''}.`);
  for (const t of f.tickets) out.push(`- ${t.id} (${t.type ?? UNAVAILABLE}, now ${t.status ?? UNAVAILABLE}): ${t.summary ? oneLine(t.summary) : UNAVAILABLE}`);
  out.push('');

  out.push('## Migrations', '');
  if (f.migrations === null) out.push(`- ${UNAVAILABLE}`);
  else if (!f.migrations.length) out.push('- none');
  else for (const p of f.migrations) out.push(`- ${oneLine(p, 200)}`);
  out.push('');
  // The whole note once more: nothing credential-shaped reaches the vault, whichever field it came in through.
  return redact(out.join('\n'));
}

/** One line for the README list. */
export function branchSummary(f: BranchFacts): string {
  if ('unavailable' in f.commits) return `${f.module} ${f.branch}: commits unavailable`;
  const prs = f.commits.list.filter((c) => mergedPr(c.subject)).length;
  return `${f.module} ${f.branch}: ${f.commits.list.length} commits, ${prs} pull request${prs === 1 ? '' : 's'}`;
}
