// The Sessions list's order (T-100, 2026-10-13, replacing T-1's "Pinned first, Idle the default, All last"): what needs attention first.
// The chips run Needs you, In progress, Idle, Pinned, Ended, All; a chip shows only when it has sessions (Pinned and All always do, so
// both stay reachable; the chip you are on stays while you are on it); the page opens on the first chip that has sessions. In All the rows
// sit under the same headings in the same order. Pure, so the rules are tested (listOrder.test.ts).
import { KEEPGOING_PROGRAM_RE, needsYou, type ChatSession, type ListFilter } from '@portal/contracts';

export type StatusChip = Exclude<ListFilter, 'all'>;
/** The headings and chips, in the order of attention. */
export const STATUS_ORDER: readonly StatusChip[] = ['attention', 'working', 'idle', 'pinned', 'ended'];
export const STATUS_TITLE: Record<StatusChip, string> = { attention: 'Needs you', working: 'In progress', idle: 'Idle', pinned: 'Pinned', ended: 'Ended' };

export type ChipCounts = Record<ListFilter | 'archived', number>;

type Counted = Pick<ChatSession, 'state' | 'waiting' | 'endedReason' | 'pinnedAt' | 'archivedAt'>;

/** Counts for the chips over the open sessions (archived counted apart); a session counts on every chip it matches (Pinned overlaps). */
export function chipCounts(sessions: readonly Counted[]): ChipCounts {
  const open = sessions.filter((s) => !s.archivedAt);
  const c: ChipCounts = { attention: 0, working: 0, idle: 0, pinned: 0, ended: 0, all: open.length, archived: sessions.length - open.length };
  for (const s of open) {
    if (needsYou(s as ChatSession)) c.attention++;
    if (s.pinnedAt) c.pinned++;
    if (s.state === 'working' || s.state === 'starting') c.working++;
    else if (s.state === 'idle') c.idle++;
    else if (s.state === 'ended') c.ended++;
  }
  return c;
}

/** The chip the page opens on: the first one with sessions, in the order of attention; All when none has. */
export function defaultChip(counts: ChipCounts): ListFilter {
  return STATUS_ORDER.find((id) => counts[id] > 0) ?? 'all';
}

/**
 * The chips to show, in order: a status chip only when it has sessions (or is the one you are on), Pinned and All always, Archived (a list of
 * its own) before All once anything is archived or while you are in it.
 */
export function visibleChips(counts: ChipCounts, active: ListFilter | 'archived'): (ListFilter | 'archived')[] {
  const out: (ListFilter | 'archived')[] = STATUS_ORDER.filter((id) => id === 'pinned' || counts[id] > 0 || active === id);
  if (counts.archived > 0 || active === 'archived') out.push('archived');
  out.push('all');
  return out;
}

/**
 * The heading a session sits under in All: one heading each, by what matters most: Needs you, then In progress, then Pinned (a pinned session
 * that is idle or ended; a pinned one that needs you or works leads that heading instead, with its pin), then Idle, then Ended.
 */
export function statusOf(s: Counted): StatusChip {
  if (needsYou(s as ChatSession)) return 'attention';
  if (s.state === 'working' || s.state === 'starting') return 'working';
  if (s.pinnedAt) return 'pinned';
  if (s.state === 'ended') return 'ended';
  // Idle, and an interrupted session that needsYou has not taken (it always does today): calm, not finished.
  return 'idle';
}

/** `buildListView`'s `groupOf` for All: the status headings in the order of attention. */
export const statusGroup = (s: ChatSession) => {
  const id = statusOf(s);
  return { key: id, title: STATUS_TITLE[id], order: STATUS_ORDER.indexOf(id) };
};

/** Needs you never folds: what waits on you is always in sight. */
export const canFold = (groupKey: string) => groupKey !== 'attention';

/* ---------- The program filter (T-259 slice 3) ---------- */

type Programmed = Pick<ChatSession, 'keepGoing'>;
const programOf = (s: Programmed): string | null => s.keepGoing?.program ?? null;

/** The programs the chats belong to (Keep going's program, the pause switch's unit), by name, with how many chats each. */
export function programCounts(sessions: readonly Programmed[]): { program: string; count: number }[] {
  const m = new Map<string, number>();
  for (const s of sessions) {
    const p = programOf(s);
    if (p) m.set(p, (m.get(p) ?? 0) + 1);
  }
  return [...m].sort(([a], [b]) => a.localeCompare(b)).map(([program, count]) => ({ program, count }));
}

/** Only the chats of one program; null: every chat. */
export function ofProgram<T extends Programmed>(sessions: readonly T[], program: string | null): readonly T[] {
  return program ? sessions.filter((s) => programOf(s) === program) : sessions;
}

/** A program's name as typed: trimmed and lowercased; '' is none (null); undefined when it is not a valid name. */
export function programInput(raw: string): string | null | undefined {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  return KEEPGOING_PROGRAM_RE.test(v) ? v : undefined;
}
