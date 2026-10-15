// The release report (T-591, D-69, PRD local-git-ci "Release reports"): when a remote's release pipeline ends and its `release` job passed, the
// portal writes one note into a knowledge vault. This file is the PURE part: when to report (`reportDecision`), what is read from the release job's
// log and the manifest, the note itself (`buildReport`), where it goes (`notePath`) and the README list (`updateReadme`). Nothing here reads a
// run, a repository or a vault: `releaseReporter.ts` gathers the facts and writes. Every fact carries its source; one with none reads
// "unavailable" (never a guess). Free text from a commit goes through chat/redact before it can reach the vault.

import { shortSha, type CiReleaseReportSetting, type CiRunStateFile } from '@portal/contracts';
import { redact } from '../chat/redact.js';

export const UNAVAILABLE = 'unavailable';
/** At most this many commits are walked for one report (the walk is one `cp-ci snapshot` per commit). */
export const REPORT_MAX_COMMITS = 200;
/** The manifest the release job puts the tags into (`DEPLOY_MANIFEST` in .pilot/scripts/lib.sh). */
export const MANIFEST_FILE = 'deploy/k3s/portal.yaml';

/* ---------- When ---------- */

export type RolledBack = 'no' | 'yes' | 'failed';
export type ReportDecision = { report: true; rolledBack: RolledBack } | { report: false; why: string };

const truthy = (v: unknown): boolean => v === true || v === 'true';
const falsy = (v: unknown): boolean => v === false || v === 'false';

/**
 * Whether a finished run gets a report. Only the configured pipeline, only a `release` job that PASSED, never a dry run, never `deploy=false`
 * (build only), never a release that did not run. A run whose later jobs failed still reports (the release happened); the report says whether
 * the rollback ran.
 */
export function reportDecision(run: { status: string; pipeline: string; inputs: string }, state: CiRunStateFile | null, setting: CiReleaseReportSetting | null): ReportDecision {
  if (!setting) return { report: false, why: 'no release report is set for this remote' };
  if (run.pipeline !== setting.pipeline) return { report: false, why: 'not the release pipeline of this remote' };
  if (run.status !== 'passed' && run.status !== 'failed' && run.status !== 'cancelled') return { report: false, why: 'the run has not ended' };
  let inputs: Record<string, unknown>;
  try {
    const v = JSON.parse(run.inputs) as unknown;
    inputs = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return { report: false, why: 'the run inputs can not be read' };
  }
  if (truthy(inputs.dry_run)) return { report: false, why: 'a dry run changes nothing' };
  if (falsy(inputs.deploy)) return { report: false, why: 'deploy=false builds only' };
  if (!state) return { report: false, why: 'the run state is unavailable' };
  const release = state.jobs.find((j) => j.id === 'release');
  if (release?.status !== 'passed') return { report: false, why: 'the release job did not pass' };
  const rollback = state.jobs.find((j) => j.id === 'rollback');
  return { report: true, rolledBack: rollback?.status === 'passed' ? 'yes' : rollback?.status === 'failed' ? 'failed' : 'no' };
}

/* ---------- What the release job and the manifest say ---------- */

export interface ReleaseLog {
  /** The release commit's short id. */
  commit: string | null;
  portal: string | null;
  workspace: string | null;
}

const TAG = /^[A-Za-z0-9._-]{1,128}$/;
const tagOf = (s: string | undefined): string | null => (s && TAG.test(s) ? s : null);

/**
 * The line .pilot/scripts/release.sh logs when it pushes: `release: <sha> (portal <tag>, workspace <tag>) to main`. Null when the log has none
 * (nothing was released by this run). The tags are the NEW_PORTAL and NEW_WORKSPACE of release.env.
 */
export function parseReleaseLog(text: string): ReleaseLog | null {
  for (const line of text.split('\n')) {
    const m = /^release: ([0-9a-f]{7,40}) \(([^)]*)\) to \S+\s*$/.exec(line.trim());
    if (!m) continue;
    const what = m[2]!;
    return { commit: m[1]!.slice(0, 7), portal: tagOf(/(?:^|, )portal ([^,\s]+)/.exec(what)?.[1]), workspace: tagOf(/(?:^|, )workspace ([^,\s]+)/.exec(what)?.[1]) };
  }
  return null;
}

/** The tags in the manifest's text (the tags BEFORE a release, when read at the run's commit). Null for a tag the text does not have exactly once. */
export function manifestTags(text: string | null): { portal: string | null; workspace: string | null } {
  if (text === null) return { portal: null, workspace: null };
  const one = (re: RegExp): string | null => {
    const all = [...text.matchAll(re)];
    return all.length === 1 ? tagOf(all[0]![1]) : null;
  };
  return { portal: one(/image: [^\s:]+(?::\d+)?\/claudepilot\/portal:([A-Za-z0-9._-]+)[ \t]*$/gm), workspace: one(/value: [^\s:]+(?::\d+)?\/claudepilot\/workspace:([A-Za-z0-9._-]+)[ \t]*$/gm) };
}

/** The `SUMMARY`-like lines of the gate log: every line starting `gate: ` or `SUMMARY`, at most 12, each cut. Null when there is none. */
export function gateSummary(tail: string | null): string[] | null {
  if (tail === null) return null;
  const lines = tail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('gate: ') || /^summary\b/i.test(l))
    .slice(-12)
    .map((l) => l.slice(0, 200));
  return lines.length ? lines : null;
}

/** Migration versions (`version: N`) in the migrations file's text, or null when it is not readable. */
export function migrationVersions(text: string | null): Set<number> | null {
  if (text === null) return null;
  const found = [...text.matchAll(/^\s+version: (\d+),/gm)].map((m) => Number(m[1]));
  return found.length ? new Set(found) : null;
}

/** The versions the head has and the base lacks, ascending; null when either side can not be read. */
export function migrationsAdded(base: string | null, head: string | null): number[] | null {
  const b = migrationVersions(base);
  const h = migrationVersions(head);
  if (!b || !h) return null;
  return [...h].filter((v) => !b.has(v)).sort((x, y) => x - y);
}

/* ---------- The note ---------- */

export interface ReportCommit {
  sha: string;
  subject: string;
  tickets: string[];
}
export interface ReportTicket {
  id: string;
  summary: string | null;
  type: string | null;
  status: string | null;
}
export interface ReportJob {
  id: string;
  name: string;
  status: string;
  durationMs: number | null;
}

export interface ReportFacts {
  repo: string;
  pipeline: string;
  runId: string;
  runNumber: number;
  /** A portal path: `/admin/ci/runs/<id>`. */
  runLink: string;
  sha: string;
  ref: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  actor: string | null;
  /** The tags released (the release job's log) and the ones before (the manifest at the run's commit). */
  tags: { portal: string | null; workspace: string | null; prevPortal: string | null; prevWorkspace: string | null };
  releaseCommit: string | null;
  /** The previous release the range starts from; null when there was none or it can not be told. */
  previous: { sha: string; runNumber: number } | null;
  /** The commits of the range, newest first, or why they could not be read. */
  commits: { list: ReportCommit[]; truncated: boolean } | { unavailable: string };
  tickets: ReportTicket[];
  migrations: number[] | null;
  contractsChanged: boolean | null;
  jobs: ReportJob[];
  gate: string[] | null;
  approval: { approval: string; by: string | null; at: string | null } | null;
  rolledBack: RolledBack;
}

const oneLine = (s: string, max = 200): string => redact(s).replace(/\s+/g, ' ').replace(/[|[\]]/g, (c) => (c === '|' ? '/' : c === '[' ? '(' : ')')).trim().slice(0, max);
const val = (v: string | number | null | undefined, why = UNAVAILABLE): string => (v === null || v === undefined || v === '' ? why : String(v));
const secs = (ms: number | null): string => (ms === null ? UNAVAILABLE : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const day = (iso: string | null): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : 'undated');

/** The tags part of a note's name: `portal 2026.10.15-11`, or `run 41` when the run released no tag we can read. */
export function tagsLabel(f: Pick<ReportFacts, 'tags' | 'runNumber'>): string {
  const parts = [f.tags.portal ? `portal ${f.tags.portal}` : '', f.tags.workspace ? `workspace ${f.tags.workspace}` : ''].filter(Boolean);
  return parts.length ? parts.join(' ') : `run ${f.runNumber}`;
}

/** `<folder>/<date> <tags>.md`, the same for the same run every time (so a second write replaces the note). */
export function notePath(folder: string, f: Pick<ReportFacts, 'tags' | 'runNumber' | 'finishedAt'>): string {
  const name = `${day(f.finishedAt)} ${tagsLabel(f)}`.replace(/[^A-Za-z0-9._ -]/g, '-');
  return `${folder}/${name}.md`;
}

/** The folder is one relative path of plain segments: no `..`, no leading or trailing slash, no odd characters. */
export function validFolder(folder: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}(?:\/[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}){0,3}$/.test(folder) && !folder.split('/').some((s) => s === '..' || s.endsWith('.') || s.endsWith(' '));
}

const TYPE_ORDER = ['feature', 'bug', 'task', 'chore', 'docs'];

export function buildReport(f: ReportFacts): string {
  const out: string[] = [];
  const title = `Release ${day(f.finishedAt)} ${tagsLabel(f)}`;
  const verdict = f.rolledBack === 'yes' ? 'rolled back' : f.rolledBack === 'failed' ? 'rollback ran and failed' : f.status === 'passed' ? 'released and verified' : f.status === 'failed' ? 'released, a later job failed' : 'released, the run was cancelled';
  out.push('---', `run_id: ${f.runId}`, `repo: ${oneLine(f.repo, 80)}`, `released_at: ${f.finishedAt ?? UNAVAILABLE}`, `result: ${verdict}`, 'tags: [release]', '---', '', `# ${title}`, '');
  out.push(`**Result:** ${verdict}.`, '');

  out.push('## Release', '');
  const tag = (name: string, now: string | null, before: string | null) => `- ${name}: ${val(now, 'not released by this run')}, before: ${val(before)}`;
  out.push(tag('Portal image', f.tags.portal, f.tags.prevPortal), tag('Workspace image', f.tags.workspace, f.tags.prevWorkspace));
  out.push(`- Commit built: ${shortSha(f.sha)}${f.ref ? ` (${oneLine(f.ref, 80)})` : ''}`, `- Release commit on main: ${val(f.releaseCommit)}`);
  out.push(`- Range from: ${f.previous ? `${shortSha(f.previous.sha)} (the release of run #${f.previous.runNumber})` : 'unavailable (no earlier release recorded)'}`);
  out.push(`- Run: #${f.runNumber} of \`${oneLine(f.pipeline, 60)}\`, started by ${val(f.actor ? oneLine(f.actor, 80) : null)}, [open in the portal](${f.runLink})`);
  out.push(`- Started ${val(f.startedAt)}, finished ${val(f.finishedAt)}, took ${secs(f.durationMs)}`, '');

  out.push('## Tickets', '');
  if ('unavailable' in f.commits) {
    out.push(`Commits in the range: unavailable (${oneLine(f.commits.unavailable, 160)}).`, '');
  } else {
    const { list, truncated } = f.commits;
    const byId = new Map(f.tickets.map((t) => [t.id, t]));
    const grouped = new Map<string, ReportCommit[]>();
    const loose: ReportCommit[] = [];
    for (const c of list) {
      if (!c.tickets.length) loose.push(c);
      for (const id of c.tickets) grouped.set(id, [...(grouped.get(id) ?? []), c]);
    }
    out.push(`${list.length} commit${list.length === 1 ? '' : 's'} in the range${truncated ? ` (the walk stopped at ${REPORT_MAX_COMMITS}: older commits are not listed)` : ''}, ${grouped.size} ticket${grouped.size === 1 ? '' : 's'}, ${loose.length} without a ticket.`, '');
    const counts = new Map<string, number>();
    for (const id of grouped.keys()) {
      const t = byId.get(id)?.type ?? UNAVAILABLE;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    if (counts.size) {
      const ordered = [...counts].sort((a, b) => (TYPE_ORDER.indexOf(a[0]) + 1 || 99) - (TYPE_ORDER.indexOf(b[0]) + 1 || 99) || a[0].localeCompare(b[0]));
      out.push(`By type: ${ordered.map(([t, n]) => `${t} ${n}`).join(', ')}.`, '');
    }
    const ids = [...grouped.keys()].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
    for (const id of ids) {
      const t = byId.get(id);
      const n = grouped.get(id)!.length;
      out.push(`- ${id} (${val(t?.type)}, now ${val(t?.status)}): ${t?.summary ? oneLine(t.summary) : UNAVAILABLE}, ${n} commit${n === 1 ? '' : 's'}`);
    }
    if (ids.length) out.push('');
    if (loose.length) {
      out.push('Commits without a ticket:', '');
      for (const c of loose) out.push(`- ${shortSha(c.sha)} ${oneLine(c.subject)}`);
      out.push('');
    }
  }

  out.push('## Changes', '');
  out.push(`- Migrations added: ${f.migrations === null ? UNAVAILABLE : f.migrations.length ? f.migrations.join(', ') : 'none'}`);
  out.push(`- Contracts changed: ${f.contractsChanged === null ? UNAVAILABLE : f.contractsChanged ? 'yes' : 'no'}`, '');

  out.push('## Pipeline', '');
  for (const j of f.jobs) out.push(`- ${oneLine(j.name, 60)}: ${j.status}, ${secs(j.durationMs)}`);
  if (!f.jobs.length) out.push(`- Jobs: ${UNAVAILABLE}`);
  const ap = f.approval;
  out.push(`- Release approval: ${ap ? `${ap.approval}${ap.by ? ` by ${oneLine(ap.by, 80)}` : ''}${ap.at ? ` at ${ap.at}` : ''}` : UNAVAILABLE}`);
  out.push(`- Rollback: ${f.rolledBack === 'yes' ? 'ran, the previous tags are back on main' : f.rolledBack === 'failed' ? 'ran and failed' : 'did not run'}`, '');
  out.push('Gate:', '');
  out.push(...(f.gate ? f.gate.map((l) => `- ${oneLine(l)}`) : [`- ${UNAVAILABLE}`]), '');
  // The whole note once more: nothing credential-shaped reaches the vault, whichever field it came in through.
  return redact(out.join('\n'));
}

/* ---------- The list ---------- */

export interface ReadmeEntry {
  /** The note's file name without `.md`. */
  name: string;
  /** When the release finished (ISO), for the order. */
  at: string;
  summary: string;
}

const ENTRY = /^- \[\[([^\]|]+)\]\] · (\S+) · (.*)$/;
const HEAD = '# Releases\n\nOne line per release, newest first. Written by the portal (T-591); do not edit by hand: a line is replaced when its run is reported again.\n\n';

/** The README with this entry in it: its line replaced when it was there, the list sorted newest first (by finish time, then name). */
export function updateReadme(existing: string | null, e: ReadmeEntry): string {
  const lines = new Map<string, { at: string; text: string }>();
  for (const l of (existing ?? '').split('\n')) {
    const m = ENTRY.exec(l);
    if (m) lines.set(m[1]!, { at: m[2]!, text: l });
  }
  lines.set(e.name, { at: e.at, text: `- [[${e.name}]] · ${e.at} · ${oneLine(e.summary, 160)}` });
  const sorted = [...lines].sort((a, b) => (a[1].at < b[1].at ? 1 : a[1].at > b[1].at ? -1 : a[0] < b[0] ? 1 : -1));
  return `${HEAD}${sorted.map(([, v]) => v.text).join('\n')}\n`;
}

/** One line for the list. */
export function readmeSummary(f: ReportFacts): string {
  const n = 'unavailable' in f.commits ? 'commits unavailable' : `${f.commits.list.length} commits`;
  const result = f.rolledBack === 'yes' ? 'rolled back' : f.rolledBack === 'failed' ? 'rollback failed' : f.status === 'passed' ? 'ok' : f.status;
  return `run #${f.runNumber}, ${n}, ${result}`;
}
