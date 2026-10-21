// The flow watchdog's programs and the session walks it needs (T-1966). Pure: the chat is read through a narrow port.
//
// A program is `name|tag|group|merge gate|on` (setting `flow.programs`, programs split by ";"). Anything malformed is dropped (fail closed:
// a program that cannot be read watches nothing). Its leads are one group of `tickets.leadPeerGroups` (the owner's list of peer lead ids).

import { TICKET_TAG, type ChatSession } from '@portal/contracts';

export interface FlowProgram {
  name: string;
  tag: string;
  /** 1-based index into the peer lead groups; null: the first group whose leads hold the program's tickets. */
  group: number | null;
  /** The lead told about QA PASS tickets; null: the first lead of the group. */
  mergeGate: string | null;
  enabled: boolean;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID = /^[0-9a-f-]{8,64}$/;

export function parsePrograms(raw: unknown): FlowProgram[] {
  if (typeof raw !== 'string') return [];
  const out: FlowProgram[] = [];
  for (const part of raw.split(';')) {
    const f = part.split('|').map((x) => x.trim());
    if (f.length < 2 || f.length > 5) continue;
    const [name = '', tag = '', group = '', gate = '', on = ''] = f;
    if (!NAME.test(name) || tag.length > 30 || !TICKET_TAG.test(tag)) continue;
    if (group && !/^[1-9][0-9]?$/.test(group)) continue;
    if (gate && !ID.test(gate)) continue;
    if (on && on !== 'on' && on !== 'off') continue;
    if (out.some((p) => p.name === name)) continue;
    out.push({ name, tag, group: group ? Number(group) : null, mergeGate: gate || null, enabled: on !== 'off' });
  }
  return out;
}

/** What the walks read of the chat. `continuationOf`: the newest session that continues `id`, or null. */
export interface SessionReader {
  get(id: string): ChatSession | null;
  continuationOf(id: string): string | null;
}

const HOPS = 50;
const ended = (s: ChatSession) => s.state === 'ended' || !!s.archivedAt;

/**
 * The live session a configured id stands for now: itself while it runs, else its successor (a Move) or its continuation, followed until
 * one that has not ended. Null when the line ends in an ended session (never a message to an ended one). Bounded and cycle safe.
 */
export function liveHead(chat: SessionReader, id: string): ChatSession | null {
  const seen = new Set<string>();
  let cur = chat.get(id);
  while (cur && !seen.has(cur.id) && seen.size < HOPS) {
    if (!ended(cur)) return cur;
    seen.add(cur.id);
    const next = cur.successorId ?? chat.continuationOf(cur.id);
    cur = next ? chat.get(next) : null;
  }
  return null;
}

/**
 * Every id a lead has gone by: the configured id, the sessions it was continued or moved into (up to its live head), and what they
 * continue or took over (`continuedFrom`, `predecessorId`) back. A ticket held by any of them, or by a worker of any of them, is the lead's.
 */
export function lineage(chat: SessionReader, id: string): Set<string> {
  const out = new Set<string>([id]);
  const back = (s: ChatSession | null) => {
    let cur = s;
    for (let i = 0; cur && i < HOPS; i++) {
      const up = cur.continuedFrom ?? cur.predecessorId ?? null;
      if (!up || out.has(up)) break;
      out.add(up);
      cur = chat.get(up);
    }
  };
  let cur = chat.get(id);
  back(cur);
  for (let i = 0; cur && i < HOPS; i++) {
    const next = cur.successorId ?? chat.continuationOf(cur.id);
    if (!next || out.has(next)) break;
    out.add(next);
    cur = chat.get(next);
    back(cur);
  }
  return out;
}

/** The top of a session's `parentId` chain (the session itself when it has no lead); null when the chain cannot be followed. */
export function crewRoot(chat: Pick<SessionReader, 'get'>, id: string): string | null {
  let cur = chat.get(id);
  if (!cur) return id; // a session the portal no longer has: it stands for itself
  const seen = new Set<string>([cur.id]);
  while (cur.parentId) {
    if (seen.has(cur.parentId) || seen.size >= HOPS) return null;
    const up = chat.get(cur.parentId);
    if (!up) return cur.parentId;
    seen.add(up.id);
    cur = up;
  }
  return cur.id;
}

/** `tickets.leadPeerGroups` as the tickets module parses it: groups by ";", ids by ","; a group needs two ids. */
export { parseLeadPeerGroups } from '../tickets/authz.js';
