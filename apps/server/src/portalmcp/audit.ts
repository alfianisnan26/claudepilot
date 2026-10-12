import type { PortalAuditOutcome, PortalAuditRow } from '@portal/contracts';
import type { Store } from '../store/store.js';

export interface AuditEntry {
  requestId: string;
  tokenId: string | null;
  tokenLabel: string | null;
  /** `session:<id>` for an agent, `portal-mcp:<token id>` otherwise. */
  actor: string | null;
  /** Unverified: what the client called itself. */
  client: string | null;
  ip: string | null;
  userAgent: string | null;
  method: string;
  tool: string | null;
  /** Already redacted and capped (`auditArgs`). */
  args: string | null;
  outcome: PortalAuditOutcome;
  errorCode: string | null;
  durationMs: number | null;
  affected: string[];
}

interface Row {
  id: number;
  at: string;
  request_id: string;
  token_id: string | null;
  token_label: string | null;
  actor: string | null;
  client: string | null;
  ip: string | null;
  method: string;
  tool: string | null;
  args: string | null;
  outcome: PortalAuditOutcome;
  error_code: string | null;
  duration_ms: number | null;
  affected: string;
}

export interface AuditFilter {
  tool?: string;
  outcome?: PortalAuditOutcome;
  tokenId?: string;
  /** Rows older than this id (the previous page's last). */
  before?: number;
  limit?: number;
  /** Rows to skip (for cursor paging in a tool). */
  offset?: number;
  /** Leave out the protocol's own requests (handshakes, listings) that went fine: tool calls and anything that failed stay. */
  callsOnly?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function view(r: Row): PortalAuditRow {
  let affected: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.affected);
    if (Array.isArray(parsed)) affected = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // an unreadable list is an empty one
  }
  return {
    id: r.id,
    at: r.at,
    requestId: r.request_id,
    tokenId: r.token_id,
    tokenLabel: r.token_label,
    actor: r.actor,
    client: r.client,
    ip: r.ip,
    method: r.method,
    tool: r.tool,
    args: r.args,
    outcome: r.outcome,
    errorCode: r.error_code,
    durationMs: r.duration_ms,
    affected,
  };
}

/**
 * The audit trail (portal-mcp PRD §17): one row per authenticated request, arguments redacted and capped;
 * requests turned away before a token was known are counted per address and minute, so a flood is one row
 * a minute rather than a table. Recording never throws: a database that can't be written costs the row,
 * and a line in the log, never the call.
 */
export class PortalAudit {
  #failed = false;
  /** Called after a row is written, for pages that show activity. */
  onChange?: () => void;

  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get #writable() {
    return this.store.writable ? this.store.db : null;
  }

  record(e: AuditEntry): void {
    try {
      this.#writable
        ?.prepare(
          `INSERT INTO pmcp_audit (at, request_id, token_id, token_label, actor, client, ip, user_agent, method, tool, args, outcome, error_code, duration_ms, affected)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.now().toISOString(),
          e.requestId,
          e.tokenId,
          e.tokenLabel,
          e.actor,
          e.client,
          e.ip,
          e.userAgent?.slice(0, 200) ?? null,
          e.method,
          e.tool,
          e.args,
          e.outcome,
          e.errorCode,
          e.durationMs,
          JSON.stringify(e.affected.slice(0, 50)),
        );
      this.onChange?.();
    } catch (err) {
      if (!this.#failed) console.error(`[portal-mcp] audit not written: ${(err as Error).message}`);
      this.#failed = true;
    }
  }

  /** A request turned away before it had a token (none, wrong, revoked, expired, rate limited, wrong Origin). */
  rejected(ip: string, reason: string): void {
    try {
      const at = this.now().toISOString();
      this.#writable
        ?.prepare(
          `INSERT INTO pmcp_auth_events (kind, ip, bucket, count, first_at, last_at, details) VALUES ('rejected', ?, ?, 1, ?, ?, ?)
           ON CONFLICT (kind, ip, bucket) WHERE kind = 'rejected' DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
        )
        .run(ip, at.slice(0, 16), at, at, JSON.stringify({ reason }));
    } catch (err) {
      if (!this.#failed) console.error(`[portal-mcp] auth event not written: ${(err as Error).message}`);
      this.#failed = true;
    }
  }

  /** A change to access: a token made or revoked, a lockdown, MCP turned on or off. */
  event(kind: string, tokenId: string | null, details: Record<string, unknown> = {}): void {
    try {
      const at = this.now().toISOString();
      this.#writable
        ?.prepare("INSERT INTO pmcp_auth_events (kind, ip, bucket, token_id, count, first_at, last_at, details) VALUES (?, '', ?, ?, 1, ?, ?, ?)")
        .run(kind, at, tokenId, at, at, JSON.stringify(details));
    } catch (err) {
      if (!this.#failed) console.error(`[portal-mcp] auth event not written: ${(err as Error).message}`);
      this.#failed = true;
    }
  }

  static #where(filter: AuditFilter): { sql: string; args: (string | number)[] } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.tool) (where.push('tool = ?'), args.push(filter.tool));
    if (filter.outcome) (where.push('outcome = ?'), args.push(filter.outcome));
    if (filter.tokenId) (where.push('token_id = ?'), args.push(filter.tokenId));
    if (filter.before) (where.push('id < ?'), args.push(filter.before));
    if (filter.callsOnly) where.push("(tool IS NOT NULL OR outcome <> 'ok')");
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
  }

  list(filter: AuditFilter = {}): PortalAuditRow[] {
    const { sql, args } = PortalAudit.#where(filter);
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 25), 1), 100);
    const offset = Math.max(Math.trunc(filter.offset ?? 0), 0);
    const rows = this.store.db?.prepare(`SELECT * FROM pmcp_audit ${sql} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`).all(...args) as unknown as Row[] | undefined;
    return (rows ?? []).map(view);
  }

  /** How many rows match (for paging). */
  count(filter: AuditFilter = {}): number {
    const { sql, args } = PortalAudit.#where(filter);
    const row = this.store.db?.prepare(`SELECT count(*) AS n FROM pmcp_audit ${sql}`).get(...args) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Requests since `since` (an ISO time), for the "calls today" figure. */
  countSince(since: string): number {
    const row = this.store.db?.prepare('SELECT count(*) AS n FROM pmcp_audit WHERE at >= ?').get(since) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Deletes rows older than the retention period; returns how many. */
  prune(retentionDays: number): number {
    const db = this.#writable;
    if (!db) return 0;
    const cutoff = new Date(this.now().getTime() - retentionDays * DAY_MS).toISOString();
    const a = db.prepare('DELETE FROM pmcp_audit WHERE at < ?').run(cutoff);
    db.prepare('DELETE FROM pmcp_auth_events WHERE last_at < ?').run(cutoff);
    return Number(a.changes);
  }
}
