// UI reporter: read-only git in a checkout of a site's repo, for "is this fix deployed?" (docs/prd/ui-reporter-server.md). A checkout is a
// repository the workspace-git scan found (repos module) whose remote names the repo, in a running workspace: the bucket's default
// workspace first. Two commands only, as an argument list (no shell): `git merge-base --is-ancestor <fix> <live>` and a `git log` of the
// commits with a `Ticket: <ref>` trailer. Nothing fetches, nothing writes, no credential is read or printed. Anything that cannot be
// answered (no checkout, the workspace away, an unknown commit) is null: unknown, never guessed.

import type { RepoNode, ReposOverview, WorkspaceRepos } from '@portal/contracts';
import type { ReporterGit } from './service.js';

export interface GitExec {
  onData(cb: (b: Buffer) => void): void;
  onExit(cb: (code: number | null) => void): void;
  close(): void;
}

export interface ReporterGitDeps {
  repos: { overview(): Promise<ReposOverview>; workspace(workspaceId: string): Promise<WorkspaceRepos> };
  exec: (workspaceId: string, command: string[]) => Promise<GitExec>;
  /** The workspaces to try first (a bucket's default workspace), for a repo. */
  preferred?: (repo: string) => string[];
  timeoutMs?: number;
}

const SHA = /^[0-9a-f]{7,40}$/i;
const REF = /^(?:[A-Z]{2,6}-\d{1,9}|T-\d{1,9})$/;

/** Whether a remote URL names the repo (`group/name`, any host, with or without `.git`). */
export function remoteNames(url: string, repo: string): boolean {
  const u = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  const r = repo.toLowerCase();
  return u.endsWith(`/${r}`) || u.endsWith(`:${r}`);
}

export function workspaceGit(deps: ReporterGitDeps): ReporterGit {
  const timeout = deps.timeoutMs ?? 20_000;
  const found = new Map<string, { at: number; hit: { workspaceId: string; path: string } | null }>();

  async function checkout(repo: string): Promise<{ workspaceId: string; path: string } | null> {
    const cached = found.get(repo);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.hit;
    let hit: { workspaceId: string; path: string } | null = null;
    try {
      const ov = await deps.repos.overview();
      const running = ov.workspaces.filter((w) => w.running).map((w) => w.workspaceId);
      const order = [...new Set([...(deps.preferred?.(repo) ?? []).filter((w) => running.includes(w)), ...running])];
      for (const ws of order) {
        const wr = await deps.repos.workspace(ws).catch(() => null);
        const node = wr?.repos.find((n: RepoNode) => n.kind !== 'worktree' && n.state?.remotes.some((rm) => remoteNames(rm.url, repo)));
        if (node) {
          hit = { workspaceId: ws, path: node.path };
          break;
        }
      }
    } catch {
      hit = null;
    }
    found.set(repo, { at: Date.now(), hit });
    return hit;
  }

  async function run(workspaceId: string, args: string[]): Promise<{ code: number | null; out: string }> {
    const exec = await deps.exec(workspaceId, args);
    const chunks: Buffer[] = [];
    let size = 0;
    return await new Promise((resolve) => {
      let done = false;
      const finish = (code: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        exec.close();
        resolve({ code, out: Buffer.concat(chunks).toString('utf8') });
      };
      const timer = setTimeout(() => finish(null), timeout);
      exec.onData((b) => {
        size += b.length;
        if (size <= 256 * 1024) chunks.push(b);
      });
      exec.onExit((code) => finish(code));
    });
  }

  return {
    async isAncestor(repo, ancestor, descendant) {
      if (!SHA.test(ancestor) || !SHA.test(descendant)) return null;
      const co = await checkout(repo);
      if (!co) return null;
      const r = await run(co.workspaceId, ['git', '-C', co.path, 'merge-base', '--is-ancestor', ancestor, descendant]).catch(() => null);
      // 0: an ancestor; 1: not; anything else (128: a commit this checkout does not have) is unknown.
      return r?.code === 0 ? true : r?.code === 1 ? false : null;
    },
    async trailerCommits(repo, refs) {
      const ok = refs.filter((r) => REF.test(r));
      if (!ok.length) return [];
      const co = await checkout(repo);
      if (!co) return null;
      const pattern = `^Ticket:[[:space:]]*(${ok.join('|')})[[:space:]]*$`;
      const r = await run(co.workspaceId, ['git', '-C', co.path, 'log', '--all', '-E', '-i', `--grep=${pattern}`, '--format=%H', '-n', '50']).catch(() => null);
      if (!r || r.code !== 0) return null;
      return r.out.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l));
    },
  };
}
