// Auto move: the words and numbers the page shows, as pure functions (tested under Node).
import { AUTO_BOUNDS, modelDisplayName, type AutoMode, type AutoRefusal, type AutoSessionState, type AutoSuggestion, type AutoTransferEvent, type ChatSwitchOption, type Figure } from '@portal/contracts';

export const MODE_LABEL: Record<AutoMode, string> = { off: 'Off', ask: 'Ask', auto: 'Automatic' };

/** A percent with its basis: "8 %" measured, "8 % est." estimated, "–" unavailable. */
export function pctText(f: Figure | undefined | null): string {
  if (!f || f.value === null) return '–';
  const v = Math.round(f.value * 10) / 10;
  return `${v} %${f.basis === 'estimate' ? ' est.' : ''}`;
}

/** A model family as people say it: "Sonnet". */
export const modelName = (family: string): string => (modelDisplayName(family) || family).replace(/^./, (c) => c.toUpperCase());

/** Whether the suggestion changes the model on the Claude the chat is on (no move). */
export const inPlace = (s: Pick<AutoSuggestion, 'from' | 'to'>): boolean => s.from.id === s.to.id && !!s.to.model;

/** The card's first line: "Work has 8 % left", "Work: Opus week has 8 % left" when only the model's own limit is low, or "… is used up". */
export function headline(s: Pick<AutoSuggestion, 'from' | 'reason' | 'facts'>): string {
  const limit = s.facts.limit;
  const who = limit?.kind === 'model' ? `${s.from.name}: ${limit.label} limit` : s.from.name;
  if (s.reason === 'exhausted') return `${who} is used up`;
  return `${who} has ${pctText(s.facts.leftPct)} left`;
}

/** The card's second line: "Move to Home (40 % left)", "Use Sonnet here (55 % left)", "Move to Home on Sonnet (40 % left)", or for a
 * Claude without plan limits "Move to Console". */
export function offer(s: Pick<AutoSuggestion, 'from' | 'to' | 'facts'>): string {
  const left = s.facts.destLeftPct && s.facts.destLeftPct.value !== null ? ` (${pctText(s.facts.destLeftPct)} left)` : '';
  if (inPlace(s)) return `Use ${modelName(s.to.model!)} here${left}`;
  // A move that changes the model says it before it happens (T-109): "Move to Sekar on Opus, was Fable".
  const was = s.from.model && s.from.model !== s.to.model ? `, was ${modelName(s.from.model)}` : '';
  if (s.to.model) return `Move to ${s.to.name} on ${modelName(s.to.model)}${was}${left}`;
  return `Move to ${s.to.name}${left}`;
}

/** "Drops 1 approval, 2 messages" when a move would drop anything, else null. */
export function droppedText(d: AutoSuggestion['dropped']): string | null {
  const parts: string[] = [];
  const n = (k: number, one: string, many: string) => k > 0 && parts.push(`${k} ${k === 1 ? one : many}`);
  n(d.approvals, 'approval', 'approvals');
  n(d.queued, 'message', 'messages');
  n(d.agents, 'agent', 'agents');
  return parts.length ? `Drops ${parts.join(', ')}` : null;
}

/** Why the card shows, in the ⓘ; `bypass` when the chat is in Bypass now. */
export function reasonText(s: Pick<AutoSuggestion, 'reason' | 'facts' | 'handoff'> & { to?: AutoSuggestion['to']; from?: AutoSuggestion['from'] }, bypass = false): string {
  const f = s.facts;
  const base =
    s.reason === 'exhausted'
      ? f.limit?.kind === 'model'
        ? `Its ${f.limit.label} limit, which stops only this model, is used up (measured).`
        : 'Its session or week limit is used up (measured).'
      : s.reason === 'low'
        ? f.limit?.kind === 'model'
          ? `Its ${f.limit.label} limit, which stops only this model, has ${pctText(f.leftPct)} left (measured), at or under the threshold of ${f.thresholdPct} %.`
          : `Its fullest limit has ${pctText(f.leftPct)} left (measured), at or under the threshold of ${f.thresholdPct} %.`
        : `At its current pace it runs out before it resets: ${pctText(f.projectedPct)} by the reset, out around ${f.etaAt?.value ? new Date(f.etaAt.value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'soon'} (an estimate from recent readings: used percent plus speed × time left).`;
  const here = !!s.to?.model && (s as { from?: { id: string } }).from?.id === s.to.id;
  const handoff = here
    ? ` The chat stays on this Claude and changes to ${modelName(s.to!.model!)}: the conversation stays as it is, nothing is handed off.`
    : s.handoff === 'skip'
      ? ' The stored conversation carries over; it can’t write a handoff now.'
      : ' It writes a handoff first.';
  const d = f.destLeftPct;
  const where = here ? `${modelName(s.to!.model!)} here` : s.to?.model ? `${s.to.name} on ${modelName(s.to.model)}` : s.to?.name;
  const dest = s.to && d && d.value !== null ? ` ${where} has ${pctText(d)} left (${d.basis === 'estimate' ? 'an estimate' : 'measured'}).` : '';
  // A move keeps Bypass while the policy allows it (chat-sessions §21, FR20a).
  return base + dest + handoff + (bypass && !here ? ' Bypass stays on after the move while the policy allows it.' : '');
}

/** The automatic moves of a chat in the last day, by the move's id (the "Moved to" divider's `handoffId`). */
export function autoMarks(events: AutoTransferEvent[], nowMs: number): Map<string, AutoTransferEvent> {
  const out = new Map<string, AutoTransferEvent>();
  const undone = new Set(events.filter((e) => e.kind === 'undone' && e.handoffId).map((e) => e.handoffId!));
  for (const e of events) {
    if (e.kind !== 'moved' || e.actor !== 'portal:autotransfer' || !e.handoffId) continue;
    if (nowMs - Date.parse(e.at) > 86_400_000) continue;
    if (!undone.has(e.handoffId)) out.set(e.handoffId, e);
  }
  return out;
}

/** A destination list with `id` added at the end, or taken out when it is there. */
export function toggleItem(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** The list with the item at `i` one place up (`-1`) or down (`1`); unchanged at an end. */
export function moveItem(list: string[], i: number, delta: -1 | 1): string[] {
  const j = i + delta;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** A Claude's own threshold from its field: empty follows the default (null), else a whole number within `AUTO_BOUNDS.thresholdPct`. */
export function parseThreshold(text: string): number | null | 'invalid' {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  const b = AUTO_BOUNDS.thresholdPct;
  return Number.isInteger(n) && n >= b.min && n <= b.max ? n : 'invalid';
}

/** Undo belongs to the divider of the chat's last automatic move (the server says whether it can be done now); other dividers carry the mark only. */
export function undoFor(last: AutoSessionState['lastMove'], handoffId: string): { ok: boolean; reason: string | null } | null {
  return last && last.event.handoffId === handoffId ? last.undo : null;
}

/** Why auto move does nothing for a chat now, in a few words (the session menu's dialog); null when there is nothing to say. */
export function whyText(why: AutoRefusal | null): string | null {
  switch (why) {
    case 'pooled':
      return 'Not used on an account pool';
    case 'no_plan_reading':
      return 'No plan reading for this Claude';
    case 'stale_reading':
      return 'The reading is old';
    case 'no_destination':
      return 'No Claude to move to';
    case 'destination_busy':
      return 'Every other Claude is full';
    case 'session_cap':
      return 'Moved enough today';
    case 'day_cap':
      return 'Daily limit of moves reached';
    case 'owner_denied':
      return 'Not allowed for this chat';
    case 'folder_untrusted':
      return 'The folder needs trusting again';
    case 'pace_under':
      return 'On pace to last until the reset';
    default:
      return null;
  }
}

/** The session menu's choices: Automatic only when the platform allows it (otherwise it would act as Ask). */
export function modeChoices(platform: AutoMode): Array<AutoMode | 'default'> {
  return platform === 'auto' ? ['default', 'off', 'ask', 'auto'] : ['default', 'off', 'ask'];
}

/** A clock time as the page shows it: "15:00", with the weekday when it is not today ("Tue 09:30"). */
export function clockText(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(nowMs).toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}

/**
 * The status line of a chat the engine holds (T-105): "Moving at the end of this turn" (told to finish its step), "Waiting for quota: next
 * Claude free at 15:00" (no destination; the soonest reset among the delegated Claudes), or "Waiting for quota" when no reset is known
 * (never a guessed time). Null when there is nothing to say.
 */
export function holdLine(s: Pick<AutoSessionState, 'waiting' | 'pendingMove'> | null, nowMs: number): { title: string; tip: string } | null {
  if (!s) return null;
  if (s.pendingMove) {
    return {
      title: 'Moving at the end of this turn',
      tip: `This Claude is at or under the threshold. The chat was told to finish its step and stop; when the turn ends it moves to ${s.pendingMove.to.name} and continues there by itself. Running agents stop with the old process.`,
    };
  }
  const w = s.waiting;
  if (!w) return null;
  const why =
    w.code === 'session_cap' || w.code === 'day_cap'
      ? 'The limit of automatic moves is reached.'
      : w.code === 'paused'
        ? 'Auto move is paused for this chat.'
        : w.code === 'destination_busy'
          ? 'Every other Claude already carries its most chats.'
          : 'No other Claude has more than the threshold left.';
  return {
    title: w.nextFreeAt ? `Waiting for quota: next Claude free at ${clockText(w.nextFreeAt, nowMs)}` : 'Waiting for quota',
    tip: `${why} The portal looks again every 2 minutes; as soon as a Claude has room, or this one resets, the chat moves or goes on by itself.`,
  };
}

/** The model a Claude would run the chat on when it is not the chat's own (T-109): its best one at or below it; null when the same. */
export function modelChange(o: Pick<ChatSwitchOption, 'model'>): { to: string | null; text: string } | null {
  const m = o.model;
  if (!m || m.to === m.from) return null;
  return m.to ? { to: m.to, text: `On ${modelDisplayName(m.to)}, was ${modelDisplayName(m.from)}` } : { to: null, text: `No model at or below ${modelDisplayName(m.from)}` };
}
