// Test helpers for the whole-app enumeration (organizations slice 1, P4): the app exactly as `createApp` builds it with EVERY optional module
// present (stand-ins whose route factories still register every route), and every family of Portal MCP tools registered the way index.ts
// does. Nothing here talks to a runtime: the stand-in answers every call with another stand-in.

import type { Hono } from 'hono';
import { createApp } from '../app.js';
import { createBrowserRoutes } from '../browser/routes.js';
import { createConnect } from '../connect/index.js';
import { freshStore } from '../notify/testkit.js';
import { createPlatform } from '../platform/index.js';
import { Portal } from '../portal.js';
import { portalTools, type PortalToolDefinition } from '../portalmcp/registry.js';
import type { Store } from '../store/store.js';

/** Anything: every property, call and `new` gives another stand-in; never a thenable, never iterable. */
export const standIn = (): object =>
  new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' || p === Symbol.iterator ? undefined : standIn()),
    apply: () => standIn(),
    construct: () => standIn(),
    set: () => true,
  });

export const SERVER_CODE = '24681357';

/** The whole app, every optional module present; `store` is a fresh one unless given; `portal` signs in with SERVER_CODE. */
export async function buildWholeApp(opts: { store?: Store; workspaces?: unknown; portal?: Portal } = {}): Promise<{ app: Hono; store: Store; portal: Portal }> {
  const store = opts.store ?? (await freshStore()).store;
  const s = () => standIn() as never;
  const platform = createPlatform({ store, settings: s(), chat: s(), ci: s(), claudeUsage: s(), usageSpend: s(), tickets: s(), ticketInfo: () => null, uiUrl: null, pushContact: null, selfOrigin: 'http://localhost:1', tools: false } as never);
  const portal = opts.portal ?? new Portal(SERVER_CODE, 60_000);
  const make = createApp as unknown as (...args: unknown[]) => Hono;
  const app = make(portal, opts.workspaces ?? s(), store, s(), s(), s(), s(), s(), {
    serveWeb: false,
    poolService: s(),
    mcp: s(),
    skills: s(),
    personas: s(),
    settings: s(),
    secrets: s(),
    portalMcp: s(),
    tickets: s(),
    ci: s(),
    knowledge: s(),
    // The browser's and Connect's routers are real (their factories only define routes); their services are stand-ins.
    browser: { routes: () => createBrowserRoutes(s()), attach: () => undefined },
    claudeUsage: s(),
    usageSpend: s(),
    lab: s(),
    repos: s(),
    glance: s(),
    attention: s(),
    approvals: s(),
    codespaces: s(),
    platform,
    claudeVersions: s(),
    connect: createConnect({
      store,
      config: s(),
      scanned: async () => [],
      scannedIds: () => [],
      workspacesOn: async () => [],
      removeWorkspace: async () => undefined,
      bundle: () => ({ build: 'test', sha256: '', version: '0.0.0', source: '' }),
      log: () => undefined,
    }),
    appPorts: s(),
    reporter: { service: s(), vendorDirs: [] },
  });
  return { app, store, portal };
}

/**
 * The route table as the policy table keys it: every registered route except middleware (`use`, which Hono lists with method ALL and a
 * handler that takes `next`). A route's own guard (a middleware registered with its method) shares its key, so it adds nothing.
 */
export function routeKeys(app: Hono): Set<string> {
  const keys = new Set<string>();
  for (const r of app.routes) if (r.method !== 'ALL' || r.handler.length < 2) keys.add(`${r.method} ${r.path}`);
  return keys;
}

/**
 * Registers every family of tools the portal has (index.ts), with stand-in services, into the portal's registry; returns them all. A family whose
 * path is in `registeredBy` was (or is) registered by the caller with real or fake services (the MCP isolation probe), so it is skipped here.
 */
export async function registerAllTools(registeredBy: readonly string[] = []): Promise<PortalToolDefinition[]> {
  for (const path of registeredBy) registered.add(path);
  const s = standIn() as never;
  const once = async (path: string, run: (m: Record<string, (...a: unknown[]) => void>) => void) => run((await import(path)) as never);
  const families: [string, (m: Record<string, (...a: unknown[]) => void>) => void][] = [
    ['../approvals/portalTools.js', (m) => m.registerApprovalTools!(s)],
    ['../attention/portalTools.js', (m) => m.registerAttentionTools!(s)],
    ['../autotransfer/portalTools.js', (m) => m.registerAutoTransferTools!(s)],
    ['../chat/artifacts/portalTools.js', (m) => m.registerArtifactTools!(s)],
    ['../chat/managerTools.js', (m) => m.registerChatManagerTools!(s)],
    ['../chat/portalTools.js', (m) => m.registerChatTools!(s)],
    ['../ci/portalTools.js', (m) => m.registerCiTools!(s, undefined)],
    ['../claudeusage/portalTools.js', (m) => m.registerClaudeUsageTools!(s)],
    ['../claudeversion/portalTools.js', (m) => m.registerClaudeVersionTools!(s)],
    ['../keepgoing/portalTools.js', (m) => m.registerKeepGoingTools!(s)],
    ['../knowledge/portalTools.js', (m) => m.registerKnowledgeTools!(s)],
    ['../lab/metricsTools.js', (m) => m.registerMetricsTools!(s)],
    ['../lab/portalTools.js', (m) => m.registerLabTools!(s)],
    ['../notify/portalTools.js', (m) => m.registerNotifyTools!(s)],
    ['../personas/portalTools.js', (m) => m.registerPersonaTools!(s, {})],
    ['../portalmcp/tools/index.js', (m) => m.registerBuiltInPortalTools!(s)],
    ['../reporter/portalTools.js', (m) => m.registerReporterTools!(s, s)],
    ['../repos/portalTools.js', (m) => m.registerRepoTools!(s)],
    ['../schedules/portalTools.js', (m) => (m.registerSchedulesTools!(s), m.registerScheduleActionTools!(s))],
    ['../settings/portalTools.js', (m) => m.registerSettingsTools!(s)],
    ['../skills/portalTools.js', (m) => m.registerSkillTools!(s, {})],
    ['../tickets/portalTools.js', (m) => m.registerTicketTools!(s)],
    ['../triggers/portalTools.js', (m) => m.registerTriggerTools!(s)],
    ['../usagespend/portalTools.js', (m) => m.registerUsageSpendTools!(s)],
  ];
  for (const [path, run] of families) if (!registered.has(path)) (await once(path, run), registered.add(path));
  return portalTools.list();
}
const registered = new Set<string>();
