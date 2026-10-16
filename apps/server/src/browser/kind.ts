import { AppError } from '@isnanme/core';
import {
  BROWSER_DISPLAYS,
  BROWSER_POOL_DEFAULTS,
  BROWSER_TIERS,
  type BrowserHeaderRule,
  type BrowserPoolContent,
  type BrowserToolRule,
} from '@portal/contracts';
import type { Fragment } from '../delivery/types.js';
import type { AssignedPool, KindContext, ParseContext, PoolKind } from '../pools/kinds.js';
import { compileBrowser } from './compile.js';
import { headerProblem, MAX_HEADERS } from './headers.js';
import { SITE_PATTERN } from './policy.js';
import { splitWorkspaceId } from './spec.js';

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], field: string, fallback: T): T => {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw invalid(field, `Pick one of ${allowed.join(', ')}.`);
  return v as T;
};
const bool = (v: unknown, field: string, fallback: boolean): boolean => {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw invalid(field, 'Must be on or off.');
  return v;
};
const num = (v: unknown, field: string, fallback: number, min: number, max: number, integer = true): number => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) throw invalid(field, `Use ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
  return n;
};

const MAX_SITES = 100;
function sites(v: unknown, field: string, fallback: string[]): string[] {
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v)) throw invalid(field, 'A list of sites.');
  if (v.length > MAX_SITES) throw invalid(field, `Use at most ${MAX_SITES} sites.`);
  const out = new Set<string>();
  for (const raw of v) {
    const site = typeof raw === 'string' ? raw.trim() : '';
    if (!site) continue;
    if (!SITE_PATTERN.test(site)) throw invalid(field, `“${String(raw).slice(0, 40)}” isn’t a site Chrome’s policy accepts: a host, host:port or a pattern with *.`);
    out.add(site);
  }
  return [...out];
}

/** The header rules (PRD §24): names only, each host one the pool allows. A rule is `{ hosts, name, secret }`; a value is never accepted. */
function headerRules(v: unknown, allowedSites: string[], fallback: BrowserHeaderRule[]): BrowserHeaderRule[] {
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v)) throw invalid('headers', 'A list of headers.');
  if (v.length > MAX_HEADERS) throw invalid('headers', `Use at most ${MAX_HEADERS} headers.`);
  const out: BrowserHeaderRule[] = [];
  for (const raw of v) {
    if (!isObject(raw)) throw invalid('headers', 'Each header needs hosts, a name and a secret.');
    if (typeof raw.name !== 'string' || typeof raw.secret !== 'string' || !Array.isArray(raw.hosts) || raw.hosts.some((h) => typeof h !== 'string'))
      throw invalid('headers', 'Each header needs hosts, a name and the name of a secret.');
    if (raw.key !== undefined && raw.key !== null && typeof raw.key !== 'string') throw invalid('headers', 'A key is the name of a variable in an env-file entry.');
    const key = typeof raw.key === 'string' ? raw.key.trim() : undefined;
    // A blank key is refused, never dropped: dropping it would deliver the whole env-file entry (every variable in it) to the header's host.
    if (key === '') throw invalid('headers', 'A key can’t be blank: name the variable in the entry, or leave key out.');
    const rule: BrowserHeaderRule = { hosts: [...new Set((raw.hosts as string[]).map((h) => h.trim().toLowerCase()).filter(Boolean))], name: raw.name.trim(), secret: raw.secret.trim(), ...(key ? { key } : {}) };
    const problem = headerProblem(rule, allowedSites);
    if (problem) throw invalid('headers', problem);
    out.push(rule);
  }
  return out;
}

const RULES: readonly BrowserToolRule[] = ['default', 'ask', 'block'];
const TOOL_NAME = /^[a-z][a-z0-9_]{1,60}$/;
function toolRules(v: unknown, fallback: Record<string, BrowserToolRule>): Record<string, BrowserToolRule> {
  if (v === undefined || v === null) return fallback;
  if (!isObject(v)) throw invalid('toolRules', 'Tool rules are a list.');
  const entries = Object.entries(v);
  if (entries.length > 40) throw invalid('toolRules', 'Use at most 40 rules.');
  const out: Record<string, BrowserToolRule> = {};
  for (const [tool, rule] of entries) {
    if (!TOOL_NAME.test(tool)) throw invalid('toolRules', `“${tool.slice(0, 40)}” isn’t a tool name.`);
    if (typeof rule !== 'string' || !RULES.includes(rule as BrowserToolRule)) throw invalid('toolRules', `Rule for ${tool}: ask, block or default.`);
    out[tool] = rule as BrowserToolRule;
  }
  return out;
}

/** The workspace targets the browser can run on, and what the kind needs from the module around it. */
export interface BrowserKindDeps {
  /** Whether a target can host a browser container: Docker, and Kubernetes with a browser image set. */
  supports: (targetId: string) => boolean;
  /** Why this workspace can't have a browser assigned now (a cap, PRD §14.1), or null. */
  refuseAssign?: (workspaceId: string) => string | null;
}

/**
 * The `browser` pool kind (browser & desktop PRD §8, §9): a template for a workspace's browser, at most one per
 * workspace (`single`). The service delivers the plugin and the gate through the foundation (fragments), and
 * `BrowserService` makes the container match it.
 */
export class BrowserKind implements PoolKind<BrowserPoolContent> {
  readonly type = 'browser' as const;
  readonly single = true;
  /** After each successful reconcile (the container and the servers converge here). Set by BrowserService. */
  afterDelivery: (workspaceId: string, pools: AssignedPool<BrowserPoolContent>[], ctx: { running: boolean; now: Date }) => void = () => {};
  /** A workspace was removed. */
  forgotten: (workspaceId: string) => void = () => {};
  readonly #latest = new Map<string, AssignedPool<BrowserPoolContent>[]>();

  constructor(private readonly deps: BrowserKindDeps) {}

  parse(input: unknown, prev: BrowserPoolContent | null, _ctx?: ParseContext): BrowserPoolContent {
    if (!isObject(input)) throw invalid('content', 'Describe the browser.');
    const base = prev ?? BROWSER_POOL_DEFAULTS;
    const r = isObject(input.resources) ? input.resources : {};
    const tier = oneOf(input.tier, BROWSER_TIERS, 'tier', base.tier);
    // The desktop tier (browser PRD B4) is not built: a pool that asked for it would silently get the Browser tier.
    if (tier === 'desktop') throw invalid('tier', 'The desktop tier isn’t available yet.');
    const content: BrowserPoolContent = {
      tier,
      display: oneOf(input.display, BROWSER_DISPLAYS, 'display', base.display),
      profile: oneOf(input.profile, ['persistent', 'fresh'] as const, 'profile', base.profile),
      sessions: oneOf(input.sessions, ['shared', 'isolated'] as const, 'sessions', base.sessions),
      start: oneOf(input.start, ['first_use', 'with_workspace'] as const, 'start', base.start),
      idleMinutes: num(input.idleMinutes, 'idleMinutes', base.idleMinutes, 0, 24 * 60),
      resources: {
        cpus: num(r.cpus, 'resources.cpus', base.resources.cpus, 0.25, 8, false),
        memoryMb: num(r.memoryMb, 'resources.memoryMb', base.resources.memoryMb, 512, 16384),
        shmMb: num(r.shmMb, 'resources.shmMb', base.resources.shmMb, 64, 4096),
        pids: num(r.pids, 'resources.pids', base.resources.pids, 128, 8192),
      },
      downloads: bool(input.downloads, 'downloads', base.downloads),
      blockedSites: sites(input.blockedSites, 'blockedSites', base.blockedSites),
      allowlistMode: bool(input.allowlistMode, 'allowlistMode', base.allowlistMode),
      allowedSites: sites(input.allowedSites, 'allowedSites', base.allowedSites),
      headers: [],
      devtools: bool(input.devtools, 'devtools', base.devtools),
      vision: bool(input.vision, 'vision', base.vision),
      toolRules: toolRules(input.toolRules, base.toolRules),
      liveView: bool(input.liveView, 'liveView', base.liveView),
      proxyView: bool(input.proxyView, 'proxyView', base.proxyView),
      takeOver: bool(input.takeOver, 'takeOver', base.takeOver),
      privateTakeOvers: bool(input.privateTakeOvers, 'privateTakeOvers', base.privateTakeOvers),
      requireSandbox: bool(input.requireSandbox, 'requireSandbox', base.requireSandbox),
    };
    // After the sites: each header's hosts must be allowed ones, also when only the sites changed (a site removed under a header).
    content.headers = headerRules(input.headers, content.allowedSites, base.headers ?? []);
    for (const r of content.headers) {
      const problem = headerProblem(r, content.allowedSites);
      if (problem) throw invalid('allowedSites', problem);
    }
    if (content.allowlistMode && content.allowedSites.length === 0) throw invalid('allowedSites', 'List the sites the browser may open, or turn allowlist mode off.');
    // No display, no VNC: the headless tier is watched through the proxy view only.
    if (content.tier === 'headless') content.liveView = false;
    if (content.tier === 'headless' && !content.proxyView) throw invalid('proxyView', 'The headless tier has no screen: its live view is the proxy view.');
    if (!content.liveView && !content.proxyView) content.takeOver = false;
    return content;
  }

  view(content: BrowserPoolContent): BrowserPoolContent {
    return content;
  }

  /** The browser container and the servers' install follow the files the engine just wrote. */
  delivered(workspaceId: string, ctx: { running: boolean; now: Date }): void {
    this.afterDelivery(workspaceId, this.#latest.get(workspaceId) ?? [], ctx);
  }

  fragments(assigned: AssignedPool<BrowserPoolContent>[], ctx: KindContext): Fragment[] {
    if (ctx.workspaceId) this.#latest.set(ctx.workspaceId, assigned);
    const first = assigned[0];
    if (!first) return [];
    return compileBrowser({ pool: first.pool, content: first.content }).fragments;
  }

  beforeAssign(workspaceId: string): void {
    const { target } = splitWorkspaceId(workspaceId);
    if (!this.deps.supports(target)) throw new AppError('CONFLICT', 'A browser runs on Docker targets, and on Kubernetes targets with a browser image set.');
    const refused = this.deps.refuseAssign?.(workspaceId);
    if (refused) throw new AppError('CONFLICT', refused);
  }

  /** The container goes once the engine has taken the files away (`delivered` then sees no pool). */
  beforeUnassign(workspaceId: string): string[] {
    return workspaceId ? ['The browser stops and its sign-ins are removed. Downloads stay in ~/Downloads.'] : [];
  }

  forgetWorkspace(workspaceId: string): void {
    this.#latest.delete(workspaceId);
    this.forgotten(workspaceId);
  }
}
