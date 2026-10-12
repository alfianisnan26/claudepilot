// The one in-process event bus of the platform track (docs/prd/web-app-pwa.md §11, work breakdown section 1). Adapters over the
// existing seams emit; the delivery pipeline, triggers and auto transfer listen. `emit` validates, assigns the id and time, fans out and
// never throws; a listener that throws is logged and skipped.
//
// What may be in an event is narrow on purpose: `facts` are short single-line strings, numbers, booleans and null (names, enums,
// counts). Free text from an agent, a workspace or a webhook never goes in `facts`: it goes in `detail`, redacted and clipped, and only
// reaches a destination that asked for it (`includeDetail`).

import { randomBytes } from 'node:crypto';
import { NOTIFY_KINDS, notifyToolClass, type NotifyAnswerOffer, type NotifyEvent, type NotifyKind, type NotifySubject } from '@portal/contracts';
import { redact } from '../chat/redact.js';

export type NotifyEmit = Omit<NotifyEvent, 'id' | 'at'> & { at?: string };

export interface NotifyBus {
  /** Validates (facts: short strings, numbers, booleans; detail clipped), assigns id and time, fans out, never throws; null when dropped. */
  emit(e: NotifyEmit): NotifyEvent | null;
  /** A listener that throws is logged and skipped. Returns the unsubscribe. */
  on(kind: NotifyKind | '*', fn: (e: NotifyEvent) => void): () => void;
}

const SUBJECT_TYPES = new Set<NotifySubject['type']>(['session', 'ticket', 'ci_run', 'claude', 'workspace', 'trigger', 'trigger_run', 'budget', 'portal']);
const FACT_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const USER = /^u_[a-z0-9]{1,40}$/;
/** Characters that can hide or reorder text: controls, zero-width, bidi overrides. */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
export const FACT_MAX = 80;
export const DETAIL_MAX = 600;

/** A fact string: one line, no hidden character, clipped. */
export function cleanFact(v: string): string {
  const s = v.replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
  return s.length > FACT_MAX ? `${s.slice(0, FACT_MAX - 1)}…` : s;
}

/** Untrusted text for `detail`: redacted, hidden characters shown as spaces, clipped at `max`. */
export function cleanDetail(text: string, max = DETAIL_MAX): { text: string; truncated: boolean } {
  const s = redact(text).replace(HIDDEN, ' ').replace(/[ \t]+/g, ' ').trim();
  return s.length > max ? { text: `${s.slice(0, max - 1)}…`, truncated: true } : { text: s, truncated: false };
}

function validOffer(a: NotifyAnswerOffer | undefined): NotifyAnswerOffer | undefined {
  if (!a || typeof a !== 'object') return undefined;
  if (typeof a.sessionId !== 'string' || !ID.test(a.sessionId) || typeof a.requestId !== 'string' || !ID.test(a.requestId)) return undefined;
  const decisions = Array.isArray(a.decisions) ? [...new Set(a.decisions.filter((d) => d === 'allow' || d === 'deny'))] : [];
  if (decisions.length === 0) return undefined;
  const toolClass = (['read', 'edit', 'command', 'other'] as const).find((c) => c === a.toolClass) ?? notifyToolClass(null);
  // `other` is never allowed from a notification (§11.7): an offer that says so is cut to Deny.
  return { sessionId: a.sessionId, requestId: a.requestId, toolClass, decisions: toolClass === 'other' ? decisions.filter((d) => d === 'deny') : decisions };
}

/** Normalises an event, or says why it is dropped. */
export function validateEvent(e: NotifyEmit, id: string, at: string): NotifyEvent | string {
  if (!e || typeof e !== 'object') return 'not an object';
  if (!(NOTIFY_KINDS as readonly string[]).includes(e.kind)) return `unknown kind ${String(e.kind)}`;
  const s = e.subject;
  if (!s || !SUBJECT_TYPES.has(s.type) || typeof s.id !== 'string' || !ID.test(s.id)) return 'bad subject';
  if (s.workspaceId !== undefined && s.workspaceId !== null && (typeof s.workspaceId !== 'string' || !ID.test(s.workspaceId))) return 'bad subject workspace';
  const facts: NotifyEvent['facts'] = {};
  for (const [k, v] of Object.entries(e.facts ?? {})) {
    if (!FACT_KEY.test(k)) return `bad fact name ${k.slice(0, 32)}`;
    if (Object.keys(facts).length >= 20) return 'too many facts';
    if (v === null || typeof v === 'boolean') facts[k] = v;
    else if (typeof v === 'number') {
      if (!Number.isFinite(v)) return `fact ${k} is not a finite number`;
      facts[k] = v;
    } else if (typeof v === 'string') facts[k] = cleanFact(v);
    else return `fact ${k} is not a plain value`;
  }
  const estimates = Array.isArray(e.estimates) ? e.estimates.filter((k) => typeof k === 'string' && Object.hasOwn(facts, k)) : undefined;
  const detail = e.detail && typeof e.detail.text === 'string' && e.detail.text.trim() ? (() => {
    const d = cleanDetail(e.detail.text);
    return { text: d.text, truncated: d.truncated || !!e.detail.truncated };
  })() : undefined;
  const audience = Array.isArray(e.audience) ? [...new Set(e.audience.filter((u) => typeof u === 'string' && USER.test(u)))] : undefined;
  const answer = e.kind === 'approval' ? validOffer(e.answer) : undefined;
  const when = typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : at;
  return {
    id,
    kind: e.kind,
    at: when,
    subject: { type: s.type, id: s.id, ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}) },
    facts,
    ...(estimates?.length ? { estimates } : {}),
    ...(detail ? { detail } : {}),
    ...(answer ? { answer } : {}),
    ...(audience ? { audience } : {}),
  };
}

export function createBus(now: () => Date = () => new Date()): NotifyBus {
  const listeners = new Map<NotifyKind | '*', Set<(e: NotifyEvent) => void>>();
  const call = (fn: (e: NotifyEvent) => void, e: NotifyEvent) => {
    try {
      fn(e);
    } catch (err) {
      console.error(`[notify] a ${e.kind} listener failed: ${(err as Error).message}`);
    }
  };
  return {
    emit(raw) {
      try {
        const e = validateEvent(raw, `evt_${randomBytes(8).toString('hex')}`, now().toISOString());
        if (typeof e === 'string') {
          console.warn(`[notify] an event was dropped: ${e}`);
          return null;
        }
        for (const fn of [...(listeners.get(e.kind) ?? []), ...(listeners.get('*') ?? [])]) call(fn, e);
        return e;
      } catch (err) {
        console.error(`[notify] emit failed: ${(err as Error).message}`);
        return null;
      }
    },
    on(kind, fn) {
      let set = listeners.get(kind);
      if (!set) listeners.set(kind, (set = new Set()));
      set.add(fn);
      return () => void set.delete(fn);
    },
  };
}
