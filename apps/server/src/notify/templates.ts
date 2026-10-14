// Notification text (docs/prd/web-app-pwa.md §11.1): a fixed template per kind over names and numbers. Never a prompt, a reply, a
// command, a path, a URL, error text, a secret name, a ticket summary or a session title: those are written by agents and webhooks.
// A number says what it is (an estimate carries "est."). A destination with "Include detail" adds the event's redacted detail, clipped
// and labelled untrusted. Pure.

import { isPortalPath, KEEPGOING_CAUSE_TEXT, NOTIFY_KIND_INFO, notifyPath, timeMark, zonedTime, zoneLabel, type NotifyEvent, type NotifyKind, type NotifySeverity } from '@portal/contracts';

export interface Rendered {
  title: string;
  body: string;
  /** A portal path (`/admin/...`), never an absolute URL. */
  path: string;
  /** One notification per item: a newer one replaces it in place. */
  tag: string;
  renotify: boolean;
  severity: NotifySeverity;
}

export interface RenderOptions {
  /** The destination's zone, for clock times in the text (T-126: the recipient's zone, never the server's). */
  tz?: string;
  /** Say the zone after each time ("19:26 UTC"): a destination that is not a device of the person (a webhook, Slack, Discord). */
  labelZone?: boolean;
  /** The Inbox row: times as marks (`timeMark`), shown later in the reader's own zone. Wins over `tz`. */
  marks?: boolean;
  /** Now, for the day part of a time ("Wed 02:40"); default the real clock. */
  now?: number;
  /** Add the detail (untrusted), clipped at `detailMax`. */
  includeDetail?: boolean;
  detailMax?: number;
}

const NAME_MAX = 40;
/** A name as it may appear in a notification: printable, one line, clipped. Facts are already one line; this is the second fence. */
export function name(v: unknown, fallback = '?'): string {
  if (typeof v !== 'string' && typeof v !== 'number') return fallback;
  const s = String(v)
    .replace(/[^\p{L}\p{N} ._:#@()+'&/-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return fallback;
  return s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1)}…` : s;
}

/** `docker/api-dev` reads `api-dev`. */
export const workspaceName = (id: unknown): string => {
  const s = typeof id === 'string' ? id : '';
  return name(s.includes('/') ? s.slice(s.indexOf('/') + 1) : s, 'a workspace');
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (v: unknown) => {
  const n = num(v);
  return n === null ? null : `${Math.max(0, Math.min(100, Math.round(n)))} %`;
};
const est = (e: NotifyEvent, key: string) => (e.estimates?.includes(key) ? ' est.' : '');
const join = (...parts: (string | null | undefined | false)[]) => parts.filter((p): p is string => !!p).join(' · ');

/** What a tool request asks, in a few words (the tool class, never the command or the path). */
const ACTION: Record<string, string> = {
  command: 'run a command',
  edit: 'edit a file',
  read: 'read files',
  question: 'answer a question',
  plan: 'review a plan',
  tool: 'use a tool',
};

const REASON: Record<string, string> = {
  rate_limit: 'rate limit',
  error: 'error',
  credential: 'sign-in',
  integrity: 'integrity',
  crash: 'stopped',
  cost_limit: 'cost limit',
  time_limit: 'time limit',
  cap: 'limit reached',
  refused: 'refused',
  self_triggered: 'loop stopped',
  failed: 'failed',
  folder_trust: 'trust the folder again',
};
const reason = (v: unknown) => (typeof v === 'string' && Object.hasOwn(REASON, v) ? REASON[v]! : 'failed');

function pathOf(e: NotifyEvent): string {
  const s = e.subject;
  const f = e.facts;
  switch (s.type) {
    case 'session':
      return notifyPath.session(s.id, e.kind === 'approval' && typeof f.requestId === 'string' ? f.requestId : null);
    case 'ticket':
      return notifyPath.ticket(s.id);
    case 'ci_run':
      return notifyPath.ciRun(s.id);
    case 'claude':
      return notifyPath.usage(s.id);
    case 'budget':
      return notifyPath.usage();
    case 'trigger':
      return notifyPath.trigger(s.id, typeof f.runId === 'string' ? f.runId : null);
    case 'trigger_run':
      return notifyPath.trigger(typeof f.triggerId === 'string' ? f.triggerId : s.id, s.id);
    case 'portal':
      // A Needs you item (T-146, subject `attention:<kind>:<id>`): the deck opens at that card; the path is checked like any other.
      if (e.kind === 'attention' && s.id.startsWith('attention:')) {
        const p = `/admin/attention?item=${encodeURIComponent(s.id.slice('attention:'.length))}`;
        if (isPortalPath(p)) return p;
      }
      return notifyPath.notifications;
    case 'workspace':
    default:
      return notifyPath.notifications;
  }
}

export function tagOf(e: NotifyEvent): string {
  const s = e.subject;
  switch (e.kind) {
    case 'approval':
      return `approval:${s.id}:${typeof e.facts.requestId === 'string' ? e.facts.requestId : e.id}`;
    case 'session_failed':
    case 'session_done':
      return `session:${s.id}`;
    case 'ci_failed':
      return `ci:${s.id}`;
    case 'ci_waiting':
      return `deploy:${s.id}:${name(e.facts.job, 'job')}`;
    case 'quota_low':
      return `quota:${s.id}:${name(e.facts.window, 'window')}`;
    case 'human_request':
      return `ticket:${s.id}`;
    case 'trigger_approval':
    case 'trigger_failed':
      return `trigger:${s.id}`;
    case 'auto_move':
      return `move:${s.id}`;
    case 'cost_spike':
      return `cost:${s.id}`;
    case 'keepgoing_attention':
      return `keepgoing:${s.id}:${name(e.facts.what, 'what')}`;
    case 'attention':
      return s.id;
    case 'test':
      return `test:${e.id}`;
    default:
      return `${e.kind}:${s.id}`;
  }
}

/** T-126: who the quota alert concerns: the chats on the Claude (`1 chat`), `idle` for a watched Claude none runs on; absent: not known. */
function chatsOn(v: unknown): string | null {
  const n = num(v);
  if (n === null) return null;
  return n === 0 ? 'idle' : `${n} chat${n === 1 ? '' : 's'}`;
}

/** How a clock time is written for one recipient. */
type Clock = (at: Date) => string;

function clockOf(opts: RenderOptions): Clock {
  if (opts.marks) return timeMark;
  const tz = opts.tz ?? 'UTC';
  const now = opts.now ?? Date.now();
  return (at) => {
    const iso = at.toISOString();
    const t = zonedTime(iso, now, tz);
    return opts.labelZone ? `${t} ${zoneLabel(iso, tz)}` : t;
  };
}

function text(e: NotifyEvent, clock: Clock): { title: string; body: string } {
  const f = e.facts;
  const ws = workspaceName(f.workspace ?? e.subject.workspaceId);
  switch (e.kind) {
    case 'approval':
      return { title: 'Approval needed', body: join(ws, ACTION[String(f.action)] ?? ACTION.tool!, f.agent === true && 'sub-agent') };
    case 'human_request':
      return { title: 'Request for you', body: join(name(f.ticket, e.subject.id), name(f.type, ''), ws) };
    case 'session_failed':
      return { title: 'Session failed', body: join(ws, reason(f.reason)) };
    case 'session_done': {
      const min = num(f.minutes);
      return { title: 'Session finished', body: join(ws, min !== null && `${Math.max(1, Math.round(min))} min`) };
    }
    case 'ci_failed':
      return { title: 'CI failed', body: join(name(f.repo, 'repo'), num(f.number) !== null && `#${num(f.number)}`, f.pipeline !== undefined && name(f.pipeline, '')) };
    case 'ci_waiting':
      return { title: 'Deploy waits', body: join(name(f.environment, 'environment'), name(f.repo, 'repo'), num(f.number) !== null && `#${num(f.number)}`) };
    case 'quota_low': {
      const resets = typeof f.resetsAt === 'string' && !Number.isNaN(Date.parse(f.resetsAt)) ? `resets ${clock(new Date(f.resetsAt))}` : null;
      if (f.projection === true) {
        const eta = typeof f.etaAt === 'string' && !Number.isNaN(Date.parse(f.etaAt)) ? `out by ${clock(new Date(f.etaAt))} est.` : 'may run out est.';
        return { title: 'Quota low', body: join(name(f.claude, 'Claude'), name(f.window, ''), eta, resets, chatsOn(f.chats)) };
      }
      const left = pct(f.leftPct);
      return { title: 'Quota low', body: join(name(f.claude, 'Claude'), name(f.window, ''), left && `${left} left${est(e, 'leftPct')}`, resets, chatsOn(f.chats)) };
    }
    case 'cost_spike': {
      if (f.what === 'budget') return { title: 'Budget alert', body: join(name(f.name, 'budget'), pct(f.usedPct) && `${pct(f.usedPct)} used est.`) };
      return { title: 'Cost spike', body: join(f.workspace !== undefined ? ws : name(f.claude, 'Claude'), name(f.spikeKind, 'spike'), 'est.') };
    }
    case 'trigger_approval':
      return { title: 'Run needs approval', body: join(name(f.trigger, 'trigger'), name(f.event, '')) };
    case 'trigger_failed':
      return { title: 'Trigger problem', body: join(name(f.trigger, 'trigger'), reason(f.reason)) };
    case 'auto_move': {
      const left = pct(f.leftPct);
      if (f.warned === true) return { title: 'No Claude to move to', body: join(ws, left && `${left} left${est(e, 'leftPct')}`) };
      if (f.blocked === 'trust') return { title: 'Move blocked', body: join(ws, 'trust the folder again', left && `${left} left${est(e, 'leftPct')}`) };
      return {
        title: f.suggested === true ? 'Move suggested' : `Moved to ${name(f.to, 'another Claude')}`,
        body: join(ws, f.suggested === true && `to ${name(f.to, 'another Claude')}`, left && `${left} left${est(e, 'leftPct')}`),
      };
    }
    case 'keepgoing_attention': {
      // What Keep going may not repair, by its fixed words; never the chat's title (that is the untrusted detail, where a destination asked).
      const what = typeof f.what === 'string' && Object.hasOwn(KEEPGOING_CAUSE_TEXT, f.what) ? KEEPGOING_CAUSE_TEXT[f.what as keyof typeof KEEPGOING_CAUSE_TEXT] : 'needs you';
      return { title: 'Keep going', body: join(ws, what, typeof f.ticket === 'string' && name(f.ticket, '')) };
    }
    case 'attention':
      // What kind of thing and why a person (fixed words); the item's own title is untrusted and goes only in the detail.
      return { title: 'Needs you', body: join(name(f.what, 'item'), name(f.why, '')) };
    case 'test':
      return { title: 'Test', body: 'Notifications work' };
    default:
      return { title: NOTIFY_KIND_INFO[e.kind as NotifyKind]?.label ?? 'Notice', body: ws };
  }
}

/** The text and link of one event for one destination. */
export function render(e: NotifyEvent, opts: RenderOptions = {}): Rendered {
  const info = NOTIFY_KIND_INFO[e.kind];
  const { title, body } = text(e, clockOf(opts));
  let full = body;
  if (opts.includeDetail && e.detail?.text) {
    const max = opts.detailMax ?? 160;
    const d = e.detail.text.length > max ? `${e.detail.text.slice(0, max - 1)}…` : e.detail.text;
    full = `${body}\nUntrusted: ${d}`;
  }
  return {
    title,
    body: full,
    path: pathOf(e),
    tag: tagOf(e),
    renotify: e.kind === 'approval' || e.kind === 'session_failed' || e.kind === 'cost_spike',
    severity: info.severity,
  };
}

/** The one summary that ends quiet hours, or that stands for what a throttle held back. */
export function summary(count: number, why: 'quiet' | 'throttle'): { title: string; body: string } {
  const items = count === 1 ? '1 item' : `${count} items`;
  return why === 'quiet' ? { title: 'While quiet', body: `${items} waited` } : { title: 'More waiting', body: `${count === 1 ? '1 more item needs' : `${count} more items need`} you` };
}
