// Triggers: making, changing and removing them (docs/prd/triggers.md FR1 to FR3, FR12, FR21, §14). Input is validated field by field
// (422 with `details`); a template naming an unknown variable is refused at save (R10); a webhook trigger's receiver path and signing secret
// are made here, sealed, and the secret is shown ONCE. GitLab's signing token is the other way round: GitLab makes it, the owner pastes it
// (`setSecret`), and until then every delivery answers 401 (R22). Callers pass the owner they already checked: this file decides no right.

import { randomBytes } from 'node:crypto';
import { AppError } from '@isnanme/core';
import {
  TICKET_PRIORITIES,
  TICKET_TYPES,
  TRIGGER_ACTION_TYPES,
  TRIGGER_PERMISSION_MODES,
  TRIGGER_SOURCES,
  WEBHOOK_ACTIONS,
  WEBHOOK_EVENTS,
  WEBHOOK_PROVIDERS,
  type CiFailedSpec,
  type CreatedTrigger,
  type CronSpec,
  type Trigger,
  type TriggerAction,
  type TriggerEventFacts,
  type TriggerInput,
  type TriggerSource,
  type TriggerTestResult,
  type WebhookSpec,
} from '@portal/contracts';
import { cronProblem, nextRunIso, nextRuns, startOfLocalDay } from './cron.js';
import { parseApproval, parseLimits, type Problems } from './limits.js';
import { signingKey } from './providers/signature.js';
import { blankFacts, sanitizeFacts } from './normalize.js';
import { ciMatches, webhookMatches } from './runner.js';
import { newTriggerId, triggerView, type TriggerRecord, type TriggerStore, type TriggerWrite } from './store.js';
import { renderOpening, templateProblems } from './template.js';

export const NAME_MAX = 60;
const LIST_MAX = 20;
const PATTERN = /^[A-Za-z0-9_.*/@+=-]{1,100}$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,60}$/;
export const CI_GUARD = { cooldownMin: { min: 1, max: 1440, default: 30 }, maxPerBranchPerDay: { min: 1, max: 50, default: 3 } };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function strList(v: unknown, key: string, re: RegExp, p: Problems): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > LIST_MAX || !v.every((x) => typeof x === 'string' && re.test(x))) {
    p[key] = `Up to ${LIST_MAX} short values.`;
    return [];
  }
  return [...new Set(v as string[])];
}

function intIn(v: unknown, b: { min: number; max: number; default: number }, key: string, p: Problems): number {
  if (v === undefined) return b.default;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < b.min || v > b.max) {
    p[key] = `A whole number from ${b.min} to ${b.max}.`;
    return b.default;
  }
  return v;
}

const optId = (v: unknown, key: string, p: Problems, max = 200): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) {
    p[key] = 'Not a valid value.';
    return null;
  }
  return v.trim() || null;
};

export interface ServiceDeps {
  store: TriggerStore;
  timezone(): string;
  now?: () => Date;
}

export class TriggerService {
  readonly #now: () => Date;
  constructor(private readonly d: ServiceDeps) {
    this.#now = d.now ?? (() => new Date());
  }

  get store(): TriggerStore {
    return this.d.store;
  }

  /* ---------- Validation ---------- */

  #cron(v: unknown, p: Problems): CronSpec | null {
    if (!isObj(v)) return ((p.cron = 'A schedule is required.'), null);
    const tz = v.tz === undefined || v.tz === '' ? this.d.timezone() : v.tz;
    const problem = cronProblem(v.expr, tz, this.#now().getTime());
    if (problem) p['cron.expr'] = problem;
    const catchUp = v.catchUp === undefined ? 'skip' : v.catchUp;
    if (catchUp !== 'skip' && catchUp !== 'once') p['cron.catchUp'] = 'Skip or once.';
    return { expr: String(v.expr ?? '').trim().replace(/\s+/g, ' '), tz: String(tz), catchUp: catchUp === 'once' ? 'once' : 'skip' };
  }

  #webhook(v: unknown, p: Problems, base: WebhookSpec | null): WebhookSpec | null {
    if (!isObj(v)) return ((p.webhook = 'The webhook settings are required.'), null);
    const provider = v.provider ?? base?.provider;
    if (!WEBHOOK_PROVIDERS.includes(provider as never)) p['webhook.provider'] = 'Gitea, GitHub or GitLab.';
    if (base && provider !== base.provider) p['webhook.provider'] = 'The provider cannot change: make a new trigger.';
    let host: string | null = null;
    if (v.host !== undefined && v.host !== null && v.host !== '') {
      if (typeof v.host !== 'string' || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i.test(v.host.trim())) p['webhook.host'] = 'A host name, such as git.example.com.';
      else host = v.host.trim().toLowerCase();
    }
    if (provider !== 'github' && !host) p['webhook.host'] = 'The Git host’s name, such as git.example.com.';
    const events = Array.isArray(v.events) ? [...new Set(v.events)] : [];
    if (!events.length || !events.every((e) => WEBHOOK_EVENTS.includes(e as never))) p['webhook.events'] = 'Pick at least one event.';
    const known = new Set(events.flatMap((e) => WEBHOOK_ACTIONS[e as keyof typeof WEBHOOK_ACTIONS] ?? []));
    const actions = Array.isArray(v.actions) ? [...new Set(v.actions)] : [];
    if (v.actions !== undefined && (!Array.isArray(v.actions) || !actions.every((a) => typeof a === 'string' && known.has(a)))) p['webhook.actions'] = 'Only actions of the chosen events.';
    const gitlabAuth = v.gitlabAuth ?? base?.gitlabAuth ?? 'signing';
    if (gitlabAuth !== 'signing' && gitlabAuth !== 'token') p['webhook.gitlabAuth'] = 'Signing token or secret token.';
    if (base && gitlabAuth !== base.gitlabAuth) p['webhook.gitlabAuth'] = 'This cannot change: make a new trigger.';
    return {
      provider: provider as WebhookSpec['provider'],
      host,
      events: events as WebhookSpec['events'],
      actions: actions as string[],
      repos: strList(v.repos, 'webhook.repos', PATTERN, p),
      branches: strList(v.branches, 'webhook.branches', PATTERN, p),
      labels: strList(v.labels, 'webhook.labels', LABEL, p),
      gitlabAuth: gitlabAuth === 'token' ? 'token' : 'signing',
    };
  }

  #ci(v: unknown, p: Problems): CiFailedSpec | null {
    if (!isObj(v)) return ((p.ciFailed = 'The CI settings are required.'), null);
    return {
      workspaceId: optId(v.workspaceId, 'ciFailed.workspaceId', p),
      repo: optId(v.repo, 'ciFailed.repo', p, 100),
      pipeline: optId(v.pipeline, 'ciFailed.pipeline', p, 100),
      branches: strList(v.branches, 'ciFailed.branches', PATTERN, p),
      cooldownMin: intIn(v.cooldownMin, CI_GUARD.cooldownMin, 'ciFailed.cooldownMin', p),
      maxPerBranchPerDay: intIn(v.maxPerBranchPerDay, CI_GUARD.maxPerBranchPerDay, 'ciFailed.maxPerBranchPerDay', p),
    };
  }

  #action(v: unknown, source: TriggerSource, p: Problems): TriggerAction {
    const a = isObj(v) ? v : {};
    if (!isObj(v)) p.action = 'What the trigger does is required.';
    const type = TRIGGER_ACTION_TYPES.includes(a.type as never) ? (a.type as TriggerAction['type']) : ((p['action.type'] = 'Session, ticket, or both.'), 'session');
    const workspaceId = typeof a.workspaceId === 'string' && /^[A-Za-z0-9._:-]{1,64}\/[A-Za-z0-9._-]{1,128}$/.test(a.workspaceId) ? a.workspaceId : ((p['action.workspaceId'] = 'Pick a workspace.'), '');
    const mode = a.permissionMode === undefined ? 'default' : a.permissionMode;
    // Bypass and dontAsk are never a trigger's mode (R20).
    if (!TRIGGER_PERMISSION_MODES.includes(mode as never)) p['action.permissionMode'] = 'Ask, plan or accept edits.';
    const template = typeof a.template === 'string' ? a.template : '';
    const tp = templateProblems(template, source);
    if (tp.length) p['action.template'] = tp.join(' ');
    let ticket: TriggerAction['ticket'] = null;
    if (type !== 'session') {
      const tk = isObj(a.ticket) ? a.ticket : {};
      const tType = tk.type === undefined ? 'task' : tk.type;
      const prio = tk.priority === undefined ? 'normal' : tk.priority;
      if (!TICKET_TYPES.includes(tType as never)) p['action.ticket.type'] = 'Not a ticket type.';
      if (!TICKET_PRIORITIES.includes(prio as never)) p['action.ticket.priority'] = 'Not a priority.';
      const assignTo = tk.assignTo === 'owner' ? 'owner' : tk.assignTo === undefined || tk.assignTo === 'queue' ? 'queue' : ((p['action.ticket.assignTo'] = 'Queue or owner.'), 'queue');
      ticket = { type: tType as never, priority: prio as never, tags: strList(tk.tags, 'action.ticket.tags', /^[a-z0-9][a-z0-9-]{0,29}$/, p).slice(0, 9), assignTo };
    }
    return {
      type,
      workspaceId,
      claudeId: optId(a.claudeId, 'action.claudeId', p, 64),
      cwd: optId(a.cwd, 'action.cwd', p, 500),
      worktree: a.worktree === undefined ? true : a.worktree === true,
      permissionMode: (TRIGGER_PERMISSION_MODES.includes(mode as never) ? mode : 'default') as TriggerAction['permissionMode'],
      template,
      ticket,
    };
  }

  /** The whole input checked, merged over `base` for a change. Throws 422 with every problem. */
  validate(input: unknown, base: TriggerRecord | null): TriggerWrite {
    if (!isObj(input)) throw new AppError('VALIDATION_FAILED', 'Expected a trigger.');
    const p: Problems = {};
    const i = input as Partial<TriggerInput> & Record<string, unknown>;
    const source = (base?.source ?? i.source) as TriggerSource;
    if (!TRIGGER_SOURCES.includes(source)) p.source = 'Cron, webhook or CI.';
    if (base && i.source !== undefined && i.source !== base.source) p.source = 'The source cannot change: make a new trigger.';
    const rawName = i.name ?? base?.name;
    const name = typeof rawName === 'string' ? rawName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
    if (!name || name.length > NAME_MAX) p.name = `A name of 1 to ${NAME_MAX} characters.`;
    const cron = source === 'cron' ? this.#cron(i.cron ?? base?.cron, p) : null;
    const webhook = source === 'webhook' ? this.#webhook(i.webhook ?? base?.webhook, p, base?.webhook ?? null) : null;
    const ciFailed = source === 'ci_failed' ? this.#ci(i.ciFailed ?? base?.ciFailed, p) : null;
    const action = this.#action(i.action ?? base?.action, TRIGGER_SOURCES.includes(source) ? source : 'cron', p);
    const limits = parseLimits(i.limits, base?.limits, p);
    const approval = parseApproval(i.approval, TRIGGER_SOURCES.includes(source) ? source : 'cron', base?.approval ?? null, i.confirm === true, p);
    if (i.enabled !== undefined && typeof i.enabled !== 'boolean') p.enabled = 'On or off.';
    if (Object.keys(p).length) {
      const first = Object.values(p)[0]!;
      throw new AppError('VALIDATION_FAILED', first, { details: p });
    }
    const enabled = i.enabled ?? base?.enabled ?? true;
    const nextRunAt = cron && enabled ? nextRunIso(cron.expr, cron.tz, this.#now()) : null;
    return { name, enabled, source, cron, webhook, ciFailed, action, limits, approval, nextRunAt };
  }

  /* ---------- Changes ---------- */

  /** Makes a trigger for `ownerId`. A webhook trigger gets its path and, unless GitLab makes it, its secret (returned once). */
  create(ownerId: string, createdBy: string, input: unknown): { record: TriggerRecord; secret: string | null } {
    const w = this.validate(input, null);
    const { store } = this.d;
    if (w.source === 'webhook' && !store.store.secrets) throw new AppError('SERVICE_UNAVAILABLE', 'The portal is locked: a webhook’s secret cannot be sealed.');
    const id = newTriggerId();
    store.insert(id, ownerId, createdBy, w);
    let secret: string | null = null;
    if (w.webhook) {
      store.newPathToken(id);
      if (w.webhook.provider === 'gitlab' && w.webhook.gitlabAuth === 'signing') store.setSecret(id, null, 'provided');
      else {
        secret = newSecret();
        store.setSecret(id, secret, 'generated');
      }
    }
    return { record: store.get(id)!, secret };
  }

  update(t: TriggerRecord, input: unknown): TriggerRecord {
    const w = this.validate(input, t);
    this.d.store.update(t.id, w);
    // Turned on again by a person: a pause by the portal is over.
    if (w.enabled && !t.enabled) this.d.store.setEnabled(t.id, true, null);
    return this.d.store.get(t.id)!;
  }

  setEnabled(t: TriggerRecord, enabled: boolean): TriggerRecord {
    this.d.store.setEnabled(t.id, enabled, null);
    this.d.store.setNextRun(t.id, enabled && t.cron ? nextRunIso(t.cron.expr, t.cron.tz, this.#now()) : null);
    return this.d.store.get(t.id)!;
  }

  remove(t: TriggerRecord): void {
    this.d.store.remove(t.id);
  }

  /** A new generated secret (the old one answers 401 at once, R18); not for GitLab's signing token. */
  rotateSecret(t: TriggerRecord): string {
    if (!t.webhook) throw new AppError('CONFLICT', 'Only a webhook trigger has a secret.');
    if (t.secretMode === 'provided') throw new AppError('CONFLICT', 'GitLab makes this token: generate a new one there and paste it here.');
    if (!this.d.store.store.secrets) throw new AppError('SERVICE_UNAVAILABLE', 'The portal is locked.');
    const s = newSecret();
    this.d.store.setSecret(t.id, s, 'generated');
    return s;
  }

  /** GitLab's signing token, pasted by the owner: `whsec_` + base64 of 16 to 128 bytes. A bad one is refused and never echoed (R22). */
  setProvidedSecret(t: TriggerRecord, secret: unknown): TriggerRecord {
    if (!t.webhook || t.webhook.provider !== 'gitlab' || t.webhook.gitlabAuth !== 'signing') throw new AppError('CONFLICT', 'Only a GitLab trigger with a signing token takes a pasted token.');
    if (typeof secret !== 'string' || secret.length > 400 || !signingKey(secret.trim())) throw new AppError('VALIDATION_FAILED', 'Paste the signing token GitLab showed (it starts with whsec_).', { details: { secret: 'Not a signing token.' } });
    if (!this.d.store.store.secrets) throw new AppError('SERVICE_UNAVAILABLE', 'The portal is locked.');
    this.d.store.setSecret(t.id, secret.trim(), 'provided');
    return this.d.store.get(t.id)!;
  }

  /** A new receiver path: the old one answers 404 at once (R18). */
  rotateUrl(t: TriggerRecord): TriggerRecord {
    if (!t.webhook) throw new AppError('CONFLICT', 'Only a webhook trigger has a receiver address.');
    if (!this.d.store.store.secrets) throw new AppError('SERVICE_UNAVAILABLE', 'The portal is locked.');
    this.d.store.newPathToken(t.id);
    return this.d.store.get(t.id)!;
  }

  /* ---------- Views ---------- */

  view(t: TriggerRecord): Trigger {
    const { store } = this.d;
    const tz = t.cron?.tz ?? this.d.timezone();
    const today = new Date(startOfLocalDay(tz, this.#now().getTime())).toISOString();
    const row = t.webhook ? store.row(t.id) : null;
    return triggerView(t, { path: row ? store.path(row) : '', runsToday: store.startedSince(t.id, today), costToday: store.costSince(t.id, today) });
  }

  created(r: { record: TriggerRecord; secret: string | null }): CreatedTrigger {
    return { trigger: this.view(r.record), secret: r.secret };
  }

  /** What a trigger (saved or not) would do with a sample event; starts nothing (FR21). */
  test(t: Pick<TriggerRecord, 'source' | 'name' | 'cron' | 'webhook' | 'ciFailed' | 'action' | 'approval'> & { enabled: boolean }, sample: unknown): TriggerTestResult {
    const at = this.#now().toISOString();
    const base = sampleFacts(t, at);
    const event = isObj(sample) ? sanitizeFacts(sample, base) : base;
    const labels = event.untrusted.labels ? event.untrusted.labels.split(', ') : [];
    const rec = { ...t, id: 'trg_preview', ownerId: '', limits: null as never, secretMode: 'generated' as const, secretSet: false, paused: null, runs: 0, nextRunAt: null, lastRunAt: null, createdAt: at, updatedAt: at };
    const matches = t.source === 'webhook' ? webhookMatches(rec, event, labels) : t.source === 'ci_failed' ? ciMatches(rec, event) : true;
    const opening = renderOpening(t.action.template, t.source, event, { triggerName: t.name, tz: t.cron?.tz ?? this.d.timezone(), cron: t.cron?.expr ?? null });
    const nextRunsIso = t.cron ? nextRuns(t.cron.expr, t.cron.tz, this.#now().getTime(), 5).map((ms) => new Date(ms).toISOString()) : [];
    return { event, matches, reason: !matches ? 'filtered' : !t.enabled ? 'disabled' : null, opening, nextRuns: nextRunsIso };
  }
}

export const newSecret = () => `cpws_${randomBytes(32).toString('base64url')}`;

/** A sample event shaped like the provider's documented one, for Test and the preview (no real Git host is asked). */
export function sampleFacts(t: Pick<TriggerRecord, 'source' | 'webhook' | 'ciFailed' | 'action'>, at: string): TriggerEventFacts {
  if (t.source === 'cron') return { ...blankFacts('github', 'push', at), source: 'cron', provider: null, event: 'schedule' };
  if (t.source === 'ci_failed') {
    return {
      ...blankFacts('github', 'push', at),
      source: 'ci_failed',
      provider: null,
      event: 'ci_failed',
      repo: t.ciFailed?.repo ?? 'origin',
      branch: 'main',
      sha: '0123456789abcdef0123456789abcdef01234567',
      ci: { runId: 'cir_sample', runNumber: 14, pipeline: t.ciFailed?.pipeline ?? 'ci', reason: 'failed', ticketId: null, workspaceId: t.ciFailed?.workspaceId ?? t.action.workspaceId },
      untrusted: { logTail: 'npm ERR! Test failed. See above for more details.' },
    };
  }
  const w = t.webhook!;
  const host = w.host ?? 'github.com';
  const event = w.events[0] ?? 'push';
  const repo = 'owner/name';
  const f = { ...blankFacts(w.provider, event, at), repo, sender: 'octocat', sha: '0123456789abcdef0123456789abcdef01234567', branch: w.branches[0]?.includes('*') ? 'main' : (w.branches[0] ?? 'main') };
  if (event === 'push') return { ...f, action: 'pushed', url: `https://${host}/${repo}/compare/a...b`, untrusted: { commits: 'Fix the login form' } };
  const action = w.actions[0] ?? WEBHOOK_ACTIONS[event][0]!;
  if (event === 'comment') return { ...f, action, number: 42, url: `https://${host}/${repo}/issues/42`, untrusted: { title: 'Login fails', comment: 'Still happens on main' } };
  const labels = w.labels.length ? { labels: w.labels.join(', ') } : {};
  return { ...f, action, number: 42, fork: event === 'pull_request' ? false : null, url: `https://${host}/${repo}/${event === 'issue' ? 'issues' : 'pull'}/42`, untrusted: { title: 'Fix the login form', body: 'This closes #41.', ...labels } };
}
