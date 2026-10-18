import { CI_BRANCH_BACKFILL_DEFAULT, CI_BRANCH_BACKFILL_MAX, type CiReleaseReportSetting } from '@portal/contracts';

// The Release report dialog's state and what it sends (T-591, T-1079 S3b). Pure, so it is tested without a browser. The server checks every
// field again; this only keeps the Save button honest and fills the defaults.

export type ReportKind = 'off' | 'pipeline' | 'branch';

export interface ReportForm {
  kind: ReportKind;
  pipeline: string;
  branch: string;
  vaultId: string;
  folder: string;
}

/** The form for a stored setting (null: off). New fields get the usual defaults: deploy, stg, Releases. */
export function formOf(s: CiReleaseReportSetting | null): ReportForm {
  const base: ReportForm = { kind: 'off', pipeline: 'deploy', branch: 'stg', vaultId: '', folder: 'Releases' };
  if (!s) return base;
  if (s.kind === 'branch') return { ...base, kind: 'branch', branch: s.branch, vaultId: s.vaultId, folder: s.folder };
  return { ...base, kind: 'pipeline', pipeline: s.pipeline, vaultId: s.vaultId, folder: s.folder };
}

/** What Save sends: null for off; only the fields of the chosen kind, trimmed. */
export function settingOf(f: ReportForm): CiReleaseReportSetting | null {
  if (f.kind === 'off') return null;
  const where = { vaultId: f.vaultId.trim(), folder: f.folder.trim() };
  return f.kind === 'branch' ? { kind: 'branch', branch: f.branch.trim(), ...where } : { pipeline: f.pipeline.trim(), ...where };
}

/** Whether Save can be pressed: off always; otherwise a vault, a folder, and the kind's own name. A branch report needs an upstream. */
export function canSave(f: ReportForm, hasUpstream: boolean): boolean {
  if (f.kind === 'off') return true;
  if (!f.vaultId.trim() || !f.folder.trim()) return false;
  return f.kind === 'branch' ? hasUpstream && !!f.branch.trim() : !!f.pipeline.trim();
}

/** The backfill count typed in, or null when it is not a whole number from 1 to the maximum. Empty: the default. */
export function backfillCount(text: string): number | null {
  const t = text.trim();
  if (!t) return CI_BRANCH_BACKFILL_DEFAULT;
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= CI_BRANCH_BACKFILL_MAX ? n : null;
}
