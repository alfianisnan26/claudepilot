import type { BadgeTone } from '@isnanme/ui';
import type { PoolSummary, SkillFindingTier, SkillReviewState, SkillRisk, SkillsetContentView, SkillsetMode, SkillSourceKind, SkillVerifyStatus } from '@portal/contracts';

export const REVIEW: Record<SkillReviewState, { label: string; tone: BadgeTone }> = {
  needs_review: { label: 'Needs review', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'danger' },
};

export const RISK: Record<SkillRisk, { label: string; tone: BadgeTone }> = {
  low: { label: 'Low risk', tone: 'neutral' },
  medium: { label: 'Medium risk', tone: 'warning' },
  high: { label: 'High risk', tone: 'danger' },
};

export const TIER: Record<SkillFindingTier, { label: string; tone: BadgeTone }> = {
  high: { label: 'High', tone: 'danger' },
  medium: { label: 'Medium', tone: 'warning' },
  low: { label: 'Low', tone: 'neutral' },
};

export const SOURCE_KIND: Record<SkillSourceKind, string> = { upload: 'Upload', git: 'Git', anthropic: 'Anthropic', marketplace: 'Marketplace' };

/** FR13: On as authored, Manual only when typed, Off not delivered. */
export const MODE: { value: SkillsetMode; label: string }[] = [
  { value: 'on', label: 'On' },
  { value: 'manual', label: 'Manual (/name only)' },
  { value: 'off', label: 'Off' },
];

/** FR21's results as the Skills row names them. */
export const VERIFY: Record<SkillVerifyStatus, { label: string; tone: BadgeTone }> = {
  verified: { label: 'Verified', tone: 'success' },
  mismatch: { label: 'Mismatch', tone: 'warning' },
  error: { label: 'Load error', tone: 'danger' },
  not_verified: { label: 'Not verified', tone: 'neutral' },
  pending: { label: 'Pending', tone: 'neutral' },
};

/** Code reads in a code font; the tokens' `font-mono` is the UI font. */
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

/** A skillset's content, or an empty one when the summary has none yet. */
export const setContent = (p: PoolSummary): SkillsetContentView => (p.content as SkillsetContentView | null) ?? { prefix: '', skills: [] };

/** "/frontend: · 12 skills · 3 scripted" on a set's card (PRD §13). */
export function setSummary(p: PoolSummary): string {
  const c = setContent(p);
  if (c.skills.length === 0) return c.prefix ? `/${c.prefix}: · No skills yet` : 'No skills yet';
  const on = c.skills.filter((s) => s.mode !== 'off');
  const scripted = on.filter((s) => s.scripted).length;
  const off = c.skills.length - on.length;
  return [c.prefix && `/${c.prefix}:`, n(on.length, 'skill'), scripted && `${scripted} scripted`, off && `${off} off`].filter(Boolean).join(' · ');
}

/** "4,210" for characters in the listing. */
export const chars = (count: number) => count.toLocaleString('en');

/** "412 B", "3 KB": a skill is mostly small files, which `formatBytes` would round to 0 KB. */
export const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A short hash for rows: the first 7 characters of a tree hash. */
export const shortHash = (hash: string) => hash.slice(0, 7);
