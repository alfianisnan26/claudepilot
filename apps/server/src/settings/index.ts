import { AppError, success } from '@isnanme/core';
import { SETTING_KEYS, workspaceRef, type SettingUpdate } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { actorOf, requireCan } from '../authz/seam.js';
import type { FragmentProvider, Reconciler } from '../delivery/reconciler.js';
import type { Store } from '../store/store.js';
import { AGENT_ENV_KEYS, AgentEnvPolicy } from './agentEnv.js';
import { declareSettingsPolicies } from './authz.js';
import { McpLockdown } from './lockdown.js';
import { defineSetting, defineSettingGroup } from './registry.js';
import { Settings } from './store.js';

export { defineSetting, defineSettingGroup, settingDef, settingDefs } from './registry.js';
export type { SettingDef } from './registry.js';
export { AGENT_ENV, AgentEnvPolicy } from './agentEnv.js';
export { McpLockdown } from './lockdown.js';
export { Settings } from './store.js';
export { SETTINGS_POLICIES } from './authz.js';

declareSettingsPolicies();

// The sections of the Settings page, in order. `sessions` is A2's: its settings appear when it defines them.
defineSettingGroup('mcp', 'MCP', 10);
defineSettingGroup('agents', 'Agents', 20);
defineSettingGroup('sessions', 'Sessions', 30);

// I11: whether a session's Claude may propose changes to its own persona and skills. Always a proposal a
// person approves in the portal, never live by itself; turning it on asks for a confirmation.
defineSetting({
  key: SETTING_KEYS.agentsSelfEdit,
  type: 'boolean',
  default: false,
  scope: 'global',
  group: 'agents',
  order: 10,
  label: 'Agents may propose changes',
  help: 'A session’s Claude may propose changes to its own persona (name, avatar, instructions) and skills. Every proposal waits for a person to approve it in the portal; nothing goes live on its own, and instructions and skills are never approved automatically.',
  confirmText: 'Agents can propose changes to their own persona and skills. A person approves each one.',
  protective: false,
});

const RECHECK_MS = 3_000;

/**
 * The shared settings store and the MCP lockdown, wired together (settings-policies PRD): `settings` for
 * everyone to read and define settings on, `lockdown` as a fragment provider the reconciler joins. Made once
 * in index.ts, before the reconciler starts; a change to an MCP switch asks every known workspace to deliver
 * again (no rollout pace: a protection never waits, foundation §6.3).
 */
export class SettingsModule {
  readonly settings: Settings;
  readonly lockdown: McpLockdown;
  /** The agent policy (T-285): sub-agent cache and caps, output caps, as `env` in the policy drop-in. */
  readonly agentEnv: AgentEnvPolicy;
  /** Set once the reconciler exists. */
  reconciler: Pick<Reconciler, 'request' | 'knownWorkspaces'> | null = null;
  /** Settings changed, for live pages. */
  onChange: () => void = () => {};

  constructor(store: Store, providers: FragmentProvider[]) {
    this.settings = new Settings(store);
    this.lockdown = new McpLockdown(store, this.settings);
    this.lockdown.recheck = (id) => {
      // A pass that changed the lockdown couldn't read the sessions it missed: read them again in a moment.
      const timer = setTimeout(() => void this.reconciler?.request(id, 'lockdown check').catch(() => undefined), RECHECK_MS);
      timer.unref();
    };
    providers.push(this.lockdown);
    this.agentEnv = new AgentEnvPolicy(store, this.settings);
    providers.push(this.agentEnv);
    this.settings.onChange((key) => {
      if (key === SETTING_KEYS.mcpAccountOff || key === SETTING_KEYS.mcpPoolOnly) this.deliverAll(`${key} changed`);
      else if (AGENT_ENV_KEYS.has(key)) this.deliverAll(`${key} changed`);
      this.onChange();
    });
  }

  /** Every known workspace delivers again now. */
  deliverAll(why: string): void {
    const r = this.reconciler;
    if (!r) return;
    for (const id of r.knownWorkspaces()) void r.request(id, why, { changed: true });
  }
}

export function registerSettings(deps: { store: Store; providers: FragmentProvider[] }): SettingsModule {
  return new SettingsModule(deps.store, deps.providers);
}

async function body<T>(c: Context): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

/** `/api/settings`: the list, one change (audited), the audit trail and a workspace's lockdown status. Mounted behind the sign-in guard. */
export function createSettingsRoutes(module: SettingsModule): Hono {
  const app = new Hono();
  const { settings, lockdown, agentEnv } = module;
  app.get('/', (c) => c.json(success(settings.view())));
  app.get('/audit', (c) => c.json(success(settings.audit(Number(c.req.query('limit')) || 100))));
  app.get('/lockdown/:target/:name', (c) => c.json(success(lockdown.status(`${c.req.param('target')}/${c.req.param('name')}`))));
  app.get('/agent-env/:target/:name', (c) => {
    const id = `${c.req.param('target')}/${c.req.param('name')}`;
    // T-309: a workspace the asker may not view answers as one that does not exist (the seam's 404).
    requireCan(actorOf(c), 'view', workspaceRef(id));
    return c.json(success(agentEnv.status(id)));
  });
  app.put('/:key', async (c) => {
    const req = await body<SettingUpdate>(c);
    return c.json(success(settings.set(c.req.param('key') ?? '', req.value, { actor: 'Admin', confirm: req.confirm === true })));
  });
  return app;
}
