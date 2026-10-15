import { type CiRunner, type CiRunSummary } from '@portal/contracts';

/** The server's rules for a runner (PRD §23): the same pattern as `RUNNER_LABEL`, at most 16 labels, 1 to 8 runs at once. */
export const RUNNER_LABEL = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const MAX_LABELS = 16;
export const MIN_RUNS = 1;
export const MAX_RUNS = 8;
/** Labels that mean "no runner": the server refuses them. */
const RESERVED = new Set(['self-hosted', 'workspace']);

/** The label a person typed, as the server wants it: trimmed, lowercase. */
export const normalizeLabel = (raw: string): string => raw.trim().toLowerCase();

/** Why a label can't be added to `labels`, or null when it can. */
export function labelProblem(raw: string, labels: readonly string[]): string | null {
  const l = normalizeLabel(raw);
  if (!l) return null;
  if (RESERVED.has(l)) return `“${l}” is not a label.`;
  if (!RUNNER_LABEL.test(l)) return 'Letters, digits, . _ - (up to 40).';
  if (labels.includes(l)) return 'Already added.';
  if (labels.length >= MAX_LABELS) return `At most ${MAX_LABELS} labels.`;
  return null;
}

/** Runs at once: a whole number from 1 to 8; the text is what the field holds. */
export function parseMaxRuns(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= MIN_RUNS && n <= MAX_RUNS ? n : null;
}

/** What the sheet may send, or the first thing wrong with it. */
export function runnerDraft(input: { workspaceId: string; labels: readonly string[]; maxRuns: string; note: string }):
  | { ok: true; body: { workspaceId: string; labels: string[]; maxRuns: number; note: string | null } }
  | { ok: false; field: 'workspaceId' | 'labels' | 'maxRuns'; message: string } {
  if (!input.workspaceId) return { ok: false, field: 'workspaceId', message: 'Pick a workspace.' };
  if (!input.labels.length) return { ok: false, field: 'labels', message: 'Give at least one label.' };
  const maxRuns = parseMaxRuns(input.maxRuns);
  if (maxRuns === null) return { ok: false, field: 'maxRuns', message: `${MIN_RUNS} to ${MAX_RUNS}.` };
  return { ok: true, body: { workspaceId: input.workspaceId, labels: [...input.labels], maxRuns, note: input.note.trim() || null } };
}

/** The workspace's name from its id (`<target>/<name>`). */
export const workspaceName = (id: string): string => id.slice(id.indexOf('/') + 1);

/** The runner row's state word, for the dot's text. */
export const stateWord = (r: Pick<CiRunner, 'state'>): string => r.state;

/** The marks a row shows besides its state: Disabled, Drained. */
export function runnerMarks(r: Pick<CiRunner, 'enabled' | 'drained'>): string[] {
  return [...(r.enabled ? [] : ['Disabled']), ...(r.drained ? ['Drained'] : [])];
}

/** What a run row or run page says about where it ran: the runner's name (when it is another workspace) and the runs-on labels. */
export function runnerLine(run: Pick<CiRunSummary, 'runsOn' | 'runnerWorkspaceId'>): { runner: string | null; labels: string[] } {
  return { runner: run.runnerWorkspaceId ? workspaceName(run.runnerWorkspaceId) : null, labels: run.runsOn ?? [] };
}
