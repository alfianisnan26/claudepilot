import type { BadgeTone } from '@isnanme/ui';
import type { McpCatalogEntry, McpCatalogVersion, McpDeliveryState, McpEntryKind, McpReviewState, McpVerifyResult } from '@portal/contracts';

export const KIND_LABEL: Record<McpEntryKind, string> = { npm: 'npm', pypi: 'PyPI', remote: 'Remote', command: 'Command' };

export const REVIEW: Record<McpReviewState, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  deprecated: { label: 'Deprecated', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'danger' },
};

/** A server's delivery state in one workspace (MCP set PRD §9), with its next step when there is one. */
export const DELIVERY: Record<McpDeliveryState, { label: string; tone: BadgeTone }> = {
  delivered: { label: 'Delivered', tone: 'success' },
  pending_start: { label: 'Applies after start', tone: 'neutral' },
  missing_secret: { label: 'Needs a secret', tone: 'warning' },
  uv_missing: { label: 'uv missing', tone: 'warning' },
  blocked_by_policy: { label: 'Blocked by policy', tone: 'danger' },
  unsupported: { label: 'Not delivered', tone: 'warning' },
  claude_too_old: { label: 'Claude Code too old', tone: 'warning' },
  held_tools_changed: { label: 'Tools changed', tone: 'warning' },
  revoked: { label: 'Revoked', tone: 'danger' },
  disabled: { label: 'Off', tone: 'neutral' },
};

export const VERIFY: Record<McpVerifyResult, { label: string; tone: BadgeTone }> = {
  ok: { label: 'Loaded', tone: 'success' },
  mismatch: { label: 'Mismatch', tone: 'warning' },
  not_loaded: { label: 'Not loaded', tone: 'danger' },
  not_registered: { label: 'Not verified yet', tone: 'neutral' },
  not_verified: { label: 'Not verified', tone: 'neutral' },
  failed: { label: 'Verify failed', tone: 'warning' },
};

/** The version sets should use: the newest approved one. */
export const newestApproved = (e: McpCatalogEntry): McpCatalogVersion | undefined => e.versions.find((v) => v.reviewState === 'approved');

/** "4 servers · 1 waiting for review". */
export function catalogSummary(entries: McpCatalogEntry[]): string {
  const drafts = entries.filter((e) => e.versions.some((v) => v.reviewState === 'draft')).length;
  return [`${entries.length} server${entries.length === 1 ? '' : 's'}`, drafts ? `${drafts} waiting for review` : ''].filter(Boolean).join(' · ');
}

export function authLabel(v: McpCatalogVersion | undefined): string | null {
  if (!v?.spec.url) return null;
  return v.spec.auth === 'oauth' ? 'OAuth sign-in' : v.spec.auth === 'headers' ? 'Header auth' : 'No auth';
}

/** "14:05" for "as of" lines. */
export const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
