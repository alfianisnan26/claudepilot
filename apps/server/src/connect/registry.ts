// The registry (docs/prd/targets-connect.md §8 FR1 to FR10, §14): enrolled targets and their nodes, joined with what the hub knows about each node
// right now (connected or not, the last status), and with the scanned targets the portal finds by itself. Targets, nodes and enrollments are
// platform-level resources an admin manages; every read of one by id goes through `target()`, `node()` or the enrollment service's `resolve()`,
// so one authorization check can wrap each (docs/prd/multi-user.md adoption rule 2).

import { AppError } from '@isnanme/core';
import {
  CONNECT_LIMITS,
  CONNECT_PROTOCOL_MIN,
  CONNECT_ROLE,
  CONNECT_RUNTIME_KIND,
  connectOriginProblem,
  type ConnectAgentHello,
  type ConnectDockerInfo,
  type ConnectHostUsage,
  type ConnectLink,
  type ConnectNodeView,
  type ConnectScannedView,
  type ConnectServiceStatus,
  type ConnectStatusMessage,
  type ConnectTargetRow,
  type ConnectTargetView,
  type CreateConnectTargetRequest,
  type UpdateConnectNodeRequest,
  type UpdateConnectTargetRequest,
  type Workspace,
  type WorkspaceTarget,
} from '@portal/contracts';
import { cleanText } from '../portalmcp/sanitize.js';
import type { ConnectConfig } from './config.js';
import { ConnectEvents } from './events.js';
import type { ConnectNodeRecord, ConnectTargetRecord } from './seams.js';
import type { ConnectSettingsStore } from './settings.js';
import type { ConnectStore, NodeRow, TargetRow } from './store.js';
import { enrollmentState, toEnrollment } from './tokens.js';
import { checkCell, checkId, checkLabel, checkOptions, checkSettingsPatch, initialSettings, invalid } from './validate.js';

/** Who is acting: the audit string (`user:u_owner`), the user id for `created_by`, and the client address. Never taken from a request body. */
export interface ActorCtx {
  actor: string;
  userId: string;
  ip: string | null;
}

/** What the hub knows about a node right now (it is not stored: a restart starts everything offline). */
export interface NodeLive {
  connected: boolean;
  connectedAt: string | null;
  hello: ConnectAgentHello | null;
  status: ConnectStatusMessage | null;
  rttMs: number | null;
  ip: string | null;
  clockSkewS: number | null;
}

export interface LiveSource {
  state(nodeId: string): NodeLive | null;
}

export type RegistryChange =
  | { what: 'target-added' | 'target-updated' | 'target-removed'; targetId: string }
  | { what: 'node-added' | 'node-updated' | 'node-revoked'; targetId: string; nodeId: string };

export interface RegistryDeps {
  store: ConnectStore;
  events: ConnectEvents;
  settings: ConnectSettingsStore;
  config: ConnectConfig;
  /** The ids of the targets the portal finds by itself (the Docker sockets, the kubeconfig, This machine). */
  scannedIds(): string[];
  /** The manager's targets that are not enrolled ones (for the list). */
  scanned(): Promise<WorkspaceTarget[]>;
  bundle(): { build: string; version: string };
  now?: () => Date;
}

/** Revoked nodes stay listed this long (the audit of what was revoked), then only the events remember them. */
const REVOKED_LISTED_DAYS = 30;

const protocolOf = (n: NodeRow, live: NodeLive | null): number | null => live?.hello?.protocol ?? n.protocol;

export class Registry {
  #live: LiveSource | null = null;
  readonly #listeners = new Set<(c: RegistryChange) => void>();
  readonly #now: () => Date;

  constructor(private readonly d: RegistryDeps) {
    this.#now = d.now ?? (() => new Date());
  }

  useLive(live: LiveSource): void {
    this.#live = live;
  }

  /** Fires after every change to the registry's own state (not for a node connecting: that is the hub's). */
  onChange(fn: (c: RegistryChange) => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  /** For the enrollment service: a node was added in its transaction. */
  notifyChange(c: RegistryChange): void {
    this.#emit(c);
  }

  #emit(c: RegistryChange): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(c);
      } catch (e) {
        console.error(`[connect] a registry listener failed: ${(e as Error).message}`);
      }
    }
  }

  // ---- the resolvers (every read by id goes through these) ----------------------------------------------------------------------------

  target(id: string): TargetRow | null {
    return this.d.store.target(id);
  }

  requireTarget(id: string): TargetRow {
    const t = this.target(id);
    if (!t) throw new AppError('NOT_FOUND', 'That target doesn’t exist.');
    return t;
  }

  node(id: string): NodeRow | null {
    return this.d.store.node(id);
  }

  requireNode(id: string): NodeRow {
    const n = this.node(id);
    if (!n) throw new AppError('NOT_FOUND', 'That node doesn’t exist.');
    return n;
  }

  targets(): TargetRow[] {
    return this.d.store.targets();
  }

  /** Nodes of a target that are not revoked. */
  liveNodes(targetId: string): NodeRow[] {
    return this.d.store.nodes(targetId).filter((n) => !n.revokedAt);
  }

  // ---- the seams' records ------------------------------------------------------------------------------------------------------------

  record(t: TargetRow): ConnectTargetRecord {
    return { id: t.id, label: t.label, kind: t.kind, portalUrl: t.portalUrl, settings: t.settings, active: t.state === 'active', isDefault: this.d.settings.defaultTarget() === t.id };
  }

  nodeRecord(n: NodeRow): ConnectNodeRecord {
    return { id: n.id, targetId: n.targetId, name: n.name, drained: n.drained, keyFingerprint: n.keyFingerprint };
  }

  // ---- making and changing targets --------------------------------------------------------------------------------------------------

  /**
   * A new pending target (the wizard's first step). `requestOrigin` is the address this request came on: the default portal address when no
   * explicit one is given and none is configured. Throws 422 with the fields at fault, 409 for a taken id or label, 503 when the store is locked.
   */
  createTarget(req: Partial<CreateConnectTargetRequest>, requestOrigin: string | null, ctx: ActorCtx): TargetRow {
    const { kind, platform } = checkCell(req.kind, req.platform);
    const id = checkId(req.id, this.d.scannedIds());
    const label = checkLabel(req.label, id);
    const options = checkOptions(kind, platform, req.options, !!this.d.config.caFile);
    const portalUrl = this.#portalUrl(req.portalUrl, requestOrigin);
    return this.d.store.tx(() => {
      if (this.d.store.target(id)) throw new AppError('CONFLICT', 'That name is taken.', { details: { id: 'That name is taken.' } });
      if (this.d.store.targetByLabel(label)) throw new AppError('CONFLICT', 'That label is taken.', { details: { label: 'That label is taken.' } });
      const at = this.#now().toISOString();
      this.d.store.insertTarget({ id, label, kind, state: 'pending', portalUrl, settings: initialSettings(kind, options), ownerId: ctx.userId, createdAt: at, createdBy: ctx.userId });
      this.d.events.record({ type: 'target.created', targetId: id, actor: ctx.actor, ip: ctx.ip, detail: { kind, platform, label } });
      return this.requireTarget(id);
    });
  }

  #portalUrl(explicit: unknown, requestOrigin: string | null): string {
    if (explicit !== undefined && explicit !== null && typeof explicit !== 'string') throw invalid({ portalUrl: 'An address.' });
    const chosen = (typeof explicit === 'string' && explicit.trim()) || this.d.settings.publicUrl()?.url || requestOrigin;
    if (!chosen) throw invalid({ portalUrl: 'Give the address the machine reaches the portal on.' });
    const url = chosen.trim().replace(/\/+$/, '');
    const problem = connectOriginProblem(url, this.d.config.allowHttp);
    if (problem) throw new AppError('VALIDATION_FAILED', problem, { details: { portalUrl: problem, reason: 'insecure_url' } });
    return url;
  }

  /** Label, settings and the default flag. The namespace is fixed (409). */
  updateTarget(id: string, req: UpdateConnectTargetRequest, ctx: ActorCtx): TargetRow {
    if (!req || typeof req !== 'object') throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
    const t = this.requireTarget(id);
    const patch: { label?: string; settings?: TargetRow['settings'] } = {};
    if (req.label !== undefined) patch.label = checkLabel(req.label, t.label);
    if (req.settings !== undefined) patch.settings = checkSettingsPatch(t.kind, t.settings, req.settings);
    if (req.default !== undefined && typeof req.default !== 'boolean') throw invalid({ default: 'true or false.' });
    const changed: string[] = [];
    this.d.store.tx(() => {
      if (patch.label !== undefined && patch.label !== t.label) {
        const clash = this.d.store.targetByLabel(patch.label);
        if (clash && clash.id !== id) throw new AppError('CONFLICT', 'That label is taken.', { details: { label: 'That label is taken.' } });
        changed.push('label');
      }
      if (patch.settings !== undefined && JSON.stringify(patch.settings) !== JSON.stringify(t.settings)) changed.push(...Object.keys(patch.settings).filter((k) => (patch.settings as Record<string, unknown>)[k] !== (t.settings as Record<string, unknown>)[k]).map((k) => `settings.${k}`));
      if (changed.length) this.d.store.updateTarget(id, { label: patch.label, settings: patch.settings }, this.#now().toISOString());
      if (req.default === true) (this.d.settings.setDefaultTarget(id), changed.push('default'));
      else if (req.default === false && this.d.settings.defaultTarget() === id) (this.d.settings.setDefaultTarget(null), changed.push('default'));
      if (changed.length) this.d.events.record({ type: 'target.updated', targetId: id, actor: ctx.actor, ip: ctx.ip, detail: { changed: changed.join(',') } });
    });
    if (changed.length) this.#emit({ what: 'target-updated', targetId: id });
    return this.requireTarget(id);
  }

  /** The target turns active when its first node enrolls (called inside the enrollment's transaction). */
  activate(id: string): void {
    this.d.store.updateTarget(id, { state: 'active' }, this.#now().toISOString());
  }

  /** A single's "switched on" flag (the Host runtime's start and stop): not an admin edit, so no audit row. */
  setRunning(id: string, on: boolean): void {
    const t = this.target(id);
    if (!t || t.settings.running === on) return;
    this.d.store.updateTarget(id, { settings: { ...t.settings, running: on } }, this.#now().toISOString());
  }

  /**
   * Forgets a target: its nodes (remembered, so an agent that comes back hears `target_removed`), its enrollments, its row. The caller has
   * already dealt with the workspaces and closed the tunnels. Returns the ids of the nodes it had.
   */
  forgetTarget(id: string, ctx: ActorCtx, how: { workspaces: 'none' | 'kept' | 'removed'; reason?: string }): string[] {
    const t = this.requireTarget(id);
    const nodeIds = this.d.store.nodes(id).filter((n) => !n.revokedAt).map((n) => n.id);
    this.d.store.tx(() => {
      this.d.settings.addTombstones(id, nodeIds);
      if (this.d.settings.defaultTarget() === id) this.d.settings.setDefaultTarget(null);
      this.d.store.deleteTarget(id);
      this.d.events.record({ type: 'target.removed', targetId: id, actor: ctx.actor, ip: ctx.ip, detail: { label: t.label, kind: t.kind, nodes: nodeIds.length, workspaces: how.workspaces, ...(how.reason ? { reason: how.reason } : {}) } });
    });
    this.#pendingSnap.delete(id);
    const timer = this.#snapTimers.get(id);
    if (timer) clearTimeout(timer);
    this.#snapTimers.delete(id);
    this.#emit({ what: 'target-removed', targetId: id });
    return nodeIds;
  }

  // ---- nodes -------------------------------------------------------------------------------------------------------------------------

  /** Renames and drains. A drained node takes no new workspaces; the running ones are untouched. */
  updateNode(id: string, req: UpdateConnectNodeRequest, ctx: ActorCtx): NodeRow {
    if (!req || typeof req !== 'object') throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
    const n = this.requireNode(id);
    if (n.revokedAt) throw new AppError('CONFLICT', 'That node was revoked.');
    let name: string | undefined;
    if (req.name !== undefined) {
      if (typeof req.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(req.name)) throw invalid({ name: 'Letters, digits, dots, dashes and underscores.' });
      name = req.name;
    }
    if (req.drained !== undefined && typeof req.drained !== 'boolean') throw invalid({ drained: 'true or false.' });
    this.d.store.tx(() => {
      if (name !== undefined && name.toLowerCase() !== n.name.toLowerCase()) {
        const taken = this.d.store.nodes(n.targetId).some((o) => o.id !== n.id && !o.revokedAt && o.name.toLowerCase() === name!.toLowerCase());
        if (taken) throw new AppError('CONFLICT', 'Another node has that name.', { details: { name: 'Another node has that name.' } });
      }
      const patch: { name?: string; drained?: boolean } = {};
      if (name !== undefined && name !== n.name) patch.name = name;
      if (req.drained !== undefined && req.drained !== n.drained) patch.drained = req.drained;
      if (!Object.keys(patch).length) return;
      this.d.store.updateNode(id, patch);
      if (patch.drained !== undefined) this.d.events.record({ type: 'node.drained', targetId: n.targetId, nodeId: id, actor: ctx.actor, ip: ctx.ip, detail: { drained: patch.drained } });
      if (patch.name !== undefined) this.d.events.record({ type: 'target.updated', targetId: n.targetId, nodeId: id, actor: ctx.actor, ip: ctx.ip, detail: { changed: 'node.name', name: patch.name } });
    });
    this.#emit({ what: 'node-updated', targetId: n.targetId, nodeId: id });
    return this.requireNode(id);
  }

  /** Marks a node revoked: its key never authenticates again. The caller closes its tunnel. A node already revoked is left as it was. */
  revokeNode(id: string, reason: string, ctx: ActorCtx): NodeRow {
    const n = this.requireNode(id);
    if (n.revokedAt) return n;
    const clean = cleanText(reason, 200);
    this.d.store.tx(() => {
      this.d.store.updateNode(id, { revokedAt: this.#now().toISOString(), revokedReason: clean });
      this.d.events.record({ type: 'node.revoked', targetId: n.targetId, nodeId: id, actor: ctx.actor, ip: ctx.ip, detail: { name: n.name, reason: clean } });
    });
    this.#emit({ what: 'node-revoked', targetId: n.targetId, nodeId: id });
    return this.requireNode(id);
  }

  // ---- what a person sees --------------------------------------------------------------------------------------------------------------

  nodeView(n: NodeRow): ConnectNodeView {
    const live = this.#live?.state(n.id) ?? null;
    const connected = !!live?.connected && !n.revokedAt;
    const hello = connected ? live!.hello : null;
    const status = connected ? live!.status : null;
    const bundle = this.d.bundle();
    const build = hello?.agentBuild ?? n.agentBuild;
    const protocol = protocolOf(n, connected ? live : null);
    const services: ConnectServiceStatus[] = status?.services ?? hello?.services ?? n.info.services ?? [];
    const usage: ConnectHostUsage | null = status?.usage ?? null;
    const docker: ConnectDockerInfo | null = status?.docker ?? null;
    return {
      id: n.id,
      targetId: n.targetId,
      name: n.name,
      state: n.revokedAt ? 'revoked' : 'enrolled',
      link: connected ? 'connected' : 'offline',
      connectedSince: connected ? live!.connectedAt : null,
      lastSeenAt: connected ? this.#now().toISOString() : n.lastSeenAt,
      lastSeenIp: live?.ip ?? n.lastIp,
      agentVersion: hello?.agentVersion ?? n.agentVersion,
      agentBuild: build,
      protocol,
      outdated: !n.revokedAt && !!build && build !== bundle.build,
      incompatible: !n.revokedAt && protocol !== null && protocol < CONNECT_PROTOCOL_MIN,
      os: hello?.os ?? n.os,
      arch: hello?.arch ?? n.arch,
      runtime: hello?.runtime ?? n.info.runtime ?? null,
      rttMs: connected ? live!.rttMs : null,
      drained: n.drained,
      clockSkewS: live?.clockSkewS ?? n.info.clockSkewS ?? null,
      services,
      usage,
      docker,
      swarm: status?.swarm ?? hello?.swarm ?? n.info.swarm ?? null,
      keyFingerprint: n.keyFingerprint,
      rotatedAt: n.rotatedAt,
      revokedAt: n.revokedAt,
      revokedReason: n.revokedReason,
      createdAt: n.createdAt,
    };
  }

  /** How many workspaces the target had when last listed (a single always has its one). */
  workspaceCount(t: TargetRow): number {
    if (CONNECT_ROLE[t.kind] === 'single') return t.state === 'active' ? 1 : 0;
    return this.lastSnapshot(t.id)?.workspaces.length ?? 0;
  }

  view(t: TargetRow): ConnectTargetView {
    const all = this.d.store.nodes(t.id);
    const cutoff = new Date(this.#now().getTime() - REVOKED_LISTED_DAYS * 86_400_000).toISOString();
    const views = all.filter((n) => !n.revokedAt || n.revokedAt >= cutoff).map((n) => this.nodeView(n));
    const live = views.filter((v) => v.state === 'enrolled');
    const connected = live.filter((v) => v.link === 'connected');
    const link: ConnectLink = t.state === 'pending' ? 'pending' : live.length > 0 && connected.length === live.length ? 'connected' : connected.length > 0 ? 'partial' : 'offline';
    const now = this.#now();
    const enrollment = this.d.store
      .enrollments(t.id)
      .filter((e) => enrollmentState(e, now) === 'waiting')
      .map((e) => toEnrollment(e, now))[0] ?? null;
    const view: ConnectTargetView = {
      source: 'enrolled',
      id: t.id,
      label: t.label,
      kind: t.kind,
      role: CONNECT_ROLE[t.kind],
      state: t.state,
      link,
      where: this.#where(t, connected),
      nodes: views,
      settings: t.settings,
      workspaces: this.workspaceCount(t),
      default: this.d.settings.defaultTarget() === t.id,
      enrollment,
      portalUrl: t.portalUrl,
      createdAt: t.createdAt,
      createdBy: t.createdBy,
    };
    const problem = this.#problem(t, link, live, connected);
    if (problem) view.problem = problem;
    return view;
  }

  /** `docker 28.1 · 2 nodes`, `kubernetes v1.30 / claudepilot-workspaces`, `lab-box (host)`. */
  #where(t: TargetRow, connected: ConnectNodeView[]): string {
    const all = this.d.store.nodes(t.id).filter((n) => !n.revokedAt);
    const first = connected.find((v) => v.docker) ?? connected[0] ?? (all[0] ? this.nodeView(all[0]) : null);
    const hostname = all[0]?.info.hostname ?? all[0]?.name ?? t.id;
    switch (t.kind) {
      case 'docker':
      case 'swarm': {
        const engine = first?.docker?.engine ?? all[0]?.info.engine;
        const n = all.length;
        return `${t.kind === 'swarm' ? 'swarm' : 'docker'}${engine ? ` ${engine.split('.').slice(0, 2).join('.')}` : ''}${n ? ` · ${n} node${n === 1 ? '' : 's'}` : ''}`;
      }
      case 'kubernetes': {
        const version = connected.flatMap((v) => v.services).find((s) => s.name === 'kube' && s.version)?.version ?? first?.services.find((s) => s.name === 'kube')?.version;
        return `kubernetes${version ? ` ${version}` : ''} / ${t.settings.namespace ?? 'claudepilot-workspaces'}`;
      }
      case 'container':
        return `${hostname} (container)`;
      case 'host':
        return `${hostname} (host)`;
    }
  }

  #problem(t: TargetRow, link: ConnectLink, live: ConnectNodeView[], connected: ConnectNodeView[]): string | undefined {
    if (link === 'pending') return 'No node has connected yet.';
    if (live.length === 0) return 'Every node was revoked. Enroll again.';
    if (link === 'offline') {
      const seen = live.map((v) => v.lastSeenAt).filter((x): x is string => !!x).sort().at(-1);
      return `No node is connected${seen ? `. Last seen ${seen}` : ''}.`;
    }
    if (link === 'partial') return `${connected.length} of ${live.length} nodes connected.`;
    const down = connected.flatMap((v) => v.services.filter((s) => !s.ok).map((s) => `${s.name}: ${s.error ?? 'not working'}`));
    if (down.length && connected.every((v) => v.services.some((s) => !s.ok))) return down[0];
    return undefined;
  }

  /** Scanned targets: what the portal finds by itself, read only, with the choice to hide the ones that are not there. */
  async scannedRows(): Promise<ConnectScannedView[]> {
    const hidden = new Set(this.d.settings.hiddenScanned());
    const enrolled = new Set(this.d.store.targets().map((t) => t.id));
    return (await this.d.scanned())
      .filter((t) => !enrolled.has(t.id))
      .map((t) => ({
        source: 'scanned' as const,
        id: t.id,
        label: t.label,
        kind: t.kind,
        where: t.where,
        available: t.available,
        ...(t.problem ? { problem: t.problem } : {}),
        hidden: hidden.has(t.id) && !t.available,
      }));
  }

  async list(): Promise<ConnectTargetRow[]> {
    const scanned = await this.scannedRows();
    return [...scanned, ...this.targets().map((t) => this.view(t))];
  }

  /** The runtime kind the rest of the portal sees for a target (a single is `local`). */
  runtimeKind(t: TargetRow) {
    return CONNECT_RUNTIME_KIND[t.kind];
  }

  // ---- snapshots (the last list of a target's workspaces) ----------------------------------------------------------------------------

  #savedAt = new Map<string, number>();
  /** The newest list of each target that is not in the database yet: the database is written at most every 10 seconds, memory is always current. */
  #pendingSnap = new Map<string, { list: Workspace[]; at: number }>();
  #snapTimers = new Map<string, NodeJS.Timeout>();

  /** Remembers the last list of a target's workspaces; the database copy is replaced at most every 10 seconds (and when the target drops). */
  saveSnapshot(targetId: string, list: Workspace[]): void {
    const now = this.#now().getTime();
    const wait = (this.#savedAt.get(targetId) ?? 0) + 10_000 - now;
    this.#pendingSnap.set(targetId, { list, at: now });
    if (wait <= 0) return this.flushSnapshot(targetId);
    if (this.#snapTimers.has(targetId)) return;
    const timer = setTimeout(() => {
      this.#snapTimers.delete(targetId);
      this.flushSnapshot(targetId);
    }, Math.min(wait, 10_000));
    timer.unref();
    this.#snapTimers.set(targetId, timer);
  }

  /** Writes the newest list to the database now (a tunnel dropped, or the portal is stopping). */
  flushSnapshot(targetId: string): void {
    const timer = this.#snapTimers.get(targetId);
    if (timer) clearTimeout(timer);
    this.#snapTimers.delete(targetId);
    const p = this.#pendingSnap.get(targetId);
    if (!p) return;
    this.#pendingSnap.delete(targetId);
    this.#savedAt.set(targetId, this.#now().getTime());
    if (this.d.store.target(targetId)) this.d.store.saveSnapshot(targetId, p.list, new Date(p.at).toISOString());
  }

  flushAllSnapshots(): void {
    for (const id of [...this.#pendingSnap.keys()]) this.flushSnapshot(id);
  }

  /** The last list of a target's workspaces: the newest in memory, else the database's. */
  lastSnapshot(targetId: string): { at: string; workspaces: Workspace[] } | null {
    const p = this.#pendingSnap.get(targetId);
    if (p) return { at: new Date(p.at).toISOString(), workspaces: p.list };
    const t = this.target(targetId);
    return t?.snapshot && t.snapshotAt ? { at: t.snapshotAt, workspaces: t.snapshot } : null;
  }

  // ---- housekeeping ------------------------------------------------------------------------------------------------------------------

  /** Removes pending targets nobody enrolled: 24 hours after their last token ran out. Returns the ids removed. */
  purgePending(): string[] {
    if (!this.d.store.canWrite) return [];
    const cutoff = new Date(this.#now().getTime() - CONNECT_LIMITS.pendingTargetHours * 3_600_000).toISOString();
    const ids = this.d.store.stalePendingTargets(cutoff);
    const ctx: ActorCtx = { actor: 'system', userId: 'u_owner', ip: null };
    for (const id of ids) {
      try {
        this.forgetTarget(id, ctx, { workspaces: 'none', reason: 'nobody enrolled' });
      } catch (e) {
        console.error(`[connect] could not remove the pending target ${id}: ${(e as Error).message}`);
      }
    }
    this.d.store.pruneOrphanEvents(new Date(this.#now().getTime() - 30 * 86_400_000).toISOString());
    return ids;
  }
}
