// Claude Code version pinning: the pure parts (docs/prd/claude-version-pinning.md §3, §12): reading `claude doctor`, a workspace's flags, the
// canary report (installed against candidate) and the warnings. No I/O here: the service feeds these what it read, so every rule is testable.

import {
  claudeBelowMinimum,
  claudeObservedVersions,
  CLAUDE_CANARY_CHECKS,
  type ClaudeAutoUpdate,
  type ClaudeCanaryItem,
  type ClaudeCanaryReport,
  type ClaudeCanaryRun,
  type ClaudeCandidate,
  type ClaudeCanaryCheckDef,
  type ClaudeVersionFlag,
  type ClaudeVersionWarning,
  type ClaudeFeatureId,
} from '@portal/contracts';

/** What `claude doctor` says about the updater: `Auto-updates: disabled (set by env: …)` or `Auto-updates: enabled` (✅ 2.1.296). Anything else is unknown. */
export function parseDoctor(text: string): ClaudeAutoUpdate {
  const m = /^Auto-updates:\s*(.+)$/im.exec(text);
  if (!m) return 'unknown';
  const v = m[1]!.trim().toLowerCase();
  if (v.startsWith('disabled') || v.startsWith('managed by package manager')) return 'off';
  if (v.startsWith('enabled')) return 'on';
  return 'unknown';
}

/** Versions nobody has to be told are untested: the ones the lab ran on, and the ones a canary passed on. */
export function testedSet(passed: readonly string[]): Set<string> {
  return new Set([...claudeObservedVersions(), ...passed]);
}

/** What looks wrong about one workspace's Claude Code. Unknowns raise nothing: a flag is a fact, not a suspicion. */
export function flagsOf(input: { pinned: string | null; running: string | null; autoUpdate: ClaudeAutoUpdate; tested: Set<string> }): ClaudeVersionFlag[] {
  const flags: ClaudeVersionFlag[] = [];
  if (input.pinned && input.running && input.pinned !== input.running) flags.push('differs');
  if (claudeBelowMinimum(input.running).length > 0) flags.push('below-minimum');
  if (input.autoUpdate === 'on') flags.push('auto-update-on');
  if (input.running && !input.tested.has(input.running)) flags.push('untested');
  return flags;
}

/* ---------- The report ---------- */

const statusOf = (run: ClaudeCanaryRun | null, id: string) => run?.results.find((r) => r.id === id)?.status ?? null;

/** The scheduled canary's report: each check, how the installed version and the candidate did, and what the candidate breaks. */
export function buildReport(installed: ClaudeCanaryRun | null, candidate: ClaudeCanaryRun | null, candidateInfo: ClaudeCandidate, defs: readonly ClaudeCanaryCheckDef[] = CLAUDE_CANARY_CHECKS): ClaudeCanaryReport {
  const items: ClaudeCanaryItem[] = defs.map((d) => {
    const i = statusOf(installed, d.id);
    const c = statusOf(candidate, d.id);
    return { id: d.id, label: d.label, features: d.features, installed: i, candidate: c, breaks: i === 'pass' && c === 'fail' };
  });
  return {
    installed,
    candidate,
    candidateInfo,
    items,
    breaks: items.filter((i) => i.breaks).map((i) => i.id),
    comparable: !installed || !candidate || installed.suite === candidate.suite,
  };
}

/* ---------- Warnings ---------- */

const labelOf = (defs: readonly ClaudeCanaryCheckDef[], id: string) => defs.find((d) => d.id === id)?.label ?? id;
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** The warnings the canary's runs call for: the candidate breaks something the installed version passes, or the installed version fails something. */
export function canaryWarnings(report: ClaudeCanaryReport, at: string, defs: readonly ClaudeCanaryCheckDef[] = CLAUDE_CANARY_CHECKS): ClaudeVersionWarning[] {
  const out: ClaudeVersionWarning[] = [];
  const { installed, candidate } = report;
  if (installed && installed.status === 'done' && installed.fail > 0) {
    const failed = installed.results.filter((r) => r.status === 'fail').map((r) => r.id);
    out.push({
      id: `installed-fails:${installed.version}:${failed.join(',')}`,
      kind: 'installed-fails',
      severity: 'urgent',
      title: 'Canary fails',
      detail: `Claude Code ${installed.version} (installed) fails ${list(failed.map((id) => labelOf(defs, id)))}: the portal relies on ${failed.length === 1 ? 'that behaviour' : 'those behaviours'}.`,
      workspaceId: null,
      version: installed.version,
      at,
    });
  }
  if (candidate && candidate.status === 'done' && report.breaks.length > 0) {
    out.push({
      id: `candidate-breaks:${candidate.version}:${report.breaks.join(',')}`,
      kind: 'candidate-breaks',
      severity: 'attention',
      title: 'Candidate breaks',
      detail: `Claude Code ${candidate.version} (the newest) fails ${list(report.breaks.map((id) => labelOf(defs, id)))}, which the installed ${installed?.version ?? 'version'} passes. Do not upgrade to it yet.`,
      workspaceId: null,
      version: candidate.version,
      at,
    });
  }
  return out;
}

/** The warnings one workspace's version calls for. */
export function workspaceWarnings(w: { workspaceId: string; pinned: string | null; running: string | null; flags: ClaudeVersionFlag[]; featuresBelow: { label: string; needs: string; enforced: boolean }[] }, at: string): ClaudeVersionWarning[] {
  const out: ClaudeVersionWarning[] = [];
  if (w.flags.includes('below-minimum')) {
    const labels = w.featuresBelow.map((f) => `${f.label} (needs ${f.needs})`);
    out.push({
      id: `below-minimum:${w.workspaceId}:${w.running}`,
      kind: 'below-minimum',
      severity: w.featuresBelow.some((f) => f.enforced) ? 'attention' : 'info',
      title: 'Too old',
      detail: `${w.workspaceId} runs Claude Code ${w.running}, which is too old for ${list(labels)}.`,
      workspaceId: w.workspaceId,
      version: w.running,
      at,
    });
  }
  if (w.flags.includes('differs')) {
    out.push({
      id: `pin-differs:${w.workspaceId}:${w.pinned}:${w.running}`,
      kind: 'pin-differs',
      severity: 'attention',
      title: 'Not the pin',
      detail: `${w.workspaceId} is pinned to ${w.pinned} but runs ${w.running}.`,
      workspaceId: w.workspaceId,
      version: w.running,
      at,
    });
  }
  if (w.flags.includes('auto-update-on')) {
    out.push({
      id: `auto-update-on:${w.workspaceId}`,
      kind: 'auto-update-on',
      severity: 'info',
      title: 'Updater on',
      detail: `Claude Code in ${w.workspaceId} may update itself: its image does not switch the updater off. Recreate it on a pinned image to fix that.`,
      workspaceId: w.workspaceId,
      version: w.running,
      at,
    });
  }
  return out;
}

/** A canary run's verdict as the plan and the history name it. */
export function verdictOfRun(run: ClaudeCanaryRun | null): 'pass' | 'partial' | 'fail' | null {
  return run?.verdict ?? null;
}

/** Which of a run's failed check ids are not in the accepted list. */
export function unacceptedFailures(run: ClaudeCanaryRun, accepted: readonly string[] | undefined): string[] {
  const ok = new Set(accepted ?? []);
  return run.results.filter((r) => r.status === 'fail' && !ok.has(r.id)).map((r) => r.id);
}

/** The features a failed check puts at risk, for a warning's words. */
export function featuresAtRisk(run: ClaudeCanaryRun, defs: readonly ClaudeCanaryCheckDef[] = CLAUDE_CANARY_CHECKS): ClaudeFeatureId[] {
  const ids = new Set<ClaudeFeatureId>();
  for (const r of run.results) if (r.status === 'fail') for (const f of defs.find((d) => d.id === r.id)?.features ?? []) ids.add(f);
  return [...ids];
}
