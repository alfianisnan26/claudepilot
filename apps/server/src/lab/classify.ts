// Efficiency lab (T-287): what may be kept of a stream line. Only ids that look like ids and classes computed here; a command, prompt or
// result is read to classify or measure it and then dropped (docs/prd/claude-usage.md §28.2).

import type { LabToolClass } from '@portal/contracts';

/** Inspection, exactly as docs/dev-sessions/overhaul/evidence/slice_metrics.py counts it (so the baseline and the lab agree). */
export const INSPECT = /^\s*(cat|ls|head|tail|grep|rg|find|wc|sed -n|awk|stat|du|diff|echo|pwd)\b/i;
/** A Bash command run through RTK (the reference script's rule): optional `NAME=value` prefixes, then `rtk`. */
export const RTK = /^\s*(?:\w+=\S+\s+)*rtk\b/;
const TICKET = /\bT-\d+\b/;

const WAIT = /^(sleep|until|while|watch|wait)\b|\bsleep \d/;
const TEST = /^(npm|npx|pnpm|yarn|node|tsx|tsc|vitest|jest|pytest|python3? -m pytest|go (test|build|vet)|cargo|make|scripts\/(gate|quiet|slice-check|gate-job|job-run|k3s-build)\S*)(?=\s|$)/;
const GIT_READ = /^git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*(status|log|diff|show|branch|fetch|rev-parse|rev-list|ls-files|ls-remote|blame|grep|remote|describe|merge-base|shortlog|cat-file|config\s+--get|worktree\s+list|stash\s+list)\b/;
const GIT_WRITE = /^git\b/;
const API = /^(curl|wget|kubectl|gh|helm|argocd|docker|psql|sqlite3|ssh|scp)\b/;
const EDIT = /^(sed\s+-i|perl\s+-[a-z]*i|tee|patch|mv|cp|rm|mkdir|touch|chmod|ln|python3?|node\s+-e|cat\s*>)/;

/** Leading `cd <dir> &&` (or `;`) and `NAME=value` prefixes say nothing about what a command does. */
function core(command: string): string {
  let s = command.trimStart();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/^rtk\s+/, '').replace(/^cd\s+\S+\s*(&&|;)\s*/, '').replace(/^(?:\w+=\S+\s+)+/, '').replace(/^(?:time|env|nice)\s+/, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

export function bashClass(command: string): LabToolClass {
  if (INSPECT.test(command)) return 'inspect';
  const s = core(command);
  if (WAIT.test(s)) return 'wait';
  if (GIT_READ.test(s)) return 'git_read';
  if (GIT_WRITE.test(s)) return 'git_write';
  if (TEST.test(s)) return 'test';
  if (API.test(s)) return 'api';
  if (EDIT.test(s)) return 'edit';
  return 'other';
}

/** The class of any tool call; Bash by its command. */
export function toolClass(name: string, input: Record<string, unknown>): LabToolClass {
  if (name === 'Bash') return bashClass(typeof input.command === 'string' ? input.command : '');
  if (name === 'Agent' || name === 'Task') return 'agent';
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(name)) return 'inspect';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'edit';
  if (/^(Monitor|TaskOutput|BashOutput|Wait)$/.test(name)) return 'wait';
  if (name.startsWith('mcp__') || name === 'WebFetch' || name === 'WebSearch') return 'api';
  return 'other';
}

/** The first `T-<n>` in an Agent call (the reference script's rule: the prompt's first 2,500 characters, then the description). */
export function ticketOf(input: Record<string, unknown>): string | null {
  const m = TICKET.exec(String(input.prompt ?? '').slice(0, 2500) + ' ' + String(input.description ?? ''));
  return m ? m[0] : null;
}

const DRAW = /\bLab-Draw: (d-[0-9a-f]{12})(?![0-9a-f])/;

/** The lab's draw key (`Lab-Draw: d-<12 hex>`, from `lab_arm_draw`) on the FIRST line of an Agent call's prompt (at most 2,500 characters); else null. */
export function drawOf(input: Record<string, unknown>): string | null {
  const m = DRAW.exec(String(input.prompt ?? '').slice(0, 2500).split('\n', 1)[0]!);
  return m ? m[1]! : null;
}

const ID = /^[A-Za-z0-9_.:@\-[\]]{1,160}$/;
const NAME = /^[A-Za-z0-9_.:-]{1,80}$/;

/** An id from the stream (message, tool_use, model) when it looks like one; anything else is not kept. */
export const safeId = (v: unknown): string | null => (typeof v === 'string' && ID.test(v) ? v : null);
/** A tool or role name when it is a plain name. */
export const safeName = (v: unknown): string | null => (typeof v === 'string' && NAME.test(v) ? v : null);

/** Characters as Python's len() counts them (code points), so result sizes match the reference script. */
export function codePoints(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n--;
        i++;
      }
    }
  }
  return n;
}
