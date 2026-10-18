// The branch release report, the impure half (T-1079 S2): when the upstream sync moves the branch a remote's setting names
// (`{kind:'branch', branch, vaultId, folder}`), read the range from the remote's own mirror in the workspace (`cp-ci snapshot` and `changes`,
// read only; the upstream itself is never contacted here, and no credential is touched), build the note (`branchReport.ts`) and write it into
// the vault the REMOTE'S OWN setting names, as the portal. The first sight of a branch writes nothing (the sync's baseline, or a branch the
// sync just created). Idempotent: the note's path is a function of (module, head), so a second report of the same head replaces it.
// It never breaks the sync: the service calls `moved` without awaiting; a failure leaves an audit row with a fixed code, never a message.

import { parseTicketTrailers, type CiReleaseReportResult } from '@portal/contracts';
import { branchNoteName, branchSummary, buildBranchReport, migrationPaths, upstreamWeb, type BranchCommit, type BranchFacts } from './branchReport.js';
import type { CiReply } from './host.js';
import { NULL_SHA } from './plan.js';
import { REPORT_MAX_COMMITS, updateReadme, type ReportTicket } from './releaseReport.js';
import { parseSetting, type ReporterDeps } from './releaseReporter.js';
import type { RepoRow } from './store.js';

/** One branch the sync moved. */
export interface BranchMove {
  branch: string;
  old: string;
  new: string;
}

const SHA = /^[0-9a-f]{40}$/;
const text = (r: CiReply, key: string): string | null => (r.ok && typeof r[key] === 'string' ? (r[key] as string) : null);

export class BranchReporter {
  readonly #deps: ReporterDeps;
  readonly #busy = new Set<string>();
  readonly #now: () => Date;

  constructor(deps: ReporterDeps, now: () => Date = () => new Date()) {
    this.#deps = deps;
    this.#now = now;
  }

  /**
   * The sync moved branches of remote `repoId`. Writes the note when the setting is of kind branch, names one of them, and this is not the
   * first sight (a baseline, or old = the null sha). Returns the note written, or null when nothing qualified.
   */
  async moved(repoId: string, moves: readonly BranchMove[], baseline: boolean): Promise<CiReleaseReportResult | null> {
    const { cs, sink } = this.#deps;
    const repo = cs.repo(repoId);
    const setting = parseSetting(repo?.release_report);
    if (!repo || repo.removed_at || !setting || setting.kind !== 'branch' || baseline || !sink) return null;
    const m = moves.find((x) => x.branch === setting.branch);
    if (!m || !SHA.test(m.new) || !SHA.test(m.old) || m.old === NULL_SHA || m.old === m.new) return null;
    const key = `${repo.id}:${m.new}`;
    if (this.#busy.has(key)) return null;
    this.#busy.add(key);
    try {
      const facts = await this.#facts(repo, m);
      const name = branchNoteName(setting.folder, facts);
      const path = `${name}.md`;
      const result = sink.put(setting.vaultId, path, buildBranchReport(facts));
      const readmePath = `${setting.folder}/README.md`;
      sink.put(setting.vaultId, readmePath, updateReadme(sink.read(setting.vaultId, readmePath), { name: name.slice(setting.folder.length + 1), at: facts.headAt ?? facts.seenAt, summary: branchSummary(facts) }));
      this.#audit(repo, m, 'written', { vault: setting.vaultId, path, created: result.created, unchanged: result.unchanged });
      return { path, created: result.created, unchanged: result.unchanged };
    } catch {
      // A fixed code only: the message of a vault or runner error is not copied into an audit row.
      this.#audit(repo, m, 'failed', { vault: setting.vaultId, code: 'write_failed' });
      return null;
    } finally {
      this.#busy.delete(key);
    }
  }

  #audit(repo: RepoRow, m: BranchMove, outcome: 'written' | 'failed', detail: Record<string, unknown>): void {
    this.#deps.audit?.({ kind: 'ci.release_report', actor: 'portal', userId: null, severity: 'info', subject: `ci_repo:${repo.id}`, detail: { repo: repo.name, branch: m.branch, from: m.old, to: m.new, outcome, ...detail } });
  }

  async #facts(repo: RepoRow, m: BranchMove): Promise<BranchFacts> {
    const { cp, tickets } = this.#deps;
    const ws = repo.workspace_id;
    const head: CiReply = await cp(ws, ['snapshot', repo.name, m.new]).catch((): CiReply => ({ ok: false }));
    const commits = await this.#walk(repo, m, head);
    const diff: CiReply = await cp(ws, ['changes', repo.name, m.old, m.new]).catch((): CiReply => ({ ok: false }));
    const migrations = diff.ok && diff.truncated !== true && diff.ancestor === true && Array.isArray(diff.paths) ? migrationPaths((diff.paths as unknown[]).filter((p): p is string => typeof p === 'string')) : null;
    const ids = [...new Set('list' in commits ? commits.list.flatMap((c) => c.tickets) : [])];
    const found: ReportTicket[] = ids.map((id) => {
      const t = tickets?.info(id) ?? null;
      return { id, summary: t?.summary ?? null, type: t?.type ?? null, status: t?.status ?? null };
    });
    return {
      module: repo.name,
      branch: m.branch,
      from: m.old,
      to: m.new,
      headAt: text(head, 'at') || null,
      seenAt: this.#now().toISOString(),
      web: upstreamWeb(repo.upstream_url),
      commits,
      tickets: found,
      migrations,
    };
  }

  /** The commits the branch gained, newest first along first parents (one `snapshot` each; the head's is already read). */
  async #walk(repo: RepoRow, m: BranchMove, head: CiReply): Promise<BranchFacts['commits']> {
    const list: BranchCommit[] = [];
    let at: string | null = m.new;
    let s: CiReply | null = head;
    while (at && at !== m.old) {
      if (list.length >= REPORT_MAX_COMMITS) return { list, truncated: true };
      s ??= await this.#deps.cp(repo.workspace_id, ['snapshot', repo.name, at]).catch((): CiReply => ({ ok: false }));
      const message = text(s, 'message');
      if (message === null) return { unavailable: `commit ${at.slice(0, 7)} can not be read` };
      const author = s.ok && typeof s.author === 'object' && s.author ? (s.author as { name?: unknown }).name : null;
      list.push({
        sha: at,
        subject: (text(s, 'subject') ?? message.split('\n')[0] ?? '').slice(0, 200),
        author: typeof author === 'string' && author ? author : null,
        at: text(s, 'at') || null,
        tickets: parseTicketTrailers(message),
      });
      const parents: string[] = Array.isArray(s.parents) ? (s.parents as unknown[]).filter((p): p is string => typeof p === 'string') : [];
      at = parents[0] ?? null;
      s = null;
    }
    if (at !== m.old) return { unavailable: 'the earlier head is not on the first-parent line of the new one' };
    return { list, truncated: false };
  }
}
