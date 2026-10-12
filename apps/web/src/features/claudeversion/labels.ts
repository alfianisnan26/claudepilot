import type { BadgeTone } from '@isnanme/ui';
import { CLAUDE_CANARY_CHECKS, type ClaudeCanaryStatus, type ClaudeCanaryVerdict, type ClaudeVersionFlag } from '@portal/contracts';

export const STATUS_TONE: Record<ClaudeCanaryStatus, { label: string; tone: BadgeTone }> = {
  pass: { label: 'Pass', tone: 'success' },
  fail: { label: 'Fail', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

export const VERDICT_TONE: Record<ClaudeCanaryVerdict, { label: string; tone: BadgeTone }> = {
  pass: { label: 'Pass', tone: 'success' },
  partial: { label: 'Partial', tone: 'warning' },
  fail: { label: 'Fail', tone: 'danger' },
};

/** What each flag means, for the ⓘ (one sentence). */
export const FLAG_TEXT: Record<ClaudeVersionFlag, string> = {
  differs: 'The version running is not the version the image was built with.',
  'below-minimum': 'The running version is below what a feature needs.',
  'auto-update-on': 'Claude Code in this workspace may update itself.',
  untested: 'No canary has passed on the running version.',
};

/** The check's label for an id (an area may add checks the page does not know: the id is shown then). */
export const checkLabel = (id: string) => CLAUDE_CANARY_CHECKS.find((c) => c.id === id)?.label ?? id;
export const checkWhat = (id: string) => CLAUDE_CANARY_CHECKS.find((c) => c.id === id)?.what;
