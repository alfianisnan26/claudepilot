// The triggers editor on the Schedules page (T-2950, general-manager PRD §9.2): its pure parts. The form makes or changes a cron trigger, and
// changes the name, workspace, action and instruction of any trigger; the trigger routes (`POST`/`PATCH /api/triggers`) check and save it.
// A webhook trigger is made where its secret can be shown once, not here. The server is the judge: these checks only catch the empty form.

import type { Trigger, TriggerActionType, TriggerInput } from '@portal/contracts';

export interface TriggerForm {
  name: string;
  /** Five cron fields; only for a cron trigger. */
  expr: string;
  /** IANA zone; empty: the portal's. */
  tz: string;
  workspaceId: string;
  action: TriggerActionType;
  template: string;
  enabled: boolean;
}

/** The server's bounds (triggers/service.ts NAME_MAX, contracts TRIGGER_TEMPLATE_MAX). */
export const TRIGGER_NAME_MAX = 60;

export const ACTION_OPTIONS: { value: TriggerActionType; label: string }[] = [
  { value: 'session', label: 'Session' },
  { value: 'ticket', label: 'Ticket' },
  { value: 'ticket_session', label: 'Both' },
];

export const emptyTriggerForm = (workspaceId = ''): TriggerForm => ({
  name: '',
  expr: '0 3 * * *',
  tz: '',
  workspaceId,
  action: 'session',
  template: '',
  enabled: true,
});

export const formFromTrigger = (t: Trigger): TriggerForm => ({
  name: t.name,
  expr: t.cron?.expr ?? '',
  tz: t.cron?.tz ?? '',
  workspaceId: t.action.workspaceId,
  action: t.action.type,
  template: t.action.template,
  enabled: t.enabled,
});

/** Field problems the form can see without the server: empty fields and the name's length. Keys are the server's detail keys. */
export function formProblems(f: TriggerForm, isCron: boolean): Record<string, string> {
  const p: Record<string, string> = {};
  const name = f.name.trim();
  if (!name || name.length > TRIGGER_NAME_MAX) p.name = `A name of 1 to ${TRIGGER_NAME_MAX} characters.`;
  if (isCron && f.expr.trim().split(/\s+/).filter(Boolean).length !== 5) p['cron.expr'] = 'Five fields: minute hour day month weekday.';
  if (!f.workspaceId) p['action.workspaceId'] = 'Pick a workspace.';
  return p;
}

/**
 * The body to save. New: a cron trigger (`POST`). A change (`PATCH`): the name, the switch, the cron of a cron trigger, and the action
 * merged over the trigger's own (the route replaces the action whole, so its Claude, folder, worktree, mode and ticket fields are kept).
 */
export function triggerBody(f: TriggerForm, base: Trigger | null): TriggerInput | Partial<TriggerInput> {
  const cron = { expr: f.expr.trim().replace(/\s+/g, ' '), tz: f.tz.trim(), catchUp: base?.cron?.catchUp ?? ('skip' as const) };
  const kept = base?.action;
  const action = {
    type: f.action,
    workspaceId: f.workspaceId,
    claudeId: kept?.claudeId ?? null,
    cwd: kept?.cwd ?? null,
    worktree: kept?.worktree ?? true,
    permissionMode: kept?.permissionMode ?? 'default',
    template: f.template,
    ticket: f.action === 'session' ? null : (kept?.ticket ?? { type: 'task', priority: 'normal', tags: [], assignTo: 'queue' }),
  } satisfies TriggerInput['action'];
  if (!base) return { name: f.name.trim(), enabled: f.enabled, source: 'cron', cron, action };
  return { name: f.name.trim(), enabled: f.enabled, ...(base.source === 'cron' ? { cron } : {}), action };
}

/** A 422's `details` as field errors (only string values); anything else: none. */
export function detailErrors(details: unknown): Record<string, string> {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  return Object.fromEntries(Object.entries(details as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
}
