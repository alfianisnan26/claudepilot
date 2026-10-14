import { AppError } from '@isnanme/core';
import { PORTAL_TOKEN_CAP_DEFAULT, PORTAL_TOKEN_CAP_SETTING, type PortalMcpSettings, type UpdatePortalMcpSettingsRequest } from '@portal/contracts';
import { defineSetting } from '../settings/registry.js';
import type { Store } from '../store/store.js';

/** T-258: how many live admin tokens one label may have. Read on every mint (`PortalMcpModule`'s `maxActivePerLabel`, wired in index.ts). */
export const TOKEN_CAP_SETTING = defineSetting({
  key: PORTAL_TOKEN_CAP_SETTING,
  type: 'number',
  default: PORTAL_TOKEN_CAP_DEFAULT,
  scope: 'global',
  group: 'mcp',
  order: 90,
  label: 'Admin tokens per label',
  help: 'How many live admin-scope Portal MCP tokens one label may have at once. A label names one client: making a token with a label that has live tokens asks to replace them or add another, and adding stops at this number. Agents’ per-session tokens are not counted. Automation should use one short-lived token per run (1 hour) and revoke it at the end.',
  min: 1,
  max: 20,
});

interface Row {
  enabled: number;
  session_control: number;
  audit_days: number;
}

const DEFAULTS: PortalMcpSettings = { enabled: false, sessionControl: false, auditDays: 90 };
export const AUDIT_DAYS_MAX = 365;

/**
 * The Portal MCP switches (portal-mcp PRD §9): whether `/mcp` answers at all (off until an admin turns it
 * on, FR2), whether the session write tools are listed (FR15), and how long audit rows are kept. One row,
 * read on every request, so a change is effective on the next call.
 */
export class PortalMcpSettingsStore {
  /** Called after a change, for pages that show it. */
  onChange?: () => void;

  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(): PortalMcpSettings {
    try {
      const row = this.store.db?.prepare('SELECT enabled, session_control, audit_days FROM pmcp_settings WHERE id = 1').get() as Row | undefined;
      if (!row) return { ...DEFAULTS };
      return { enabled: row.enabled === 1, sessionControl: row.session_control === 1, auditDays: row.audit_days };
    } catch {
      // A database whose migration failed has no such table: MCP stays off and the portal explains itself elsewhere.
      return { ...DEFAULTS };
    }
  }

  update(req: Partial<UpdatePortalMcpSettingsRequest>): PortalMcpSettings {
    const db = this.store.writable ? this.store.db : null;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    const next = { ...this.get() };
    if (req.enabled !== undefined) {
      if (typeof req.enabled !== 'boolean') throw new AppError('VALIDATION_FAILED', '`enabled` must be true or false.', { details: { enabled: 'Use true or false.' } });
      next.enabled = req.enabled;
    }
    if (req.sessionControl !== undefined) {
      if (typeof req.sessionControl !== 'boolean') throw new AppError('VALIDATION_FAILED', '`sessionControl` must be true or false.', { details: { sessionControl: 'Use true or false.' } });
      next.sessionControl = req.sessionControl;
    }
    if (req.auditDays !== undefined) {
      if (!Number.isInteger(req.auditDays) || req.auditDays < 1 || req.auditDays > AUDIT_DAYS_MAX)
        throw new AppError('VALIDATION_FAILED', `Keep the audit trail between 1 and ${AUDIT_DAYS_MAX} days.`, { details: { auditDays: `1 to ${AUDIT_DAYS_MAX}.` } });
      next.auditDays = req.auditDays;
    }
    db.prepare('UPDATE pmcp_settings SET enabled = ?, session_control = ?, audit_days = ?, updated_at = ? WHERE id = 1').run(
      next.enabled ? 1 : 0,
      next.sessionControl ? 1 : 0,
      next.auditDays,
      this.now().toISOString(),
    );
    this.onChange?.();
    return next;
  }
}
