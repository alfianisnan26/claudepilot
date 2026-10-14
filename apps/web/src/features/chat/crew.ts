// T-294 "Crew" (the owner, 2026-10-14: "terlihat hierarchy-nya, dan menginduk ke claude session yang mana, agar tidak bloated"): the
// sessions a session started (its workers: `parentId` set, FR51) sit under their lead in the Sessions list, and the session page links up to
// its lead and down to its workers. `buildListView` (contracts) nests a worker under a lead in the same group and marks one whose lead is
// elsewhere (`parentTitle`); this module is the web's rules on top of it: which heading a worker sits under in All, which workers stay in
// sight, their order, what a lead counts and which Claude a worker names. Pure, so the rules are tested (crew.test.ts).
//
// Chips and nesting. A chip lists the sessions that match it and nothing else, so a worker that matches while its lead does not (one waiting
// on you under an idle lead) shows at the top of the chip's list with "from <lead>", never under its lead brought in as context. Why: the
// chip's count is the rows it shows (Needs you 1 is one row), Select all takes only what matches, and the "from" link is the context, one
// tap away. A worker whose lead matches too sits under it, as everywhere else. In All (the status headings) a worker that does not need you
// sits under its lead's heading, nested under it; one that needs you keeps the Needs you heading (it never folds), with "from <lead>".
import { matchesQuery, needsYou, rollupLine, type ChatSession, type ListRow, type Rollup } from '@portal/contracts';
import { statusGroup } from './listOrder';

type Spawned = Pick<ChatSession, 'id' | 'createdAt'>;

/**
 * Spawn order: the oldest first, the id breaking a tie. A worker never moves while it works, waits or goes idle (lists hold still, QA A9);
 * a new one joins at the end.
 */
export function bySpawn(a: Spawned, b: Spawned): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Done: ended, and not for a safety or integrity stop (that one needs you, so it stays in sight). */
export const isDone = (s: ChatSession): boolean => s.state === 'ended' && !needsYou(s);

export interface Crew<T> {
  /** In sight under the lead. */
  live: T[];
  /** Folded behind one "N done" row until it is opened. */
  done: T[];
}

/** Workers under their lead: the live ones in sight, the done ones behind one "N done" row; each part in spawn order. */
export function splitCrew<T>(items: readonly T[], sessionOf: (t: T) => ChatSession): Crew<T> {
  const sorted = [...items].sort((a, b) => bySpawn(sessionOf(a), sessionOf(b)));
  return { live: sorted.filter((t) => !isDone(sessionOf(t))), done: sorted.filter((t) => isDone(sessionOf(t))) };
}

export const crewOfRows = (rows: readonly ListRow[]): Crew<ListRow> => splitCrew(rows, (r) => r.session);
export const crewOfSessions = (list: readonly ChatSession[]): Crew<ChatSession> => splitCrew(list, (s) => s);

/**
 * The Claude a worker names: its own when it differs from its lead's (the lead's row names that one), else nothing. A worker whose Claude
 * is not known names nothing; with no lead to compare, it names its own.
 */
export function otherClaude(worker: Pick<ChatSession, 'claudeName'>, lead: Pick<ChatSession, 'claudeName'> | null | undefined): string | null {
  return worker.claudeName && worker.claudeName !== (lead?.claudeName ?? null) ? worker.claudeName : null;
}

export interface CrewCount {
  /** Everything it started, however deep (filters do not change it). */
  total: number;
  /** Warning while one of them needs you (waiting or interrupted). */
  tone: 'warning' | 'neutral';
  /** The words for a screen reader and the tip: "3 started · 1 needs you · 2 working". */
  label: string;
}

/** A lead's count of its crew, an icon and a number on its row; null when it started nothing. */
export function crewCount(r: Rollup | null): CrewCount | null {
  const label = rollupLine(r);
  if (!r || !label) return null;
  return { total: r.total, tone: r.waiting > 0 || r.interrupted > 0 ? 'warning' : 'neutral', label };
}

/** A worker shown away from its lead (another heading, a chip its lead does not match, its lead archived): the lead to link to as "from …". */
export function fromLead(row: Pick<ListRow, 'session' | 'parentTitle'>): { id: string; title: string } | null {
  return row.parentTitle && row.session.parentId ? { id: row.session.parentId, title: row.parentTitle } : null;
}

/**
 * All's status headings with the crew kept together: a worker that does not need you sits under the heading of its lead (the top of a calm
 * chain), so it nests under it; a worker that needs you, and one whose lead is not in the list (archived, or not matching the search), keeps
 * its own heading. The chips' counts (`chipCounts`) are by each session's own state and do not change; a heading counts what sits under it.
 */
export function crewStatusGroup(all: readonly ChatSession[], query = ''): (s: ChatSession) => ReturnType<typeof statusGroup> {
  const byId = new Map(all.map((s) => [s.id, s]));
  const inList = (s: ChatSession) => !s.archivedAt && matchesQuery(s, query);
  const anchor = (s: ChatSession): ChatSession => {
    let cur = s;
    const seen = new Set([s.id]);
    while (cur.parentId && !needsYou(cur)) {
      const lead = byId.get(cur.parentId);
      if (!lead || seen.has(lead.id) || !inList(lead)) break;
      seen.add(lead.id);
      cur = lead;
    }
    return cur;
  };
  return (s) => statusGroup(anchor(s));
}
