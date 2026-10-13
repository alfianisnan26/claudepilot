// Notification text (docs/prd/web-app-pwa.md §11.1): a fixed template per kind over names and numbers. Never a prompt, a reply, a
// command, a path, a URL, error text, a secret name, a ticket summary or a session title: those are written by agents and webhooks.
// A number says what it is (an estimate carries "est."). A destination with "Include detail" adds the event's redacted detail, clipped
// and labelled untrusted. Pure.

import { NOTIFY_KIND_INFO, notifyPath, type NotifyEvent, type NotifyKind, type NotifySeverity } from '@portal/contracts';
import { clock } from './quiet.js';

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
  /** The destination's zone, for clock times in the text. */
  tz?: string;
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
    case 'workspace':
    case 'portal':
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
    case 'test':
      return `test:${e.id}`;
    default:
      return `${e.kind}:${s.id}`;
  }
}

function text(e: NotifyEvent, tz: string): { title: string; body: string } {
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
      const resets = typeof f.resetsAt === 'string' && !Number.isNaN(Date.parse(f.resetsAt)) ? `resets ${clock(new Date(f.resetsAt), tz)}` : null;
      if (f.projection === true) {
        const eta = typeof f.etaAt === 'string' && !Number.isNaN(Date.parse(f.etaAt)) ? `out by ${clock(new Date(f.etaAt), tz)} est.` : 'may run out est.';
        return { title: 'Quota low', body: join(name(f.claude, 'Claude'), name(f.window, ''), eta, resets) };
      }
      const left = pct(f.leftPct);
      return { title: 'Quota low', body: join(name(f.claude, 'Claude'), name(f.window, ''), left && `${left} left${est(e, 'leftPct')}`, resets) };
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
      return {
        title: f.suggested === true ? 'Move suggested' : `Moved to ${name(f.to, 'another Claude')}`,
        body: join(ws, f.suggested === true && `to ${name(f.to, 'another Claude')}`, left && `${left} left${est(e, 'leftPct')}`),
      };
    }
    case 'test':
      return { title: 'Test', body: 'Notifications work' };
    default:
      return { title: NOTIFY_KIND_INFO[e.kind as NotifyKind]?.label ?? 'Notice', body: ws };
  }
}

/** The text and link of one event for one destination. */
export function render(e: NotifyEvent, opts: RenderOptions = {}): Rendered {
  const info = NOTIFY_KIND_INFO[e.kind];
  const { title, body } = text(e, opts.tz ?? 'UTC');
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
