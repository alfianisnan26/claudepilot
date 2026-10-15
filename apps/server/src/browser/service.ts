import { AppError } from '@isnanme/core';
import {
  type BrowserAction,
  type BrowserControlRequest,
  type BrowserHandoffAnswer,
  type BrowserChromeState,
  type BrowserContainerState,
  type BrowserControl,
  type BrowserHandoff,
  type BrowserPoolContent,
  type BrowserState,
  type BrowserStatus,
  type BrowserTab,
  type McpMatcher,
} from '@portal/contracts';
import { redact } from '../chat/redact.js';
import type { WorkspaceSteps } from '../delivery/steps.js';
import type { AssignedPool } from '../pools/kinds.js';
import type { PoolService } from '../pools/service.js';
import type { Store } from '../store/store.js';
import { type Companions, type CompanionPlan, type ExecResult, type ExecStream } from './companion.js';
import { browserContainerState, hasBrowser, workspaceRunning, PENDING_ROLLBACK_MS, specIn, specOf, type KubeBrowsers, type KubePlan, type KubeWorkspace } from './kube.js';
import { browserMatchers, compileBrowser, LOCK_HASH } from './compile.js';
import { DEVICE_ID, deviceLabel, LEASE_TTL_S, Leases, refuse, type Lease } from './control.js';
import { headersFile, headersSpec, headersSummary, resolveHeaders, type ResolvedHeader, type SecretLookup } from './headers.js';
import type { BrowserKind } from './kind.js';
import { INSTALL_PATH } from './scripts.js';
import { companionName, sha256, splitWorkspaceId } from './spec.js';

/**
 * The browser pool at run time (browser & desktop PRD §10, §14.2): keeps each workspace's browser container
 * matching its pool, installs the pinned servers, and reads what the supervisor says about the browser. A
 * browser fault is recorded here and shown on the browser's own rows; it never reaches the workspace's status
 * or keeps it from starting (FR13).
 */

const TICK_MS = 30_000;
const STATUS_TTL_MS = 1_000;
/** A call within this long makes the browser "working" (PRD §15.5). */
const WORKING_MS = 90_000;
const INSTALL_RETRY_MS = 10 * 60_000;
const EVENT_KEEP_DAYS = 90;
/** Viewers per browser and in total (PRD §14.1 caps): the display's encoding costs CPU for each. */
export const VIEWERS_PER_BROWSER = 3;
export const VIEWERS_TOTAL = 20;

export interface BrowserServiceDeps {
  store: Store;
  pools: PoolService;
  kind: BrowserKind;
  steps: WorkspaceSteps;
  /** Docker targets that can host a browser, by target id. */
  companions: Map<string, Companions>;
  /** Kubernetes targets that can host a browser (a second container in the workspace's pod, PRD §10.2), by target id. */
  kube?: Map<string, KubeBrowsers>;
  /** How workspaces reach the portal (`PORTAL_INTERNAL_URL`): the browser's policy refuses it on Kubernetes. */
  internalUrl?: string;
  /** The portal's listening port, so the browser's policy can refuse reaching it from a workspace's network. */
  portalPort: number;
  /** Something about a browser changed: pages that show it load it again. */
  notify: () => void;
  /** Reads a Secrets & env secret by name, for the pool's request headers (PRD §24); without it every header is skipped. */
  secretByName?: SecretLookup;
}

/** What the supervisor answers to `cpb-ctl status` (images/browser/cpb/supervisor.mjs). */
export interface SupervisorStatus {
  protocol: number;
  bootId: string;
  tier: string;
  display: { width: number; height: number };
  sandbox: 'on' | 'off';
  chrome: { state: BrowserChromeState; pid: number | null; since: number; bootId: string | null; starts: number; crashes: number; error: string | null };
  vnc: { up: boolean; enabled: boolean };
  control: { held: boolean; holder?: string; label?: string; since?: number; leaseUntil?: number; private?: boolean };
  viewers: number;
  /** `at`: anything that keeps the browser awake; `toolAt`: the agent's last tool call. */
  activity: { at: number; toolAt: number; tool: string | null; session: string | null };
  sessions: number;
  idle: { minutes: number; stopAt: number | null };
  memory: { used: number; limit: number };
  handoffs: { id: string; reason: string; origin: string | null; session: string; state: BrowserHandoff['state']; requestedAt: number; resolvedAt: number | null; note: string }[];
  takeOver: boolean;
  private: boolean;
  tabs?: BrowserTab[];
}

interface InstanceRow {
  workspace_id: string;
  pool_id: string | null;
  revision: number | null;
  /** `restart_needed` (Kubernetes): the pod's template doesn't match the pool yet, and changing it restarts a running workspace. */
  container: BrowserContainerState | 'workspace_stopped' | 'restart_needed';
  sandbox: string | null;
  spec: string | null;
  image_id: string | null;
  restarts: number;
  last_error: string | null;
  wipe_profile: number;
  updated_at: string;
}

export class BrowserService {
  readonly #running = new Map<string, Promise<void>>();
  readonly #again = new Set<string>();
  readonly #cache = new Map<string, { at: number; value: Promise<SupervisorStatus | null> }>();
  readonly #portalHosts = new Map<string, string[]>();
  #stops: (() => void)[] = [];
  #timer: NodeJS.Timeout | undefined;
  /** Who has control (PRD §12.3). */
  readonly leases: Leases;
  readonly #viewers = new Map<string, number>();
  readonly #viewerTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: BrowserServiceDeps) {
    deps.kind.afterDelivery = (workspaceId, pools, ctx) => this.#afterDelivery(workspaceId, pools, ctx);
    deps.kind.forgotten = (workspaceId) => void this.removeFor(workspaceId, 'workspace removed');
    this.leases = new Leases({
      renew: async (id, lease) => void (await this.ctl(id, 'control', { on: true, holder: lease.device, label: lease.label, ttl: LEASE_TTL_S, ...(lease.private ? { private: true } : {}) })),
      holder: async (id) => {
        const s = await this.supervisor(id, { fresh: true });
        return s?.control.held ? (s.control.holder ?? null) : null;
      },
      ended: (id, lease, why) => {
        this.event(id, 'control_ended', { device: lease.label, why });
        this.deps.notify();
      },
    });
  }

  /* ---------- Life ---------- */

  start() {
    for (const comps of this.deps.companions.values()) {
      this.#stops.push(
        comps.watch((name, _event, role) => {
          // A workspace or its browser changed outside the portal's own calls (docker restart, a crash).
          const id = `${comps.targetId}/${name}`;
          if (role === 'workspace' || this.#assigned(id)) void this.converge(id, `docker ${role} event`);
        }),
      );
    }
    this.#timer = setInterval(() => void this.#tick(), TICK_MS);
    this.#timer.unref();
    this.leases.start();
    void this.#tick();
  }

  stop() {
    clearInterval(this.#timer);
    this.leases.stop();
    for (const s of this.#stops) s();
    this.#stops = [];
  }

  /** Every workspace with a browser pool, and every browser container that exists: converge them all. */
  async #tick() {
    // A frozen, locked or unreadable database has no browser tables to read (foundation PRD §6.5): the portal explains
    // itself and this does nothing, and a pass that fails is logged, never thrown.
    const { store } = this.deps;
    if (!store.writable || !store.deliveryAllowed) return;
    try {
      const ids = new Set(this.assignedWorkspaces());
      for (const [target, comps] of this.deps.companions) {
        if (!comps.available) continue;
        for (const name of await comps.list().catch(() => [])) ids.add(`${target}/${name}`);
      }
      for (const [target, kb] of this.deps.kube ?? []) {
        for (const name of await kb.list().catch(() => [])) ids.add(`${target}/${name}`);
      }
      for (const id of ids) void this.converge(id, 'timer');
      this.#prune();
    } catch (e) {
      console.error(`[browser] a pass failed: ${(e as Error).message}`);
    }
  }

  /** Workspaces that have a browser pool (assigned, or whose removal is still pending). */
  assignedWorkspaces(): string[] {
    const rows = this.deps.store.db?.prepare("SELECT DISTINCT workspace_id FROM assignments WHERE pool_type = 'browser'").all() as { workspace_id: string }[] | undefined;
    return (rows ?? []).map((r) => r.workspace_id);
  }

  #assigned(workspaceId: string): boolean {
    try {
      return !!this.deps.store.db?.prepare("SELECT 1 FROM assignments WHERE workspace_id = ? AND pool_type = 'browser'").get(workspaceId);
    } catch {
      return false; // no table to read: not assigned, as far as anyone can tell
    }
  }

  /** The servers this workspace's browser pool delivers, as the MCP lockdown must admit them (none without a pool). */
  matchers(workspaceId: string): McpMatcher[] {
    const a = this.deps.pools.assignedPools<BrowserPoolContent>(workspaceId, 'browser')[0];
    return a ? browserMatchers(a.content, compileBrowser({ pool: a.pool, content: a.content }).plugin.dir) : [];
  }

  /** Where a workspace's browser runs commands: its Docker companion or its pod's `browser` container. */
  #host(target: string): { exec(workspace: string, cmd: string[], opts?: { user?: string; stdin?: string; timeoutMs?: number }): Promise<ExecResult>; stream(workspace: string, cmd: string[]): Promise<ExecStream> } | undefined {
    return this.deps.companions.get(target) ?? this.deps.kube?.get(target);
  }

  /* ---------- Rows and events ---------- */

  #row(workspaceId: string): InstanceRow | undefined {
    return this.deps.store.db?.prepare('SELECT * FROM browser_instances WHERE workspace_id = ?').get(workspaceId) as InstanceRow | undefined;
  }

  #save(workspaceId: string, patch: Partial<Omit<InstanceRow, 'workspace_id' | 'updated_at'>>) {
    const db = this.deps.store.db;
    if (!db || !this.deps.store.writable) return;
    const before = this.#row(workspaceId);
    db.prepare('INSERT INTO browser_instances (workspace_id, updated_at) VALUES (?, ?) ON CONFLICT (workspace_id) DO NOTHING').run(workspaceId, new Date().toISOString());
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length)
      db.prepare(`UPDATE browser_instances SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE workspace_id = ?`).run(
        ...keys.map((k) => (patch[k] ?? null) as string | number | null),
        new Date().toISOString(),
        workspaceId,
      );
    const after = this.#row(workspaceId);
    if (before?.container !== after?.container || before?.last_error !== after?.last_error) this.deps.notify();
  }

  /** §16 event log: what happened and who did it, never keystrokes, clipboard text or frames. */
  event(workspaceId: string, kind: string, details: Record<string, unknown> = {}) {
    const db = this.deps.store.db;
    if (!db || !this.deps.store.writable) return;
    db.prepare('INSERT INTO browser_events (at, workspace_id, kind, details) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), workspaceId, kind, JSON.stringify(details));
  }

  #prune() {
    const db = this.deps.store.db;
    if (!db || !this.deps.store.writable) return;
    db.prepare('DELETE FROM browser_events WHERE at < ?').run(new Date(Date.now() - EVENT_KEEP_DAYS * 86_400_000).toISOString());
  }

  /* ---------- Converging ---------- */

  /** Makes the workspace's browser container match its pool. One run per workspace at a time; a request during one queues one more. */
  converge(workspaceId: string, why: string): Promise<void> {
    const running = this.#running.get(workspaceId);
    if (running) {
      this.#again.add(workspaceId);
      return running;
    }
    const p = this.#converge(workspaceId, why)
      .catch((e: unknown) => {
        // A browser fault never reaches the workspace (FR13): it is recorded on the browser's row.
        const message = redact((e as Error).message ?? String(e));
        console.error(`[browser] ${workspaceId}: ${message}`);
        this.#save(workspaceId, { container: 'error', last_error: message });
        this.event(workspaceId, 'error', { why, message });
      })
      .finally(() => {
        this.#running.delete(workspaceId);
        this.#cache.delete(workspaceId);
        if (this.#again.delete(workspaceId)) void this.converge(workspaceId, 'queued');
      });
    this.#running.set(workspaceId, p);
    return p;
  }

  async #plan(workspaceId: string, comps: Companions, a: AssignedPool<BrowserPoolContent>): Promise<CompanionPlan | { error: string }> {
    const { name } = splitWorkspaceId(workspaceId);
    const works = await comps.sandboxWorks();
    if (!works && a.content.requireSandbox) return { error: 'Chromium’s sandbox can’t start on this Docker target, and the pool requires it.' };
    return { workspace: name, poolId: a.pool.id, content: a.content, sandbox: works, portalHosts: await this.#portalHostsFor(comps), headers: this.#headers(workspaceId, a.content) };
  }

  /** What each workspace's headers last were (names, secret names, value versions, skips: never a value), so the audit has one row per change. */
  readonly #headersSeen = new Map<string, string>();

  /**
   * The pool's request headers with their values, read now (PRD §24): a secret that was removed or has no value is left out, so its header
   * stops at the next delivery. The audit names the headers, their secrets and hosts, and why one was skipped; never a value.
   */
  #headers(workspaceId: string, content: BrowserPoolContent): ResolvedHeader[] {
    const { entries, skipped } = resolveHeaders(content.headers, this.deps.secretByName);
    const summary = headersSummary(entries, skipped);
    const key = JSON.stringify([headersSpec(entries), skipped]);
    const seen = this.#headersSeen.get(workspaceId) ?? JSON.stringify([[], []]);
    if (key !== seen) {
      this.#headersSeen.set(workspaceId, key);
      this.event(workspaceId, 'headers', summary);
    }
    return entries;
  }

  /** Where the portal answers from a workspace's network, so the browser can refuse it (PRD §13 Network): the bridge gateway and the portal's port. */
  async #portalHostsFor(comps: Companions): Promise<string[]> {
    const known = this.#portalHosts.get(comps.targetId);
    if (known) return known;
    const gateway = await comps.gateway();
    const hosts = [`host.docker.internal:${this.deps.portalPort}`, ...(gateway ? [`${gateway}:${this.deps.portalPort}`] : [])];
    this.#portalHosts.set(comps.targetId, hosts);
    return hosts;
  }

  async #converge(workspaceId: string, why: string) {
    const { target, name } = splitWorkspaceId(workspaceId);
    const kb = this.deps.kube?.get(target);
    if (kb) return this.#convergeKube(workspaceId, name, why, kb);
    const comps = this.deps.companions.get(target);
    if (!comps || !comps.available) return;
    // A portal that doesn't trust its own state manages nothing (foundation §6.5), and none manages another portal's containers.
    if (this.deps.store.trust.state !== 'ok' || !this.deps.store.writable || !this.deps.store.portalId) return;
    const assigned = this.deps.pools.assignedPools<BrowserPoolContent>(workspaceId, 'browser')[0];
    const found = await comps.inspect(name);
    const foreign = !!found && found.portal !== this.deps.store.portalId;
    const existing = foreign ? null : found;
    const ws = await comps.workspace(name);
    const row = this.#row(workspaceId);
    if (foreign) {
      if (assigned) this.#save(workspaceId, { container: 'error', last_error: 'Another portal runs a browser for this workspace.', pool_id: assigned.pool.id, revision: assigned.pool.revision });
      return;
    }

    // Not assigned any more: the container goes, then the sign-ins (at once, or at the workspace's next start).
    if (!assigned) {
      if (existing) {
        await comps.remove(name);
        this.event(workspaceId, 'removed', { why });
        this.#save(workspaceId, { wipe_profile: 1 });
      }
      if (this.#row(workspaceId)?.wipe_profile && ws?.running) {
        if (await comps.wipeProfile(name)) {
          this.#save(workspaceId, { wipe_profile: 0 });
          this.event(workspaceId, 'profile_wiped', {});
        }
      }
      if (row || existing) this.#save(workspaceId, { container: 'none', pool_id: null, revision: null, last_error: null });
      return;
    }

    // The workspace is stopped or gone: a browser can't run in a namespace that isn't there.
    if (!ws || !ws.running) {
      if (existing?.running) {
        await comps.stop(name);
        this.event(workspaceId, 'stopped', { why: 'workspace stopped' });
      }
      this.#save(workspaceId, { container: 'workspace_stopped', pool_id: assigned.pool.id, revision: assigned.pool.revision });
      return;
    }

    const plan = await this.#plan(workspaceId, comps, assigned);
    if ('error' in plan) {
      if (existing?.running) await comps.stop(name);
      this.#save(workspaceId, { container: 'error', last_error: plan.error, pool_id: assigned.pool.id, revision: assigned.pool.revision });
      return;
    }
    const spec = await comps.specHash(plan);
    const base = { pool_id: assigned.pool.id, revision: assigned.pool.revision, sandbox: plan.sandbox ? 'on' : 'off', spec, last_error: null as string | null };

    const create = async (reason: string) => {
      this.#save(workspaceId, { ...base, container: 'starting' });
      await comps.prepareMounts(name);
      await comps.create(plan, ws.id, spec);
      await comps.start(name);
      this.#save(workspaceId, { ...base, container: 'running', image_id: await comps.imageId() });
      this.event(workspaceId, 'started', { why: reason, sandbox: base.sandbox, pool: assigned.pool.id, revision: assigned.pool.revision });
    };
    const recreate = async (reason: string) => {
      await comps.remove(name);
      await create(reason);
    };

    if (!existing) return create(why);
    if (existing.netns !== ws.id) return recreate('workspace was recreated');
    if (existing.spec !== spec) {
      // A changed pool or image applies once the browser is idle: never during control or a waiting handoff (PRD §10.3).
      if (!(await this.#idle(workspaceId))) {
        this.#save(workspaceId, { container: 'running', last_error: null });
        return;
      }
      return recreate('pool or image changed');
    }
    if (!existing.running) {
      await comps.start(name);
      this.#save(workspaceId, { ...base, container: 'running' });
      this.event(workspaceId, 'started', { why });
      return;
    }
    // Still running from before a restart of the workspace: its network namespace is gone (PRD §10.1 Convergence).
    if (Date.parse(existing.startedAt) < Date.parse(ws.startedAt)) {
      await comps.restart(name);
      this.#save(workspaceId, { ...base, container: 'running', restarts: (row?.restarts ?? 0) + 1 });
      this.event(workspaceId, 'restarted', { why: 'workspace restarted' });
      return;
    }
    this.#save(workspaceId, { container: 'running', last_error: null, pool_id: base.pool_id, revision: base.revision, sandbox: base.sandbox, spec });
  }

  /**
   * Kubernetes (PRD §10.2, §10.3, §14.1): the browser is a container in the workspace's pod template, so adding, changing or removing it
   * restarts the pod. The portal changes the template only while the workspace is stopped, which includes the moment before it starts
   * (`beforeStart`); a running workspace shows "Restart needed". Before adding it the pod must fit a node by requests; a pod that stays
   * unschedulable 5 minutes anyway gets its browser taken away again. A browser fault never reaches the workspace (FR13).
   */
  async #convergeKube(workspaceId: string, name: string, why: string, kb: KubeBrowsers) {
    if (this.deps.store.trust.state !== 'ok' || !this.deps.store.writable || !this.deps.store.portalId) return;
    const assigned = this.deps.pools.assignedPools<BrowserPoolContent>(workspaceId, 'browser')[0];
    const ws = await kb.workspace(name);
    const row = this.#row(workspaceId);
    if (!ws) {
      if (assigned) this.#save(workspaceId, { container: 'workspace_stopped', pool_id: assigned.pool.id, revision: assigned.pool.revision });
      return;
    }
    const template = ws.deployment.spec?.template;
    const has = hasBrowser(template);
    const stopped = ws.replicas === 0;
    // The template may change while no workspace container runs: stopped, about to start, or still coming up (a new workspace, its
    // pod waiting for an image or a node). Nothing can be lost then; a running one waits for its next start ("Restart needed").
    const quiet = stopped || !workspaceRunning(ws.pod);

    if (!assigned) {
      if (has && quiet) {
        await kb.setTemplate(ws, null);
        await kb.removeExtras(ws);
        this.event(workspaceId, 'removed', { why });
        this.#save(workspaceId, { wipe_profile: 1 });
      }
      // The sign-ins go once the browser is out of the pod and the workspace runs (its home volume is mounted there).
      if (!has && this.#row(workspaceId)?.wipe_profile && ws.pod?.status?.phase === 'Running' && (await kb.wipeProfile(name))) {
        this.#save(workspaceId, { wipe_profile: 0 });
        this.event(workspaceId, 'profile_wiped', {});
      }
      if (row) this.#save(workspaceId, has && !quiet ? { container: 'restart_needed', pool_id: null, revision: null, last_error: 'Restart the workspace to remove its browser.' } : { container: 'none', pool_id: null, revision: null, last_error: null });
      return;
    }

    const plan: KubePlan = { workspace: name, poolId: assigned.pool.id, content: assigned.content, portalHosts: this.#kubePortalHosts(), image: kb.image, headers: this.#headers(workspaceId, assigned.content) };
    const spec = specOf(plan, ws.deployment.metadata!.name!);
    const base = { pool_id: assigned.pool.id, revision: assigned.pool.revision };
    await kb.ensureConfigMap(ws, plan);
    await this.#deliverKubeHeaders(workspaceId, name, kb, ws, plan);
    await kb.ensureEgress(ws, name);
    // Refused for room at the last start: tried again at the next one (or when the pool changes, which is a new spec).
    if (row?.spec === `unfit:${spec}` && why !== 'workspace starting') return;

    const applied = specIn(template);
    if (applied !== spec && !quiet && !has) {
      this.#kubePending.delete(workspaceId);
      this.#save(workspaceId, { ...base, container: 'restart_needed', last_error: 'Restart the workspace to add its browser (its pod restarts).' });
      return;
    }
    // A running browser keeps working with what it was made from; the change waits for the workspace's next start, and says so.
    if (applied !== spec && !quiet) this.#kubePending.set(workspaceId, 'The browser changed: restart the workspace to apply it.');
    else this.#kubePending.delete(workspaceId);
    if (applied !== spec && quiet) {
      const fit = await kb.fit(ws, plan, name);
      if (fit && !fit.fits) {
        if (has) await kb.setTemplate(ws, null);
        this.#save(workspaceId, { ...base, container: 'error', spec: `unfit:${spec}`, last_error: fit.reason });
        this.event(workspaceId, 'unfit', { reason: fit.reason, need: fit.need, nodes: fit.nodes.map((n) => ({ node: n.node, free: n.free })) });
        return;
      }
      await kb.setTemplate(ws, plan);
      // The egress opt-out (PRD Q12) is audited with every template change that puts a browser in the pod.
      this.event(workspaceId, has ? 'changed' : 'added', { why, fit: fit?.reason ?? 'not checked: the portal may not read the nodes', egress: kb.egress.mode });
      this.#save(workspaceId, { ...base, container: stopped ? 'workspace_stopped' : 'starting', spec, last_error: null });
      return;
    }
    if (stopped) {
      this.#save(workspaceId, { ...base, container: 'workspace_stopped', spec, last_error: null });
      return;
    }
    const st = browserContainerState(ws.pod);
    if (st.pendingSince !== null && Date.now() - st.pendingSince > PENDING_ROLLBACK_MS) {
      await kb.setTemplate(ws, null);
      const message = `The pod stayed Pending 5 minutes with its browser${st.detail ? ` (${st.detail})` : ''}: it runs without it now.`;
      this.#save(workspaceId, { ...base, container: 'error', spec: `unfit:${spec}`, last_error: message.slice(0, 500) });
      this.event(workspaceId, 'rolled_back', { why: 'pending' });
      return;
    }
    if (st.restarts > (row?.restarts ?? 0) && row?.container === 'running') this.event(workspaceId, 'restarted', { why: 'container restarted', restarts: st.restarts });
    this.#save(workspaceId, { ...base, container: st.state, spec: applied, restarts: st.restarts, last_error: st.state === 'error' ? st.detail : null });
  }

  /** Per workspace, which pod and which content (a hash, never a value) the headers file in the browser container was last delivered for. */
  readonly #headersDelivered = new Map<string, string>();
  /** Workspaces whose headers file changed while Chrome may be running with the old one: Chrome is stopped once it is idle, and the next wake reads the file. */
  readonly #chromeStale = new Set<string>();

  /**
   * Headers on Kubernetes (PRD §24): written into the running browser container by exec whenever the pod or the content changed, with
   * the file removed when there are none, so a removed or rotated secret takes effect without a workspace restart. When the file changed,
   * Chrome is stopped as soon as nothing is using it; it starts again on the next call and rebuilds its extension from the new file. A
   * delivery that fails is audited by its message (never a value) and tried again on the next pass; it never fails the convergence.
   */
  async #deliverKubeHeaders(workspaceId: string, name: string, kb: KubeBrowsers, ws: KubeWorkspace, plan: KubePlan) {
    if (!hasBrowser(ws.deployment.spec?.template) || !ws.pod) return;
    const headers = plan.headers ?? [];
    const key = `${ws.pod.metadata?.uid ?? ws.pod.metadata?.name ?? ''}:${sha256(headers.length ? headersFile(headers) : '')}`;
    try {
      if (this.#headersDelivered.get(workspaceId) !== key) {
        const r = await kb.deliverHeaders(name, headers);
        if (r) {
          this.#headersDelivered.set(workspaceId, key);
          if (r === 'changed') this.#chromeStale.add(workspaceId);
        }
      }
      if (this.#chromeStale.has(workspaceId) && (await this.#idle(workspaceId))) {
        await kb.exec(name, ['cpb-ctl', 'chrome', '--action', 'stop']);
        this.#chromeStale.delete(workspaceId);
        this.event(workspaceId, 'headers_applied', { count: headers.length });
      }
    } catch (e) {
      this.event(workspaceId, 'headers_failed', { error: redact((e as Error).message).slice(0, 200) });
    }
  }

  /** Kubernetes workspaces whose running browser differs from its pool: applied at the next start (in memory; the next pass refills it). */
  readonly #kubePending = new Map<string, string>();

  /** What the browser refuses on Kubernetes: the portal as workspaces reach it (`cluster.local` is refused anyway). */
  #kubePortalHosts(): string[] {
    try {
      const u = this.deps.internalUrl ? new URL(this.deps.internalUrl) : null;
      return u ? [u.port ? `${u.hostname}:${u.port}` : u.hostname] : [];
    } catch {
      return [];
    }
  }

  /** A Kubernetes workspace is about to start: its pod template takes the browser (or loses it) now, while no pod runs. */
  async beforeStart(workspaceId: string): Promise<void> {
    const { target } = splitWorkspaceId(workspaceId);
    if (!this.deps.kube?.has(target)) return;
    await this.converge(workspaceId, 'workspace starting');
  }

  /** Nothing is using the browser: no one in control, no handoff waiting, no viewer, and no tool call for a minute. */
  async #idle(workspaceId: string): Promise<boolean> {
    const s = await this.supervisor(workspaceId, { fresh: true });
    if (!s || s.chrome.state !== 'up') return true;
    return !s.control.held && s.viewers === 0 && !s.handoffs.some((h) => h.state === 'waiting' || h.state === 'in_control') && Date.now() - s.activity.at > 60_000;
  }

  /** The workspace was removed (or its pool): stop and delete the container before anything else tries to remove the volume. */
  async removeFor(workspaceId: string, why: string) {
    const { target, name } = splitWorkspaceId(workspaceId);
    const comps = this.deps.companions.get(target);
    if (!comps?.available && !this.deps.kube?.has(target)) return;
    await this.#running.get(workspaceId)?.catch(() => undefined);
    try {
      // On Kubernetes the browser is in the pod, and its ConfigMap and egress policy are the Deployment's: they go with it.
      const found = comps ? await comps.inspect(name) : null;
      if (comps && found && found.portal === this.deps.store.portalId) {
        await comps.remove(name);
        this.event(workspaceId, 'removed', { why });
      }
    } catch (e) {
      console.error(`[browser] removing ${workspaceId}: ${(e as Error).message}`);
    }
    try {
      if (this.deps.store.writable) {
        this.deps.store.db?.prepare('DELETE FROM browser_instances WHERE workspace_id = ?').run(workspaceId);
        this.deps.store.db?.prepare('DELETE FROM browser_installs WHERE workspace_id = ?').run(workspaceId);
      }
    } catch (e) {
      console.error(`[browser] forgetting ${workspaceId}: ${(e as Error).message}`); // no tables to clear (a frozen database)
    }
    this.#cache.delete(workspaceId);
  }

  /** Stops the browser container before its workspace stops, so Chrome flushes its cookies (PRD §10.1). */
  async stopFor(workspaceId: string) {
    const { target, name } = splitWorkspaceId(workspaceId);
    const comps = this.deps.companions.get(target);
    if (!comps?.available) return;
    const info = await comps.inspect(name).catch(() => null);
    if (info?.running && info.portal === this.deps.store.portalId) await comps.stop(name).catch(() => undefined);
  }

  /* ---------- After a delivery: converge and install ---------- */

  #afterDelivery(workspaceId: string, pools: AssignedPool<BrowserPoolContent>[], ctx: { running: boolean }) {
    void this.converge(workspaceId, 'delivered');
    const first = pools[0];
    if (!first || !ctx.running) return;
    try {
      this.#ensureInstalled(workspaceId, first);
    } catch (e) {
      console.error(`[browser] installing the servers of ${workspaceId}: ${(e as Error).message}`);
    }
  }

  #ensureInstalled(workspaceId: string, a: AssignedPool<BrowserPoolContent>) {
    const db = this.deps.store.db;
    if (!db || !this.deps.store.writable) return;
    const row = db.prepare('SELECT * FROM browser_installs WHERE workspace_id = ?').get(workspaceId) as { lock_hash: string; state: string; updated_at: string } | undefined;
    if (row?.lock_hash === LOCK_HASH) {
      if (row.state === 'installed') return;
      if (row.state === 'installing' && Date.now() - Date.parse(row.updated_at) < 10 * 60_000) return;
      if (row.state === 'failed' && Date.now() - Date.parse(row.updated_at) < INSTALL_RETRY_MS) return;
    }
    const set = (state: 'installing' | 'installed' | 'failed', error: string | null) =>
      this.deps.store.writable &&
      db
        .prepare(
          `INSERT INTO browser_installs (workspace_id, lock_hash, state, error, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id) DO UPDATE SET lock_hash = excluded.lock_hash, state = excluded.state, error = excluded.error, updated_at = excluded.updated_at`,
        )
        .run(workspaceId, LOCK_HASH, state, error, new Date().toISOString());
    set('installing', null);
    const dir = compileBrowser({ pool: a.pool, content: a.content }).plugin.dir;
    this.deps.steps.enqueue(workspaceId, [
      {
        owner: 'browser',
        key: 'install',
        label: 'browser install',
        script: `/bin/sh ${INSTALL_PATH} ${dir}/npm`,
        timeoutMs: 300_000,
        done: (r) => {
          if (r.skipped) return void set('failed', r.skipped); // retried on a later delivery
          set(r.code === 0 ? 'installed' : 'failed', r.code === 0 ? null : (r.stderr || r.stdout || `exit ${r.code}`).trim().slice(-400));
          this.event(workspaceId, r.code === 0 ? 'installed' : 'install_failed', { ms: r.ms });
          this.deps.notify();
        },
      },
    ]);
  }

  /** "Retry installs" in the workspace's Configuration. */
  retryInstall(workspaceId: string) {
    this.deps.store.db?.prepare('DELETE FROM browser_installs WHERE workspace_id = ?').run(workspaceId);
    const a = this.deps.pools.assignedPools<BrowserPoolContent>(workspaceId, 'browser')[0];
    if (a) this.#ensureInstalled(workspaceId, a);
  }

  /* ---------- Talking to the supervisor ---------- */

  /** One `cpb-ctl` command in the workspace's browser container (uid 1001: the only user who can reach the control socket). */
  async ctl<T = unknown>(workspaceId: string, cmd: string, args: Record<string, string | number | boolean> = {}): Promise<T> {
    const { target, name } = splitWorkspaceId(workspaceId);
    const comps = this.#host(target);
    if (!comps) throw new AppError('NOT_FOUND', 'No browser on this target.');
    const flags = Object.entries(args).flatMap(([k, v]) => (v === false ? [] : v === true ? [`--${k}`] : [`--${k}`, String(v).slice(0, 400)]));
    const r = await comps.exec(name, ['cpb-ctl', cmd, ...flags], { timeoutMs: 40_000 });
    let out: { ok: boolean; result?: T; error?: string };
    try {
      out = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as typeof out;
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE', redact(r.stderr.trim() || 'The browser did not answer.'));
    }
    if (!out.ok) throw new AppError('CONFLICT', out.error ?? 'The browser refused.');
    return out.result as T;
  }

  /** The supervisor's status, shared for a second so several pages don't each run an `exec`. Null when the container isn't running. */
  async supervisor(workspaceId: string, opts: { fresh?: boolean } = {}): Promise<SupervisorStatus | null> {
    const hit = this.#cache.get(workspaceId);
    if (!opts.fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
    const value = this.ctl<SupervisorStatus>(workspaceId, 'status', { tabs: true }).catch(() => null);
    this.#cache.set(workspaceId, { at: Date.now(), value });
    void value
      .then((s) => {
        // The supervisor is the truth about control: adopt it after a restart, notice when it ended there.
        if (s) this.leases.reconcile(workspaceId, s.control.held ? { holder: s.control.holder ?? '', label: s.control.label ?? '', private: !!s.control.private } : null);
      })
      .catch((e: unknown) => console.error(`[browser] reading control of ${workspaceId}: ${(e as Error).message}`));
    return value;
  }

  /** Forget the supervisor's last answer: the next status reads a fresh one. */
  invalidate(workspaceId: string) {
    this.#cache.delete(workspaceId);
  }

  /* ---------- Status and actions ---------- */

  async status(workspaceId: string, view: { deviceId?: string; secure?: boolean } = {}): Promise<BrowserStatus> {
    const { target } = splitWorkspaceId(workspaceId);
    const comps = this.#host(target);
    const assigned = this.deps.pools.assignedPools<BrowserPoolContent>(workspaceId, 'browser')[0];
    const at = new Date().toISOString();
    const empty = (state: BrowserState, detail: string | null = null): BrowserStatus => ({
      workspaceId,
      pool: assigned ? { id: assigned.pool.id, name: assigned.pool.name, revision: assigned.pool.revision, tier: assigned.content.tier } : null,
      state,
      detail,
      container: 'none',
      chrome: null,
      sandbox: null,
      display: null,
      tabs: [],
      control: null,
      handoffs: [],
      viewers: 0,
      idleStopAt: null,
      memory: null,
      lastTool: null,
      views: { vnc: false, proxy: false },
      canTakeOver: false,
      takeOverBlocked: null,
      at,
    });
    if (!assigned || !comps) return empty('none');
    const row = this.#row(workspaceId);
    const container = containerOf(row);
    const base = { ...empty('starting'), container, sandbox: (row?.sandbox as 'on' | 'off' | null) ?? null };
    if (row?.container === 'workspace_stopped') return { ...base, state: 'workspace_stopped' };
    if (row?.container === 'restart_needed') return { ...base, state: 'restart_needed', detail: row.last_error };
    if (row?.container === 'error') return { ...base, state: 'error', detail: row.last_error };
    const sup = row?.container === 'running' ? await this.supervisor(workspaceId) : null;
    if (!sup) return { ...base, state: row?.container === 'running' ? 'error' : 'starting', detail: row?.container === 'running' ? 'The browser container isn’t answering yet.' : null };

    const c = assigned.content;
    const held = sup.control.held;
    const waiting = sup.handoffs.some((h) => h.state === 'waiting');
    const recent = sup.activity.toolAt > 0 && Date.now() - sup.activity.toolAt < WORKING_MS;
    const state: BrowserState =
      sup.chrome.state === 'error' || sup.chrome.state === 'crashed'
        ? 'error'
        : held
          ? 'in_control'
          : waiting
            ? 'needs_input'
            : sup.chrome.state === 'starting'
              ? 'starting'
              : sup.chrome.state === 'up'
                ? recent
                  ? 'working'
                  : 'ready'
                : 'asleep';
    const control: BrowserControl = {
      held,
      label: held ? (sup.control.label ?? null) : null,
      since: held && sup.control.since ? new Date(sup.control.since).toISOString() : null,
      leaseUntil: held && sup.control.leaseUntil ? new Date(sup.control.leaseUntil).toISOString() : null,
      private: !!(held && sup.control.private),
      mine: !!(held && view.deviceId && sup.control.holder === view.deviceId),
    };
    const secure = view.secure === true;
    const blocked = !c.takeOver ? 'Take-over is off for this browser.' : !secure ? 'Signing in needs HTTPS or localhost.' : null;
    const vnc = c.tier !== 'headless' && c.liveView && sup.vnc.up;
    return {
      ...base,
      state,
      detail: sup.chrome.error ?? this.#kubePending.get(workspaceId) ?? null,
      chrome: sup.chrome.state,
      sandbox: sup.sandbox,
      display: sup.display,
      tabs: sup.tabs ?? [],
      control,
      handoffs: sup.handoffs.map((h) => ({
        id: h.id,
        reason: redact(h.reason),
        origin: h.origin,
        state: h.state,
        requestedAt: new Date(h.requestedAt).toISOString(),
        resolvedAt: h.resolvedAt ? new Date(h.resolvedAt).toISOString() : null,
        note: redact(h.note),
      })),
      viewers: sup.viewers,
      idleStopAt: sup.idle.stopAt ? new Date(sup.idle.stopAt).toISOString() : null,
      memory: sup.memory.limit ? sup.memory : null,
      lastTool: sup.activity.tool ? { name: sup.activity.tool, at: new Date(sup.activity.toolAt).toISOString() } : null,
      views: { vnc, proxy: c.proxyView },
      canTakeOver: blocked === null,
      takeOverBlocked: blocked,
    };
  }

  async action(workspaceId: string, action: BrowserAction): Promise<void> {
    if (!this.#assigned(workspaceId)) throw new AppError('CONFLICT', 'This workspace has no browser.');
    const row = this.#row(workspaceId);
    if (row?.container !== 'running') throw new AppError('CONFLICT', 'The browser isn’t running: start the workspace first.');
    if (action === 'wake') await this.ctl(workspaceId, 'wake');
    else if (action === 'stop') {
      if ((await this.supervisor(workspaceId, { fresh: true }))?.control.held) throw new AppError('CONFLICT', 'Someone has control of the browser.');
      await this.ctl(workspaceId, 'chrome', { action: 'stop' });
    } else await this.ctl(workspaceId, 'chrome', { action: 'restart' });
    this.event(workspaceId, action === 'wake' ? 'woken' : action === 'stop' ? 'stopped' : 'restarted', { by: 'person' });
    this.#cache.delete(workspaceId);
    this.deps.notify();
  }

  /* ---------- Control and handoffs (PRD §12.3, §12.4) ---------- */

  /** Takes, renews or releases control for a device. Input needs a secure context (PRD §12.1), and the pool must allow take-over. */
  async setControl(workspaceId: string, req: Partial<BrowserControlRequest>, who: { secure: boolean; session: string }): Promise<BrowserControl> {
    const device = typeof req.deviceId === 'string' && DEVICE_ID.test(req.deviceId) ? req.deviceId : null;
    if (!device) throw new AppError('VALIDATION_FAILED', 'This device has no id.', { details: { deviceId: 'Missing.' } });
    const a = this.deps.pools.assignedPools<BrowserPoolContent>(workspaceId, 'browser')[0];
    if (!a) throw new AppError('CONFLICT', 'This workspace has no browser.');
    if (this.#row(workspaceId)?.container !== 'running') throw new AppError('CONFLICT', 'The browser isn’t running: start the workspace first.');
    const label = deviceLabel(req.label);
    const sup = await this.supervisor(workspaceId, { fresh: true });
    if (!sup) throw new AppError('SERVICE_UNAVAILABLE', 'The browser isn’t answering.');

    if (req.on === false) {
      if (!sup.control.held) return this.#controlOf(await this.supervisor(workspaceId, { fresh: true }), device);
      if (sup.control.holder !== device) refuse(`${sup.control.label ?? 'Another device'} has control.`);
      await this.ctl(workspaceId, 'control', { off: true });
      this.leases.clear(workspaceId);
      this.event(workspaceId, 'hand_back', { device: label, by: who.session });
    } else {
      if (!a.content.takeOver) refuse('Take-over is off for this browser.');
      if (!who.secure) refuse('Taking control needs HTTPS or localhost.');
      const held = sup.control.held ? sup.control.holder : null;
      if (held && held !== device && req.takeOver !== true) refuse(`${sup.control.label ?? 'Another device'} has control. Take over?`);
      // A handoff always hides the screen from other viewers (PRD §12.3 Private).
      const handoff = typeof req.handoffId === 'string' ? sup.handoffs.find((h) => h.id === req.handoffId && (h.state === 'waiting' || h.state === 'in_control')) : undefined;
      const priv = req.private === true || a.content.privateTakeOvers || !!handoff;
      await this.ctl(workspaceId, 'control', { on: true, holder: device, label, ttl: LEASE_TTL_S, ...(priv ? { private: true } : {}) });
      if (handoff && handoff.state === 'waiting') await this.ctl(workspaceId, 'handoff-answer', { id: handoff.id, state: 'in_control' });
      const first = held !== device;
      this.leases.set(workspaceId, { device, label, private: priv, handoffId: handoff?.id ?? null });
      if (first) this.event(workspaceId, held ? 'take_over' : 'take_control', { device: label, by: who.session, ...(held ? { from: sup.control.label ?? null } : {}) });
    }
    this.#cache.delete(workspaceId);
    this.deps.notify();
    return this.#controlOf(await this.supervisor(workspaceId, { fresh: true }), device);
  }

  #controlOf(sup: SupervisorStatus | null, device: string): BrowserControl {
    const held = !!sup?.control.held;
    return {
      held,
      label: held ? (sup!.control.label ?? null) : null,
      since: held && sup!.control.since ? new Date(sup!.control.since).toISOString() : null,
      leaseUntil: held && sup!.control.leaseUntil ? new Date(sup!.control.leaseUntil).toISOString() : null,
      private: !!(held && sup!.control.private),
      mine: held && sup!.control.holder === device,
    };
  }

  /** Answers a handoff: handed back (control ends with it), or declined. */
  async answerHandoff(workspaceId: string, id: string, answer: Partial<BrowserHandoffAnswer>, who: { device: string | null; session: string }): Promise<void> {
    if (answer.state !== 'handed_back' && answer.state !== 'declined') throw new AppError('VALIDATION_FAILED', 'Answer handed_back or declined.');
    const sup = await this.supervisor(workspaceId, { fresh: true });
    const h = sup?.handoffs.find((x) => x.id === id);
    if (!sup || !h) throw new AppError('NOT_FOUND', 'That request is gone.');
    const note = typeof answer.note === 'string' ? answer.note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (answer.state === 'handed_back' && sup.control.held && who.device && sup.control.holder === who.device) {
      await this.ctl(workspaceId, 'handoff-answer', { id, state: 'handed_back', ...(note ? { note } : {}) });
      await this.ctl(workspaceId, 'control', { off: true });
      this.leases.clear(workspaceId);
    } else {
      await this.ctl(workspaceId, 'handoff-answer', { id, state: answer.state, ...(note ? { note } : {}) });
    }
    // The note is the person's words to the agent: kept out of the log (it may hold anything), only that one was given.
    this.event(workspaceId, `handoff_${answer.state}`, { handoff: id, by: who.session, ...(note ? { note: true } : {}) });
    this.#cache.delete(workspaceId);
    this.deps.notify();
  }

  /** The role a device has in the live views: the holder of control drives, everyone else watches. */
  roleOf(workspaceId: string, device: string): 'controller' | 'viewer' {
    return this.leases.holderOf(workspaceId) === device ? 'controller' : 'viewer';
  }

  /** Whether other viewers must see nothing now: control is held privately (PRD §12.3 Private). */
  isPrivate(workspaceId: string): boolean {
    return !!this.leases.get(workspaceId)?.private;
  }

  /** Counts a viewer in, or refuses at the caps (PRD §14.1). The returned function counts it out. */
  openViewer(workspaceId: string): () => void {
    const here = this.#viewers.get(workspaceId) ?? 0;
    const total = [...this.#viewers.values()].reduce((a, b) => a + b, 0);
    if (here >= VIEWERS_PER_BROWSER) refuse(`${VIEWERS_PER_BROWSER} devices are watching. Close one to watch here.`);
    if (total >= VIEWERS_TOTAL) refuse('Too many live views are open. Close one to watch here.');
    this.#setViewers(workspaceId, here + 1);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.#setViewers(workspaceId, Math.max(0, (this.#viewers.get(workspaceId) ?? 1) - 1));
    };
  }

  viewerCount(workspaceId: string): number {
    return this.#viewers.get(workspaceId) ?? 0;
  }

  /** Tells the supervisor how many are watching (it keeps Chrome awake for them), after a second's quiet. */
  #setViewers(workspaceId: string, n: number) {
    if (n > 0) this.#viewers.set(workspaceId, n);
    else this.#viewers.delete(workspaceId);
    clearTimeout(this.#viewerTimers.get(workspaceId));
    const timer = setTimeout(() => {
      this.#viewerTimers.delete(workspaceId);
      void this.ctl(workspaceId, 'viewers', { n: this.#viewers.get(workspaceId) ?? 0 }).catch(() => undefined);
    }, 1000);
    timer.unref();
    this.#viewerTimers.set(workspaceId, timer);
  }

  /** The VNC bridge's end in the container, as a process with stdin and stdout (PRD §12.1). */
  async openVnc(workspaceId: string, role: 'viewer' | 'controller') {
    const { target, name } = splitWorkspaceId(workspaceId);
    const comps = this.#host(target);
    if (!comps) throw new AppError('NOT_FOUND', 'No browser on this target.');
    return comps.stream(name, ['cpb-vnc', role === 'controller' ? 'full' : 'view']);
  }

  /**
   * The proxy view's end in the container (PRD §22): wakes the browser (a viewer is a use), then runs `cpb-view`, the
   * helper that talks to Chrome over CDP and to the portal over a narrow protocol on stdio. One process per viewer.
   */
  async openView(workspaceId: string) {
    const { target, name } = splitWorkspaceId(workspaceId);
    const comps = this.#host(target);
    if (!comps) throw new AppError('NOT_FOUND', 'No browser on this target.');
    const a = this.deps.pools.assignedPools<BrowserPoolContent>(workspaceId, 'browser')[0];
    if (!a) throw new AppError('CONFLICT', 'This workspace has no browser.');
    if (!a.content.proxyView) throw new AppError('CONFLICT', 'The preview is off for this browser.');
    if (this.#row(workspaceId)?.container !== 'running') throw new AppError('CONFLICT', 'The browser isn’t running: start the workspace first.');
    await this.ctl(workspaceId, 'wake');
    this.#cache.delete(workspaceId);
    return comps.stream(name, ['cpb-view']);
  }

  /** What Configuration shows: the install and the container beside the pool's own status. */
  configuration(workspaceId: string): { container: BrowserContainerState; error: string | null; sandbox: string | null; install: { state: string; error: string | null } | null } {
    const row = this.#row(workspaceId);
    const install = this.deps.store.db?.prepare('SELECT state, error FROM browser_installs WHERE workspace_id = ?').get(workspaceId) as { state: string; error: string | null } | undefined;
    return {
      container: containerOf(row),
      error: row?.last_error ?? null,
      sandbox: row?.sandbox ?? null,
      install: install ? { state: install.state, error: install.error } : null,
    };
  }

  companionName = companionName;
}

/** The container as the wire says it: a stopped workspace's, or one waiting for a restart (Kubernetes), is stopped. */
function containerOf(row: InstanceRow | undefined): BrowserContainerState {
  if (!row) return 'none';
  return row.container === 'workspace_stopped' || row.container === 'restart_needed' ? 'stopped' : row.container;
}
