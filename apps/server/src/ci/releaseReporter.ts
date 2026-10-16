// The release report, the impure half (T-591, D-69): when a run of a remote's release pipeline ends, read what the portal knows (the run, its
// kept logs, its deployment, the tickets) and what the remote's repository says (`cp-ci changes` and `snapshot`, read only), build the note
// (`releaseReport.ts`) and write it into the vault the REMOTE'S OWN setting names, as the portal itself (actor `system`, the vault journal keeps
// who wrote it). The vault and folder are never an argument of a call: a route or tool gives a run id and nothing else, so nothing an agent
// sends can make the portal write to another vault. Idempotent: the note's path is a function of the run, so a second report replaces it.
// It never breaks the poll: the service calls `report` without awaiting and logs a failure; a failed write leaves an audit row with a fixed code.

import { parseTicketTrailers, type CiReleaseReportResult, type CiReleaseReportSetting, type CiRunStateFile } from '@portal/contracts';
import { MIGRATIONS_FILE } from './autoApprove.js';
import type { CiReply } from './host.js';
import {
  buildReport,
  gateSummary,
  manifestTags,
  MANIFEST_FILE,
  migrationsAdded,
  notePath,
  parseReleaseLog,
  readmeSummary,
  reportDecision,
  REPORT_MAX_COMMITS,
  updateReadme,
  validFolder,
  type ReportCommit,
  type ReportFacts,
  type ReportTicket,
} from './releaseReport.js';
import type { CiStore, RunRow } from './store.js';
import type { CiTicketsPort } from './tickets.js';

/** What the reporter needs of the knowledge vault: read a note's text (null when there is none) and write one, as the portal. Nothing else. */
export interface ReleaseNoteSink {
  /** Whether the vault exists (false when it does not; any other failure is thrown). Without it a setting can not be saved. */
  exists?(vaultId: string): boolean;
  read(vaultId: string, path: string): string | null;
  put(vaultId: string, path: string, content: string): { created: boolean; unchanged: boolean };
}

export interface ReporterDeps {
  cs: CiStore;
  /** `cp-ci` in the workspace that holds the remote (reads only: `changes`, `snapshot`). */
  cp(workspaceId: string, args: string[]): Promise<CiReply>;
  tickets?: CiTicketsPort;
  sink?: ReleaseNoteSink;
  audit?: (e: { kind: string; actor: string; userId: string | null; severity?: 'info' | 'medium' | 'high'; subject?: string; detail?: Record<string, unknown> }) => void;
}

/** A refusal the caller can show: the run is not one that gets a report, or the remote has no setting. */
export class ReportRefused extends Error {}

/** The setting as stored: JSON {pipeline, vaultId, folder}, or null when it is off, missing or not valid (fail closed: off). */
export function parseSetting(raw: string | null | undefined): CiReleaseReportSetting | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CiReleaseReportSetting>;
    if (typeof v.pipeline === 'string' && v.pipeline && typeof v.vaultId === 'string' && v.vaultId && typeof v.folder === 'string' && validFolder(v.folder)) return { pipeline: v.pipeline, vaultId: v.vaultId, folder: v.folder };
  } catch {
    // fall through
  }
  return null;
}

const text = (r: CiReply, key: string): string | null => (r.ok && typeof r[key] === 'string' ? (r[key] as string) : null);

export class ReleaseReporter {
  readonly #deps: ReporterDeps;
  readonly #busy = new Set<string>();

  constructor(deps: ReporterDeps) {
    this.#deps = deps;
  }

  /**
   * A run turned terminal: the report when it qualifies, else nothing (returns why not). `manual` is the backfill: the same rules, but a run that
   * does not qualify is an error the caller sees instead of silence.
   */
  async report(runId: string, manual = false): Promise<CiReleaseReportResult | null> {
    const { cs, sink } = this.#deps;
    const run = cs.run(runId);
    const repo = run ? cs.repo(run.repo_id) : undefined;
    const setting = parseSetting(repo?.release_report);
    const refuse = (why: string): null => {
      if (manual) throw new ReportRefused(why);
      return null;
    };
    if (!run || !repo || !setting) return refuse(!setting ? 'no release report is set for this remote' : 'no such run');
    let state: CiRunStateFile | null = null;
    try {
      state = run.state ? (JSON.parse(run.state) as CiRunStateFile) : null;
    } catch {
      state = null;
    }
    const decision = reportDecision(run, state, setting);
    if (!decision.report) return refuse(decision.why);
    if (!sink) return refuse('no vault is connected');
    if (this.#busy.has(run.id)) return refuse('a report of this run is being written');
    this.#busy.add(run.id);
    try {
      const facts = await this.#facts(run, state!, decision.rolledBack);
      if (!facts) return refuse('the release job released nothing (no tag was pushed)');
      const path = notePath(setting.folder, facts);
      const result = sink.put(setting.vaultId, path, buildReport(facts));
      const readmePath = `${setting.folder}/README.md`;
      const name = path.slice(setting.folder.length + 1).replace(/\.md$/, '');
      sink.put(setting.vaultId, readmePath, updateReadme(sink.read(setting.vaultId, readmePath), { name, at: facts.finishedAt ?? new Date(0).toISOString(), summary: readmeSummary(facts) }));
      this.#audit(run, 'written', { vault: setting.vaultId, path, created: result.created, unchanged: result.unchanged, rolledBack: decision.rolledBack });
      return { path, created: result.created, unchanged: result.unchanged };
    } catch (e) {
      // A fixed code only: the message of a vault error is not copied into an audit row.
      this.#audit(run, 'failed', { vault: setting.vaultId, code: e instanceof ReportRefused ? 'refused' : 'write_failed' });
      throw e;
    } finally {
      this.#busy.delete(run.id);
    }
  }

  #audit(run: RunRow, outcome: 'written' | 'failed', detail: Record<string, unknown>): void {
    this.#deps.audit?.({ kind: 'ci.release_report', actor: 'portal', userId: null, severity: 'info', subject: `ci_run:${run.id}`, detail: { repo: run.repo, run: run.number, outcome, ...detail } });
  }

  /** The kept log of a job (its steps joined), or null when the portal has none. */
  #jobLog(run: RunRow, state: CiRunStateFile, id: string, tailBytes = 0): string | null {
    const job = state.jobs.find((j) => j.id === id);
    if (!job) return null;
    const parts = job.steps.map((s) => this.#deps.cs.log(run.id, id, s.idx)?.text).filter((t): t is string => typeof t === 'string');
    if (!parts.length) return null;
    const all = parts.join('\n');
    return tailBytes && all.length > tailBytes ? all.slice(-tailBytes) : all;
  }

  /** Null when the release job's log says it pushed nothing. */
  async #facts(run: RunRow, state: CiRunStateFile, rolledBack: ReportFacts['rolledBack']): Promise<ReportFacts | null> {
    const { cs, cp, tickets } = this.#deps;
    const released = parseReleaseLog(this.#jobLog(run, state, 'release') ?? '');
    if (!released) return null;
    const deployment = cs.deploymentsOfRun(run.id).find((d) => d.job === 'release') ?? null;
    // The release BEFORE this one (a backfill of an old run must not take a newer release as its base).
    const previous = deployment ? cs.lastReleased(run.repo_id, deployment.environment, run.id) : undefined;

    // The repository, read only: the manifest at the run's commit (the tags before), the paths and the migrations file over the range.
    const base = previous?.sha ?? run.sha;
    const ws = run.workspace_id;
    const diff = await cp(ws, ['changes', run.repo, base, run.sha, '--show', MANIFEST_FILE]).catch((): CiReply => ({ ok: false }));
    const manifest = diff.ok && typeof diff.show === 'object' && diff.show ? ((diff.show as { head?: unknown }).head ?? null) : null;
    const prev = manifestTags(typeof manifest === 'string' ? manifest : null);
    const rangeOk = !!previous && diff.ok && diff.truncated !== true && diff.ancestor === true && Array.isArray(diff.paths);
    let migrations: number[] | null = null;
    let contractsChanged: boolean | null = null;
    let commits: ReportFacts['commits'] = { unavailable: previous ? 'the range can not be read from the repository' : 'no earlier release is recorded' };
    if (rangeOk) {
      contractsChanged = (diff.paths as string[]).some((p) => p.startsWith('packages/contracts/'));
      const migs = await cp(ws, ['changes', run.repo, base, run.sha, '--show', MIGRATIONS_FILE]).catch((): CiReply => ({ ok: false }));
      const show = migs.ok && typeof migs.show === 'object' && migs.show ? (migs.show as { base?: unknown; head?: unknown; tooLarge?: unknown }) : null;
      if (show && show.tooLarge !== true) migrations = migrationsAdded(typeof show.base === 'string' ? show.base : null, typeof show.head === 'string' ? show.head : null);
      commits = await this.#walk(run, base);
    }

    const ids = [...new Set('list' in commits ? commits.list.flatMap((c) => c.tickets) : [])];
    const found: ReportTicket[] = ids.map((id) => {
      const t = tickets?.info(id) ?? null;
      return { id, summary: t?.summary ?? null, type: t?.type ?? null, status: t?.status ?? null };
    });
    const gateJob = state.jobs.find((j) => j.id === 'gate');
    return {
      repo: run.repo,
      pipeline: run.pipeline,
      runId: run.id,
      runNumber: run.number,
      runLink: `/admin/ci/runs/${encodeURIComponent(run.id)}`,
      sha: run.sha,
      ref: run.branch ?? run.tag ?? run.ref ?? null,
      status: run.status,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      durationMs: run.duration_ms,
      actor: run.actor_label ?? run.actor ?? null,
      tags: { portal: released.portal, workspace: released.workspace, prevPortal: prev.portal, prevWorkspace: prev.workspace },
      releaseCommit: released.commit,
      previous: previous ? { sha: previous.sha, runNumber: previous.run_number } : null,
      commits,
      tickets: found,
      migrations,
      contractsChanged,
      jobs: state.jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, durationMs: j.durationMs })),
      gate: gateJob?.status === 'passed' || gateJob?.status === 'failed' ? gateSummary(this.#jobLog(run, state, 'gate', 16 * 1024)) : null,
      approval: deployment ? { approval: deployment.approval, by: deployment.decided_by, at: deployment.decided_at } : null,
      rolledBack,
    };
  }

  /** The commits from the run's commit back to `base`, along first parents (one `snapshot` each), newest first. */
  async #walk(run: RunRow, base: string): Promise<ReportFacts['commits']> {
    const list: ReportCommit[] = [];
    let at: string | null = run.sha;
    while (at && at !== base) {
      if (list.length >= REPORT_MAX_COMMITS) return { list, truncated: true };
      const s: CiReply = await this.#deps.cp(run.workspace_id, ['snapshot', run.repo, at]).catch((): CiReply => ({ ok: false }));
      const message = text(s, 'message');
      if (!message) return { unavailable: `commit ${at.slice(0, 7)} can not be read` };
      list.push({ sha: at, subject: (text(s, 'subject') ?? message.split('\n')[0] ?? '').slice(0, 200), tickets: parseTicketTrailers(message) });
      const parents: string[] = Array.isArray(s.parents) ? (s.parents as unknown[]).filter((p): p is string => typeof p === 'string') : [];
      at = parents[0] ?? null;
    }
    if (at !== base) return { unavailable: 'the previous release is not on the first-parent line of this commit' };
    return { list, truncated: false };
  }
}
