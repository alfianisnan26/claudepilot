// What the admin does in Connect (docs/prd/targets-connect.md §15, FR1 to FR10, FR16): one method per REST route, each taking WHO is asking (an Actor
// from the authorization seam, never an id from a body) and answering with the contract's shapes. Orchestration only: the registry holds the
// rows, the enrollment service the tokens, the hub the tunnels. Every read of a target by id is preceded by `requireCan` on that target.

import { AppError } from '@isnanme/core';
import {
  CONNECT_PLATFORMS,
  CONNECT_REMOVE_QUERY,
  CONNECT_ROLE,
  type ConnectEnrollment,
  type ConnectEnrollmentCreated,
  type ConnectEvent,
  type ConnectMaintenanceCommands,
  type ConnectNodeView,
  type ConnectPlatform,
  type ConnectPlanPreview,
  type ConnectRemoveBlocked,
  type ConnectScannedView,
  type ConnectSettings,
  type ConnectTargetRow,
  type ConnectTargetView,
  type CreateConnectEnrollmentRequest,
  type CreateConnectTargetRequest,
  type UpdateConnectNodeRequest,
  type UpdateConnectScannedRequest,
  type UpdateConnectSettingsRequest,
  type UpdateConnectTargetRequest,
  type Workspace,
} from '@portal/contracts';
import { OWNER_ID, actorString, actorUserId, requireCan, visible } from '../authz/seam.js';
import type { Actor } from '@portal/contracts';
import type { ConnectConfig } from './config.js';
import type { EnrollmentService } from './enrollment.js';
import type { ConnectEvents } from './events.js';
import type { Hub } from './hub.js';
import type { InstallPort } from './installPort.js';
import type { ActorCtx, Registry } from './registry.js';
import { ConnectError } from './seams.js';
import type { ConnectSettingsStore } from './settings.js';
import type { ConnectStore, EnrollmentRow, TargetRow } from './store.js';
import { toEnrollment } from './tokens.js';
import { invalid } from './validate.js';

/** What the HTTP layer knows about the request that the actor does not carry: the address, and the origin the browser is on (the default portal address). */
export interface RequestMeta {
  ip: string | null;
  origin: string | null;
}

export interface AdminDeps {
  store: ConnectStore;
  registry: Registry;
  enrollments: EnrollmentService;
  hub: Hub;
  events: ConnectEvents;
  settings: ConnectSettingsStore;
  config: ConnectConfig;
  install: InstallPort;
  bundle(): { build: string; sha256: string; version: string; source: string };
  scannedIds(): string[];
  /** The manager's list of one target's workspaces (last-known ones included). */
  workspacesOn(targetId: string): Promise<Workspace[]>;
  /** The manager's remove, with its hooks (a stop ends the workspace's chat sessions first). */
  removeWorkspace(workspaceId: string): Promise<void>;
  /** A fresh check of the target by the manager (the cached answer is dropped). */
  recheck?(targetId: string): Promise<void>;
  caPem(): string | null;
  now?: () => Date;
  notify(): void;
}

const targetRef = (id: string) => ({ type: 'target' as const, id });
const targetsArea = { type: 'platform' as const, id: 'targets' };

const ctxOf = (actor: Actor, ip: string | null): ActorCtx => ({ actor: actorString(actor), userId: actorUserId(actor) ?? OWNER_ID, ip });

export class ConnectAdmin {
  readonly #now: () => Date;

  constructor(private readonly d: AdminDeps) {
    this.#now = d.now ?? (() => new Date());
  }

  // ---- targets -------------------------------------------------------------------------------------------------------------------

  /** Scanned and enrolled targets in one list, each the actor may see. */
  async list(actor: Actor): Promise<ConnectTargetRow[]> {
    if (actor.kind === 'anonymous') throw new AppError('UNAUTHORIZED', 'Sign in again.'); // a list is filtered, never refused: nobody anonymous sees even an empty one
    return visible(actor, 'target', await this.d.registry.list(), (r) => r.id);
  }

  view(actor: Actor, id: string): ConnectTargetView {
    requireCan(actor, 'view', targetRef(id));
    return this.d.registry.view(this.d.registry.requireTarget(id));
  }

  /** The wizard's first step: a pending target and its first token, with the commands to paste. The token is in this reply and nowhere else. */
  create(actor: Actor, req: Partial<CreateConnectTargetRequest>, meta: RequestMeta): ConnectEnrollmentCreated {
    requireCan(actor, 'manage', targetsArea);
    this.#enabled();
    if (!req || typeof req !== 'object') throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
    const ctx = ctxOf(actor, meta.ip);
    const made = this.d.store.tx(() => {
      const target = this.d.registry.createTarget(req, meta.origin, ctx);
      return { target, ...this.d.enrollments.create(target, { platform: req.platform, options: req.options, ttlMinutes: req.ttlMinutes, maxUses: req.maxUses }, ctx) };
    });
    this.d.registry.notifyChange({ what: 'target-added', targetId: made.target.id });
    this.d.notify();
    return this.#created(made.target, made.row, made.enrollment, made.token);
  }

  update(actor: Actor, id: string, req: UpdateConnectTargetRequest, meta: RequestMeta): ConnectTargetView {
    requireCan(actor, 'manage', targetRef(id));
    const t = this.d.registry.updateTarget(id, req, ctxOf(actor, meta.ip));
    this.d.notify();
    return this.d.registry.view(t);
  }

  /**
   * Forgets a target (FR9): its tunnels are closed, its nodes revoked, its row removed. A target with workspaces answers 428 `CONFIRM_REQUIRED`
   * with `ConnectRemoveBlocked` until the request says what happens to them: `keep` (they stay on the host; the portal forgets them) or `remove`
   * (the portal removes them first; the target must be connected). Nothing on a host is deleted unless the person chose `remove`.
   */
  async remove(actor: Actor, id: string, workspaces: string | undefined, meta: RequestMeta): Promise<void> {
    requireCan(actor, 'manage', targetRef(id));
    const t = this.d.registry.requireTarget(id);
    if (workspaces !== undefined && workspaces !== 'keep' && workspaces !== 'remove') throw invalid({ [CONNECT_REMOVE_QUERY]: 'keep or remove.' });
    const list = CONNECT_ROLE[t.kind] === 'single' ? [] : await this.d.workspacesOn(id);
    const connected = this.d.registry.liveNodes(id).some((n) => this.d.hub.isConnected(n.id));
    if (list.length && !workspaces) {
      const blocked: ConnectRemoveBlocked = { workspaces: list.map((w) => w.id), connected };
      throw new AppError('CONFIRM_REQUIRED', 'This target has workspaces. Say whether to keep them on the host or remove them too.', { details: blocked });
    }
    if (workspaces === 'remove' && list.length) {
      if (!connected) throw new AppError('CONFLICT', 'The target must be connected to remove its workspaces. Keep them, or wait until a node is back.');
      for (const w of list) await this.d.removeWorkspace(w.id);
    }
    const ctx = ctxOf(actor, meta.ip);
    for (const n of this.d.registry.liveNodes(id)) await this.d.hub.disconnect(n.id, 'target_removed');
    this.d.registry.forgetTarget(id, ctx, { workspaces: list.length ? (workspaces === 'remove' ? 'removed' : 'kept') : 'none' });
    this.d.notify();
  }

  /** Asks the manager for a fresh check (not the cached answer), then answers with the registry's view. */
  async check(actor: Actor, id: string): Promise<ConnectTargetView> {
    requireCan(actor, 'view', targetRef(id));
    const t = this.d.registry.requireTarget(id);
    await this.d.recheck?.(id).catch(() => undefined);
    return this.d.registry.view(t);
  }

  // ---- tokens --------------------------------------------------------------------------------------------------------------------

  enrollments(actor: Actor, id: string): ConnectEnrollment[] {
    requireCan(actor, 'manage', targetRef(id));
    this.d.registry.requireTarget(id);
    return this.d.enrollments.list(id);
  }

  /** "Add node", "Command" or a replacement for a lost agent: another token for the same target. */
  createEnrollment(actor: Actor, id: string, req: Partial<CreateConnectEnrollmentRequest>, meta: RequestMeta): ConnectEnrollmentCreated {
    requireCan(actor, 'manage', targetRef(id));
    this.#enabled();
    const target = this.d.registry.requireTarget(id);
    if (!req || typeof req !== 'object') throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
    const made = this.d.enrollments.create(target, { platform: req.platform, options: req.options, ttlMinutes: req.ttlMinutes, maxUses: req.maxUses }, ctxOf(actor, meta.ip));
    this.d.notify();
    return this.#created(target, made.row, made.enrollment, made.token);
  }

  /**
   * The token-less commands (upgrade, uninstall, doctor) for a target: the Outdated chip needs no new token. The platform and the options
   * (sudo, private CA) are the target's latest token's unless the request names a platform.
   */
  maintenanceCommands(actor: Actor, id: string, platform: string | undefined): ConnectMaintenanceCommands {
    requireCan(actor, 'manage', targetRef(id));
    const target = this.d.registry.requireTarget(id);
    if (platform !== undefined && !(CONNECT_PLATFORMS as readonly string[]).includes(platform)) throw invalid({ platform: `One of ${CONNECT_PLATFORMS.join(', ')}.` });
    const latest = this.d.store.enrollments(id)[0];
    const { install: _install, verified: _verified, ...rest } = this.d.install.commands({
      portalUrl: target.portalUrl,
      token: '',
      kind: target.kind,
      platform: (platform as ConnectPlatform | undefined) ?? latest?.platform ?? 'linux',
      targetId: target.id,
      options: latest?.params,
      caPem: this.d.config.caFile ? this.d.caPem() : null,
    });
    return rest;
  }

  revokeEnrollment(actor: Actor, id: string, enrollmentId: string, meta: RequestMeta): void {
    requireCan(actor, 'manage', targetRef(id));
    this.d.registry.requireTarget(id);
    this.d.enrollments.revoke(this.d.enrollments.resolve(id, enrollmentId), ctxOf(actor, meta.ip));
    this.d.notify();
  }

  /** What the installer will do for this token, from the same code that builds its plan. No secret in it. */
  planPreview(actor: Actor, id: string, enrollmentId: string): ConnectPlanPreview {
    requireCan(actor, 'manage', targetRef(id));
    const target = this.d.registry.requireTarget(id);
    const row = this.d.enrollments.resolve(id, enrollmentId);
    return this.d.install.preview({
      enrollment: toEnrollment(row, this.#now()),
      target: this.d.registry.record(target),
      options: row.params,
      bundle: this.d.bundle(),
      config: this.#installConfig(),
    });
  }

  events(actor: Actor, id: string, q: { limit?: number; before?: number }): ConnectEvent[] {
    requireCan(actor, 'manage', targetRef(id));
    this.d.registry.requireTarget(id);
    return this.d.events.list(id, q);
  }

  // ---- nodes ---------------------------------------------------------------------------------------------------------------------

  /** A node's target, for the check: 404 for a node that is not there, the same 404 for one the actor may not see. */
  #nodeAndTarget(actor: Actor, nodeId: string) {
    requireCan(actor, 'manage', targetsArea);
    const node = this.d.registry.requireNode(nodeId);
    requireCan(actor, 'manage', targetRef(node.targetId));
    return node;
  }

  updateNode(actor: Actor, nodeId: string, req: UpdateConnectNodeRequest, meta: RequestMeta): ConnectNodeView {
    const node = this.#nodeAndTarget(actor, nodeId);
    const updated = this.d.registry.updateNode(node.id, req, ctxOf(actor, meta.ip));
    this.d.notify();
    return this.d.registry.nodeView(updated);
  }

  /** Revokes a node: its key never authenticates again and its tunnel closes at once (within two seconds); its host keeps its workspaces. */
  async revokeNode(actor: Actor, nodeId: string, meta: RequestMeta): Promise<void> {
    const node = this.#nodeAndTarget(actor, nodeId);
    this.d.registry.revokeNode(node.id, 'Revoked by an admin.', ctxOf(actor, meta.ip));
    await this.d.hub.disconnect(node.id, 'revoked');
    this.d.notify();
  }

  /** Asks the connected agent to rotate its key (409 when it is offline). The agent makes the new key and proves it with the old one. */
  async rotateNode(actor: Actor, nodeId: string): Promise<void> {
    const node = this.#nodeAndTarget(actor, nodeId);
    if (node.revokedAt) throw new AppError('CONFLICT', 'That node was revoked.');
    try {
      await this.d.hub.rotate(node.id);
    } catch (e) {
      if (e instanceof ConnectError && e.code === 'agent_offline') throw new AppError('CONFLICT', 'The node is offline. Rotate its key when it is connected.');
      throw e;
    }
  }

  // ---- scanned targets and settings ----------------------------------------------------------------------------------------------

  async updateScanned(actor: Actor, id: string, req: UpdateConnectScannedRequest): Promise<ConnectScannedView> {
    requireCan(actor, 'manage', targetsArea);
    if (!this.d.scannedIds().includes(id)) throw new AppError('NOT_FOUND', 'That target doesn’t exist.');
    if (!req || typeof req.hidden !== 'boolean') throw invalid({ hidden: 'true or false.' });
    this.d.settings.setHidden(id, req.hidden);
    this.d.notify();
    const row = (await this.d.registry.scannedRows()).find((r) => r.id === id);
    if (!row) throw new AppError('NOT_FOUND', 'That target doesn’t exist.');
    return row;
  }

  settings(actor: Actor): ConnectSettings {
    requireCan(actor, 'view', targetsArea);
    return this.d.settings.get();
  }

  updateSettings(actor: Actor, req: UpdateConnectSettingsRequest, meta: RequestMeta): ConnectSettings {
    requireCan(actor, 'manage', targetsArea);
    const s = this.d.settings.update(req, actorString(actor), meta.ip);
    this.d.notify();
    return s;
  }

  // ---- shared ----------------------------------------------------------------------------------------------------------------------

  /** Connect turned off (the kill switch): a token made now could never be used. */
  #enabled(): void {
    if (!this.d.config.enabled) throw new AppError('CONFLICT', 'Connect is turned off on this portal (PORTAL_CONNECT_ENABLED=false).');
  }

  #installConfig() {
    return { baseImage: this.d.config.baseImage, workspaceImage: this.d.config.workspaceImage, caPem: this.d.config.caFile ? this.d.caPem() : null, allowHttp: this.d.config.allowHttp };
  }

  #created(target: TargetRow, row: EnrollmentRow, enrollment: ConnectEnrollment, token: string): ConnectEnrollmentCreated {
    const commands = this.d.install.commands({
      portalUrl: target.portalUrl,
      token,
      kind: target.kind,
      platform: row.platform,
      targetId: target.id,
      options: row.params,
      caPem: this.d.config.caFile ? this.d.caPem() : null,
    });
    return { target: this.d.registry.view(this.d.registry.requireTarget(target.id)), enrollment, token, commands };
  }
}
