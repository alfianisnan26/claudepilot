// Test helpers for usage spend (not used by the portal): a fresh store with the real migrations, rows seeded the way the chat controller
// writes them, and a settings reader with the registry's defaults.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SettingValue, SpendAlert } from '@portal/contracts';
import { settingDef } from '../settings/registry.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { UsageSpend, type SpendOptions } from './service.js';

/** 2026-10-12 15:00 UTC, a Monday. */
export const NOW = Date.UTC(2026, 9, 12, 15, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export interface SeedUsage {
  atMs: number;
  session: string;
  workspace?: string;
  /** '' records the request without a Claude, as before Claudes existed. */
  claude?: string;
  model?: string;
  costUsd: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  requests?: number;
  agents?: number;
  /** A side question's row (chat PRD §20); default a turn's. */
  kind?: 'turn' | 'side';
}

export async function spendHarness(opts: { now?: { t: number }; settings?: Record<string, SettingValue>; personaOf?: SpendOptions['personaOf']; personaName?: SpendOptions['personaName']; workspaceExists?: SpendOptions['workspaceExists']; visible?: SpendOptions['visible'] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ub-spend-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const clock = opts.now ?? { t: NOW };
  const values: Record<string, SettingValue> = { ...(opts.settings ?? {}) };
  const settings = { get: <T extends SettingValue>(key: string): T => (values[key] ?? settingDef(key)!.default) as T };
  let changes = 0;
  const told: SpendAlert[] = [];
  const logs: string[] = [];
  const spend = new UsageSpend({
    store,
    settings,
    now: () => clock.t,
    notify: () => void changes++,
    log: (l) => void logs.push(l),
    personaOf: opts.personaOf,
    personaName: opts.personaName,
    workspaceExists: opts.workspaceExists,
    visible: opts.visible,
  });
  spend.onAlert((a) => void told.push(a));
  const db = store.db!;

  const seed = {
    claude(id: string, workspaceId: string, name: string, directory = `claudes/${id.padEnd(16, '0').slice(0, 16)}`) {
      db.prepare('INSERT INTO workspace_claudes (id, workspace_id, name, directory, created_at) VALUES (?, ?, ?, ?, ?)').run(id, workspaceId, name, directory, new Date(NOW).toISOString());
    },
    session(id: string, s: { workspaceId?: string; claudeId?: string; parentId?: string | null; ticketId?: string | null; title?: string } = {}) {
      const at = new Date(NOW).toISOString();
      db.prepare('INSERT INTO chat_sessions (id, workspace_id, title, state, state_since, created_at, last_activity_at, claude_id, parent_id, ticket_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id,
        s.workspaceId ?? 'docker/api',
        s.title ?? id,
        'idle',
        at,
        at,
        at,
        s.claudeId ?? '',
        s.parentId ?? null,
        s.ticketId ?? null,
      );
    },
    deleteSession(id: string) {
      db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
    },
    /** One chat_usage row, as the controller's recordUsage writes it. */
    usage(u: SeedUsage) {
      db.prepare(
        `INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests, agents, duration_ms, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        new Date(u.atMs).toISOString(),
        u.atMs,
        u.session,
        u.workspace ?? 'docker/api',
        u.claude === undefined ? 'c1' : u.claude,
        u.model ?? 'claude-opus-4-5',
        u.input ?? 0,
        u.output ?? 0,
        u.cacheRead ?? 0,
        u.cacheWrite ?? 0,
        u.costUsd,
        u.requests ?? 1,
        u.agents ?? 0,
        u.kind ?? 'turn',
      );
    },
    /** A finished turn: the row is written, then the module is told, as the controller does. */
    turn(u: SeedUsage) {
      seed.usage(u);
      spend.onTurn({ sessionId: u.session, workspaceId: u.workspace ?? 'docker/api', claudeId: (u.claude === undefined ? 'c1' : u.claude) || null, atMs: u.atMs }, [{ costUsd: u.costUsd }]);
    },
  };

  const done = () => {
    try {
      store.close();
    } catch {
      // closed by the test already
    }
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, db, spend, clock, values, seed, told, logs, changes: () => changes, done, dataDir };
}
