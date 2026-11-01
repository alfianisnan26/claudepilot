// Relocation: a session that is not running moves to another workspace and a Claude there (owner request 2026-11-01: decommissioning the
// old shared workspaces after the per-org migration). The chat keeps its id, its row and its portal transcript; what POINTS at where it
// lives now is rewritten, what RECORDS where it ran is left as history. Pure SQL and path helpers; the controller decides who and when.
//
// Rewritten (the session's current place):
//   chat_sessions          workspace_id (stored form), claude_id, cwd and worktree_path (cwdMap)
//   chat_segments          the run going now (ended_at IS NULL): claude_id and cwd; closed runs stay as they ran
//   chat_worktrees         the live record of this session's worktree: workspace_id and path (cwdMap)
//   pmcp_agent_tokens      a live portal-tool token of the session (bound to the old workspace): REVOKED, never moved; a new one is
//                          minted at the next start on the new workspace
//   pmcp_tokens            the same for a token reserved for this session
//   autotransfer_sessions  last_claude_id (the Claude auto move last saw) becomes the new Claude
//   autotransfer_suggestions an open suggestion (a move to a Claude of the OLD workspace) is closed `superseded`
// Left as history (they record what happened where): chat_usage, usage_sessions (it follows the next request by itself), usage_spikes,
// chat_audit, autotransfer_events, chat_btw, repo_events, persona_proposals, ci_runs, closed chat_segments, claude_handoffs. Rows keyed
// only by the session id (events, inputs, requests, tasks, files, uploads, aliases, keep going, notifications, grants, shares, crew
// cursors, lab) follow it without a change. A ticket's workspace is the ticket's own, not the session's: tickets are not touched.

import { posix } from 'node:path';
import { AppError } from '@isnanme/core';
import { CHAT_RELOCATE_CWD_MAP_MAX, type ChatCwdMap, type ChatRelocationCopy, type ChatRelocationCounts } from '@portal/contracts';
import type { StatementSync } from 'node:sqlite';
import { HOME } from '../workspaces/runtime.js';

/** What the SQL needs: prepared statements (the chat store's cache or the database itself). */
export interface RelocateDb {
  prepare(sql: string): StatementSync;
}

export interface RelocateMove {
  sessionId: string;
  /** The Claude Code session id the chat runs under (its tokens and host folder are named by it). */
  claudeSessionId: string;
  /** What chat_sessions.workspace_id will hold (the stable id when the registry knows the workspace). */
  toStored: string;
  /** The `<target>/<name>` key the portal's other tables speak (chat_worktrees). */
  toKey: string;
  toClaudeId: string;
  toCwd: string;
  toWorktreePath: string | null;
}

const PATH_MAX = 4096;

/** A `cwdMap` checked: absolute, normalized paths without `..`, at most {@link CHAT_RELOCATE_CWD_MAP_MAX} of them. */
export function checkCwdMap(raw: unknown): ChatCwdMap | undefined {
  if (raw === undefined || raw === null) return undefined;
  const bad = (why: string) => new AppError('VALIDATION_FAILED', why, { details: { cwdMap: why } });
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('cwdMap maps a folder prefix to another: { "/home/node/a": "/home/node/b" }.');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > CHAT_RELOCATE_CWD_MAP_MAX) throw bad(`At most ${CHAT_RELOCATE_CWD_MAP_MAX} prefixes.`);
  const out: ChatCwdMap = {};
  for (const [from, to] of entries) {
    for (const p of [from, to]) {
      if (typeof p !== 'string' || !p.startsWith('/') || p.length > PATH_MAX || /[\0\r\n]/.test(p) || p.split('/').includes('..'))
        throw bad('Each prefix is an absolute folder without "..".');
    }
    out[trimSlash(from)] = trimSlash(to as string);
  }
  return out;
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p);

/** `path` with its longest matching prefix of `map` rewritten (whole segments only: `/a/b` maps `/a/b/c`, never `/a/bc`). */
export function mapPath(path: string, map: ChatCwdMap | undefined): string {
  if (!map || !path) return path;
  let best: string | null = null;
  for (const from of Object.keys(map)) {
    const hit = path === from || path.startsWith(from === '/' ? '/' : `${from}/`);
    if (hit && (best === null || from.length > best.length)) best = from;
  }
  if (best === null) return path;
  const rest = path.slice(best === '/' ? 1 : best.length).replace(/^\//, '');
  return rest ? posix.join(map[best]!, rest) : map[best]!;
}

/**
 * Claude Code's project folder name for a working directory: every character that is not a letter or a digit becomes `-`
 * (`/home/node/work/x` is `-home-node-work-x`). Claude Code shortens names past 200 characters with a hash of its own; such a folder is
 * found by listing `projects/` on the old workspace.
 */
export const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/** The config directory of a Claude (its `CLAUDE_CONFIG_DIR`): Default (no directory) is Claude Code's own `~/.claude`. */
export const claudeConfigDir = (directory: string | null | undefined): string =>
  directory && /^claudes\/[a-f0-9]{16}$/.test(directory) ? `${HOME}/.claudepilot/${directory}` : `${HOME}/.claude`;

/**
 * The copies the ops step makes so the session resumes on the new workspace. Only the Claude Code transcript is required: the next start
 * is `--resume <csid>` on a fresh log segment, and the portal's own transcript is in its database. The rest keeps old links working.
 */
export function relocationCopies(o: {
  sessionId: string;
  claudeSessionId: string;
  fromConfigDir: string;
  toConfigDir: string;
  /** The folder Claude Code ran in (the session's cwd, resolved under HOME) before and after. */
  fromCwd: string;
  toCwd: string;
}): ChatRelocationCopy[] {
  const fromProject = `${o.fromConfigDir}/projects/${claudeProjectSlug(o.fromCwd)}`;
  const toProject = `${o.toConfigDir}/projects/${claudeProjectSlug(o.toCwd)}`;
  return [
    {
      from: `${fromProject}/${o.claudeSessionId}.jsonl`,
      to: `${toProject}/${o.claudeSessionId}.jsonl`,
      required: true,
      dir: false,
      why: 'Claude Code’s conversation: `--resume` reads it from the Claude’s config directory, under the folder it runs in.',
    },
    {
      from: `${fromProject}/${o.claudeSessionId}`,
      to: `${toProject}/${o.claudeSessionId}`,
      required: false,
      dir: true,
      why: 'Claude Code’s side files of that conversation (sub-agent transcripts, large tool results), when present.',
    },
    {
      from: `${HOME}/.claudepilot/sessions/${o.claudeSessionId}`,
      to: `${HOME}/.claudepilot/sessions/${o.claudeSessionId}`,
      required: false,
      dir: true,
      why: 'The session host’s folder (old log segments, staged inputs): the portal already has the transcript; the next start opens a new segment.',
    },
    {
      from: `${HOME}/.claudepilot/uploads/${o.sessionId}`,
      to: `${HOME}/.claudepilot/uploads/${o.sessionId}`,
      required: false,
      dir: true,
      why: 'Attachments sent in the chat: the conversation names them by these paths.',
    },
  ];
}

/** True while something of the session still runs outside its process: a side question. */
export function hasRunningSideQuestion(db: RelocateDb, sessionId: string): boolean {
  return !!db.prepare("SELECT 1 AS x FROM chat_btw WHERE session_id = ? AND status = 'running' LIMIT 1").get(sessionId);
}

/**
 * Applies one move. Call it inside a transaction (the store's savepoint): a conflict throws and nothing of it stays. Returns the rows it
 * changed by kind.
 */
export function applyRelocation(db: RelocateDb, m: RelocateMove, cwdMap: ChatCwdMap | undefined, now: string): ChatRelocationCounts {
  const counts: ChatRelocationCounts = { session: 0, openRun: 0, worktrees: 0, tokensRevoked: 0, autotransfer: 0 };
  counts.session = Number(
    db
      .prepare('UPDATE chat_sessions SET workspace_id = ?, claude_id = ?, cwd = ?, worktree_path = ? WHERE id = ?')
      .run(m.toStored, m.toClaudeId, m.toCwd, m.toWorktreePath, m.sessionId).changes,
  );
  counts.openRun = Number(
    db.prepare('UPDATE chat_segments SET claude_id = ?, cwd = ? WHERE session_id = ? AND ended_at IS NULL').run(m.toClaudeId, m.toCwd, m.sessionId).changes,
  );
  const worktrees = db
    .prepare('SELECT workspace_id AS w, path FROM chat_worktrees WHERE session_id = ? AND removed_at IS NULL')
    .all(m.sessionId) as { w: string; path: string }[];
  for (const wt of worktrees) {
    const path = mapPath(wt.path, cwdMap);
    if (wt.w === m.toKey && path === wt.path) continue;
    const taken = db.prepare('SELECT session_id AS s FROM chat_worktrees WHERE workspace_id = ? AND path = ?').get(m.toKey, path) as
      | { s: string | null }
      | undefined;
    if (taken) throw new AppError('CONFLICT', `The new workspace already has a worktree record at ${path}.`, { details: { reason: 'worktree' } });
    counts.worktrees += Number(
      db.prepare('UPDATE chat_worktrees SET workspace_id = ?, path = ? WHERE workspace_id = ? AND path = ?').run(m.toKey, path, wt.w, wt.path).changes,
    );
  }
  for (const id of new Set([m.sessionId, m.claudeSessionId])) {
    counts.tokensRevoked += Number(
      db
        .prepare("UPDATE pmcp_agent_tokens SET revoked_at = ?, revoked_reason = 'session relocated' WHERE session_id = ? AND revoked_at IS NULL")
        .run(now, id).changes,
    );
    counts.tokensRevoked += Number(
      db.prepare("UPDATE pmcp_tokens SET revoked_at = ?, revoked_reason = 'session relocated' WHERE session_id = ? AND revoked_at IS NULL").run(now, id).changes,
    );
  }
  counts.autotransfer += Number(
    db
      .prepare('UPDATE autotransfer_sessions SET last_claude_id = ? WHERE session_id = ? AND last_claude_id IS NOT NULL AND last_claude_id != ?')
      .run(m.toClaudeId, m.sessionId, m.toClaudeId).changes,
  );
  counts.autotransfer += Number(
    db
      .prepare("UPDATE autotransfer_suggestions SET state = 'superseded', resolved_at = ? WHERE session_id = ? AND state = 'open'")
      .run(now, m.sessionId).changes,
  );
  return counts;
}
