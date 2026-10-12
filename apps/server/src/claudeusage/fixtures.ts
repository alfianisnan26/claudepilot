// Test helpers for Claude usage (not used by the portal): replies and events as the real Claude Code 2.1.296 produced them
// (against a local stand-in for api.anthropic.com and a fake credentials file in a scratch directory, no real account),
// a scripted `exec`, and a harness with a fresh store around the service.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { ClaudeUsageMonitor, type SourceClaude, type UsageOptions, type UsageSource } from './service.js';
import type { ProbeResult } from './probe.js';

/** 2026-10-12 01:00 UTC: before the reset times below. */
export const NOW = Date.UTC(2026, 9, 12, 1, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;

const SESSION = { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 309, total_lines_added: 0, total_lines_removed: 0, model_usage: {} };

/** A fake claude.ai (Max) login, the endpoint's body passed through: the named windows and extra usage. Observed. */
export const REPLY_PLAN = {
  session: SESSION,
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 41, resets_at: '2026-10-12T05:00:00.000000+00:00' },
    seven_day: { utilization: 63, resets_at: '2026-10-15T09:00:00.000000+00:00' },
    seven_day_oauth_apps: null,
    seven_day_opus: { utilization: 12.5, resets_at: '2026-10-15T09:00:00.000000+00:00' },
    seven_day_sonnet: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  },
  behaviors: null,
};

/** The same with the server's own `limits[]` rows (and extra usage on) passed through. Observed. */
export const REPLY_PLAN_ROWS = {
  session: SESSION,
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 41, resets_at: '2026-10-12T05:00:00.000000+00:00' },
    seven_day: { utilization: 63, resets_at: '2026-10-15T09:00:00.000000+00:00' },
    seven_day_oauth_apps: null,
    seven_day_opus: { utilization: 12.5, resets_at: '2026-10-15T09:00:00.000000+00:00' },
    seven_day_sonnet: { utilization: 3, resets_at: '2026-10-15T09:00:00.000000+00:00' },
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25, currency: 'USD' },
    limits: [
      { kind: 'session', group: 'session', percent: 41, resets_at: '2026-10-12T05:00:00.000Z', scope: null, severity: 'normal', is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 63, resets_at: '2026-10-15T09:00:00.000Z', scope: null, severity: 'normal', is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 12.5, resets_at: '2026-10-15T09:00:00.000Z', scope: { model: { display_name: 'Opus' } }, severity: 'normal', is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 88, resets_at: '2026-10-15T09:00:00.000Z', scope: { model: { display_name: 'Fable' } }, severity: 'warning', is_active: false },
    ],
  },
  behaviors: null,
};

/** No login, an API key or a pool: no plan limits. Observed (and in the chat tests). */
export const REPLY_NO_LIMITS = { session: SESSION, subscription_type: null, rate_limits_available: false, rate_limits: null, behaviors: null };

/** A plan whose usage Claude Code could not fetch (429, no copy of its own). Observed. */
export const REPLY_UNAVAILABLE = { session: SESSION, subscription_type: 'max', rate_limits_available: true, rate_limits: null, behaviors: null };

/** `rate_limit_info` of an `allowed_warning` event, utilization as a fraction, times in Unix seconds. Observed. */
export const INFO_WARNING = {
  status: 'allowed_warning',
  resetsAt: 1791772512,
  rateLimitType: 'five_hour',
  utilization: 0.82,
  overageStatus: 'rejected',
  overageDisabledReason: 'out_of_credits',
  isUsingOverage: false,
  surpassedThreshold: 0.75,
  unifiedWindows: { five_hour: { utilization: 0.82, resetsAt: 1791772512 }, seven_day: { utilization: 0.63, resetsAt: 1791965312 } },
};

/** The refused turn's event (a 429 with a rejected unified status). Observed. */
export const INFO_REJECTED = {
  status: 'rejected',
  resetsAt: 1791768941,
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  overageDisabledReason: 'out_of_credits',
  isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1791768941 }, seven_day: { utilization: 0.71, resetsAt: 1791965341 } },
};

/** `claude auth status --json` of a plan login: it names the account, which no code here may keep. */
export const AUTH_PLAN = `{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "analyticsDisabled": false,
  "projectsDirectory": "/home/node/.claude/projects",
  "configDirectory": "/home/node/.claude",
  "email": "someone-canary@example.invalid",
  "orgId": "00000000-0000-4000-8000-0000canaryorg",
  "orgName": "Canary Org",
  "subscriptionType": "max"
}`;
export const AUTH_OUT = `{ "loggedIn": false, "authMethod": "none", "apiProvider": "firstParty", "analyticsDisabled": false }`;
export const AUTH_KEY = `{ "loggedIn": true, "authMethod": "api_key", "apiProvider": "firstParty", "apiKeySource": "ANTHROPIC_API_KEY" }`;

/** One line of Claude Code's stream: the reply to a control request. */
export const controlReply = (requestId: string, response: unknown) => `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`;

/** A command running in a workspace, scripted: `react` sees each line written to it. */
export class ScriptedExec implements ExecSession {
  readonly written: string[] = [];
  closed = false;
  #data: ((d: Buffer) => void)[] = [];
  #exit: ((c: number | null) => void)[] = [];

  constructor(private readonly react: (self: ScriptedExec, line: string) => void = () => {}) {}

  write(data: string): void {
    this.written.push(data);
    queueMicrotask(() => this.react(this, data));
  }
  close(): void {
    this.closed = true;
  }
  onData(fn: (d: Buffer) => void): void {
    this.#data.push(fn);
  }
  onExit(fn: (c: number | null) => void): void {
    this.#exit.push(fn);
  }
  emit(text: string): void {
    for (const fn of this.#data) fn(Buffer.from(text));
  }
  end(code: number | null): void {
    for (const fn of this.#exit) fn(code);
  }
}

/** The request id of the control request written to a probe. */
export const requestId = (line: string): string => (JSON.parse(line) as { request_id: string }).request_id;

export const claude = (over: Partial<SourceClaude> = {}): SourceClaude => ({
  id: 'c1',
  name: 'Default',
  directory: '',
  workspaceId: 'docker/ws1',
  workspaceName: 'ws1',
  target: 'docker',
  running: true,
  ...over,
});

/** The rest of the portal as the service sees it, in memory. */
export class FakeSource implements UsageSource {
  list: SourceClaude[] = [claude()];
  pools = new Set<string>();
  execs: { target: string; name: string; command: string[] }[] = [];
  /** What `exec` starts; set per test. */
  spawn: (command: string[]) => ScriptedExec = () => new ScriptedExec();
  /** Sessions: id → the workspace and Claude they run in. */
  sessions = new Map<string, { workspaceId: string; claudeId: string }>();
  listCalls = 0;

  async claudes() {
    this.listCalls++;
    return this.list;
  }
  pooled(workspaceId: string) {
    return this.pools.has(workspaceId);
  }
  async exec(target: string, name: string, command: string[]) {
    this.execs.push({ target, name, command });
    return this.spawn(command);
  }
  sessionClaude(sessionId: string, claudeId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const c = this.list.find((x) => x.id === (claudeId || s.claudeId));
    return c ? { workspaceId: s.workspaceId, claudeId: c.id, name: c.name, workspaceName: c.workspaceName } : null;
  }
}

/** A probe result for a plan with these windows. */
export const planResult = (windows: ProbeResult['windows'], over: Partial<ProbeResult> = {}): ProbeResult => ({ runsOn: 'plan', plan: 'max', windows, extra: null, problem: null, failed: false, ...over });

export const win = (key: string, usedPct: number | null, resetsAtMs: number | null, label = key): ProbeResult['windows'][number] => ({ key, label, usedPct, resetsAtMs });

export async function usageHarness(opts: { now?: { t: number }; probe?: UsageOptions['probe']; settings?: UsageOptions['settings']; canUseClaude?: UsageOptions['canUseClaude']; log?: (line: string) => void } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-usage-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const source = new FakeSource();
  const clock = opts.now ?? { t: NOW };
  let changes = 0;
  const usage = new ClaudeUsageMonitor({ store, source, now: () => clock.t, notify: () => void changes++, log: opts.log ?? (() => {}), probe: opts.probe, settings: opts.settings, canUseClaude: opts.canUseClaude });
  const done = () => {
    usage.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, source, usage, clock, done, changes: () => changes };
}

/** One row of `chat_usage` (one model's share of a finished request), for a test: times in ms, unnamed numbers zero, one request. */
export interface UsageSeed {
  at: number;
  ws?: string;
  /** null or '' is a request recorded without a Claude (Default, or before Claudes). */
  claude?: string | null;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  requests?: number;
  agents?: number;
  duration?: number;
}

export function seedUsage(store: Store, rows: UsageSeed[]): void {
  const insert = store.db!.prepare(
    `INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests, agents, duration_ms)
     VALUES (?, ?, 's', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(new Date(r.at).toISOString(), r.at, r.ws ?? 'docker/ws1', r.claude ?? null, r.model ?? 'claude-opus-4-5', r.input ?? 0, r.output ?? 0, r.cacheRead ?? 0, r.cacheWrite ?? 0, r.cost ?? 0, r.requests ?? 1, r.agents ?? 0, r.duration ?? 0);
  }
}

/** A Claude of a workspace as the chat module keeps it (`workspace_claudes`): '' is Default. */
export function seedClaude(store: Store, id: string, ws: string, name: string, directory = '', removed = false): void {
  store.db!.prepare('INSERT INTO workspace_claudes (id, workspace_id, name, directory, removed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, ws, name, directory, removed ? '2026-01-01T00:00:00.000Z' : null, '2026-01-01T00:00:00.000Z');
}
