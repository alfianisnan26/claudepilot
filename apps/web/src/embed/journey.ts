import { TICKET_PRIORITIES, type ReporterAnnotation, type ReporterCaptureMode, type TicketPriority } from '@portal/contracts';
import { TOOLS, uploadPlan, type Tool } from './annotate';

/*
 * The report journey's small rules (owner, 2026-11-01: "refine further, polish animations, ensure the UI/UX journey is clean"): what the
 * panel remembers between reports, when leaving asks first, the Esc order in the annotation editor, the upload progress line, and the
 * one-time jump into the editor after a capture. Pure, tested directly (journey.test.ts).
 */

/* ---------- remembered choices ---------- */

/** What the panel remembers per bucket (this browser only): the last capture mode, the last priority, the last annotation tool. */
export interface JourneyPrefs {
  mode: ReporterCaptureMode;
  priority: TicketPriority;
  tool: Tool;
}

/** A new capture opens the editor on Rectangle: boxing the problem is the most common first mark. */
export const DEFAULT_PREFS: JourneyPrefs = { mode: 'viewport', priority: 'normal', tool: 'rect' };

export const prefsKey = (bucket: string) => `pilot-reporter:journey:${bucket}`;

const MODES: readonly ReporterCaptureMode[] = ['viewport', 'full', 'crop'];

/**
 * The stored prefs, each field checked on its own (a broken or unknown value falls back to the default for that field only). On a touch
 * screen Whole page is not offered, so a remembered Whole page starts on Screen.
 */
export function parsePrefs(raw: string | null, coarse: boolean): JourneyPrefs {
  let v: Partial<Record<keyof JourneyPrefs, unknown>> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') v = parsed as typeof v;
  } catch {
    // a broken value is no choice
  }
  const mode = MODES.includes(v.mode as ReporterCaptureMode) ? (v.mode as ReporterCaptureMode) : DEFAULT_PREFS.mode;
  return {
    mode: coarse && mode === 'full' ? 'viewport' : mode,
    priority: (TICKET_PRIORITIES as readonly string[]).includes(v.priority as string) ? (v.priority as TicketPriority) : DEFAULT_PREFS.priority,
    tool: TOOLS.some((t) => t.tool === v.tool) ? (v.tool as Tool) : DEFAULT_PREFS.tool,
  };
}

export const withPref = <K extends keyof JourneyPrefs>(p: JourneyPrefs, key: K, value: JourneyPrefs[K]): JourneyPrefs => ({ ...p, [key]: value });

/* ---------- leaving asks first ---------- */

/**
 * Whether closing the report form throws work away, so it asks first: anything typed (a title other than the suggestion, details), a mark
 * drawn, or more than one shot. A lone fresh shot with the suggested title is one tap to take again: it goes without a question.
 */
export function hasUnsavedWork(f: { title: string; suggested: string; details: string; shots: readonly { annotations?: readonly unknown[] }[] }): boolean {
  if (f.title.trim() !== f.suggested.trim()) return true;
  if (f.details.trim()) return true;
  if (f.shots.length > 1) return true;
  return f.shots.some((s) => !!s.annotations?.length);
}

/** Whether the editor's marks differ from what it opened with (Cancel then asks before throwing them away). Ids are not compared. */
export function marksChanged(initial: readonly ReporterAnnotation[] | undefined, current: readonly ReporterAnnotation[]): boolean {
  const strip = (m: readonly ReporterAnnotation[]) => JSON.stringify(m.map((x) => ({ ...x, id: undefined })));
  return strip(initial ?? []) !== strip(current);
}

/* ---------- Esc in the annotation editor ---------- */

export type EditorEsc = 'drop-mark' | 'close-help' | 'keep' | 'deselect' | 'ask-discard' | 'close';

/**
 * What Esc does in the editor: the topmost thing only. A mark being drawn, then the shortcuts help, then an open question (Clear all or
 * Discard: answered Keep), then the selection; with nothing left the editor closes (asking first when the marks changed).
 */
export function editorEscape(s: { drawing: boolean; help: boolean; asking: boolean; selected: boolean; changed: boolean }): EditorEsc {
  if (s.drawing) return 'drop-mark';
  if (s.help) return 'close-help';
  if (s.asking) return 'keep';
  if (s.selected) return 'deselect';
  return s.changed ? 'ask-discard' : 'close';
}

/* ---------- filing progress ---------- */

/** One step per uploaded file: per shot what uploadPlan sends (one or two images) and its evidence. */
export const uploadCount = (shots: readonly Parameters<typeof uploadPlan>[0][]) => shots.reduce((n, s) => n + uploadPlan(s).length + 1, 0);

/** The button's words while a report goes: "Filing…" until the ticket exists, then "Uploading 2/5". */
export function progressText(p: { stage: 'filing' } | { stage: 'uploading'; done: number; total: number }): string {
  if (p.stage === 'filing') return 'Filing…';
  return `Uploading ${Math.min(p.done + 1, p.total)}/${p.total}`;
}

/* ---------- after a capture ---------- */

/**
 * The shot the editor opens on by itself: the newest one, once, when it has no marks yet (straight to annotate after a capture). The ids
 * already handled live outside the form, so coming back to the Report tab does not open it again.
 */
export function autoAnnotate(shots: readonly { captureId: string; annotations?: readonly unknown[] }[], seen: ReadonlySet<string>): string | null {
  const last = shots.at(-1);
  if (!last || seen.has(last.captureId) || last.annotations?.length) return null;
  return last.captureId;
}

/* ---------- list rows that just arrived ---------- */

/** At most this many new rows at once animate in; more is a new list (a filter change), which just appears. */
export const FRESH_MAX = 5;

/**
 * The rows that are new since the list was first shown (a ticket just filed, one that arrived by an event): they slide in once. Nothing on
 * the first load (`known` null), nothing on a wholesale change; rows that scroll back into a windowed list are known by then.
 */
export function freshKeys(known: ReadonlySet<string> | null, keys: readonly string[]): ReadonlySet<string> {
  if (!known) return new Set();
  const fresh = keys.filter((k) => !known.has(k));
  return fresh.length > FRESH_MAX ? new Set() : new Set(fresh);
}
