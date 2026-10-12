// Enrollment (docs/prd/targets-connect.md §10): the token an admin makes in the wizard, what it can do, and the exchange of one use of it for a
// node. A token is `cpen_` + 256 random bits, stored only as its SHA-256, single use (a cluster's up to 50), and revocable. `GET plan` and
// `GET manifest` (T4's routes) look it up without using it; `POST enroll` uses one use, in one transaction, so two enrolls racing for the last use
// cannot both win. A used-up token still answers `enroll/status` for 30 minutes so the installer can wait for "connected".
//
// Wrong tokens (unknown ones) count against the client address, ten in ten minutes, then 429. A token that exists but cannot be used (revoked,
// expired, used up) is refused with its own reason and does not count: it is a person's mistake, not a guess. No refusal, event or log line ever
// holds a token.

import { AppError } from '@isnanme/core';
import {
  CONNECT_PROTOCOL,
  CONNECT_ROLE,
  CONNECT_TOKEN_STATUS_GRACE_MINUTES,
  connectOriginProblem,
  connectTunnelUrl,
  isConnectToken,
  type ConnectEnrollment,
  type ConnectEnrollReason,
  type ConnectEnrollRequest,
  type ConnectEnrollResult,
  type ConnectEnrollStatus,
  type ConnectInstallOptions,
} from '@portal/contracts';
import type { RateLimiter } from '../rateLimit.js';
import { keyFingerprint, publicKeyProblem } from './tunnel/auth.js';
import { cleanHello, nodeNameOf } from './agentText.js';
import type { ConnectConfig } from './config.js';
import { agentActor, type ConnectEvents } from './events.js';
import type { ActorCtx, Registry } from './registry.js';
import type { EnrollmentLookup } from './seams.js';
import type { ConnectSettingsStore } from './settings.js';
import type { ConnectStore, EnrollmentRow, NodeSummary, TargetRow } from './store.js';
import { enrollmentState, generateToken, hashToken, newEnrollmentId, newNodeId, toEnrollment, tokenLast4 } from './tokens.js';
import { checkCell, checkMaxUses, checkOptions, checkTtl, invalid } from './validate.js';

export interface EnrollmentDeps {
  store: ConnectStore;
  registry: Registry;
  events: ConnectEvents;
  settings: ConnectSettingsStore;
  config: ConnectConfig;
  /** Wrong tokens per client address (the sign-in RateLimiter, `CONNECT_LIMITS.enrollFailures`). Shared with T4's routes so a wrong token counts once. */
  limiter: RateLimiter;
  portalId(): string | null;
  portalVersion: string;
  now?: () => Date;
}

const MESSAGES: Record<'token_invalid' | 'token_expired' | 'token_used' | 'token_revoked', string> = {
  token_invalid: 'That token isn’t valid.',
  token_expired: 'That token has expired. Make a new command.',
  token_used: 'That token was already used.',
  token_revoked: 'That token was revoked.',
};

/** A refusal as the agent-facing routes answer it: a normal API error with `details.reason`. */
export function enrollRefusal(reason: ConnectEnrollReason, message: string, status: 'UNAUTHORIZED' | 'CONFLICT' | 'VALIDATION_FAILED' | 'SERVICE_UNAVAILABLE', extra: Record<string, unknown> = {}): AppError {
  return new AppError(status, message, { details: { reason, ...extra }, expose: true });
}

export class EnrollmentService implements EnrollmentLookup {
  #connected: (nodeId: string) => boolean = () => false;
  readonly #now: () => Date;

  constructor(private readonly d: EnrollmentDeps) {
    this.#now = d.now ?? (() => new Date());
  }

  /** Whether a node's tunnel is up (the hub): `enroll/status` says `connected` when it is. */
  useLive(isConnected: (nodeId: string) => boolean): void {
    this.#connected = isConnected;
  }

  // ---- admin side --------------------------------------------------------------------------------------------------------------------

  /**
   * A token for `target`. `req` is the wizard's: platform, options, lifetime, uses. Returns the secret once. A single that has a node refuses
   * (409 `target_enrolled`) until that node is revoked.
   */
  create(target: TargetRow, req: { platform?: unknown; options?: unknown; ttlMinutes?: unknown; maxUses?: unknown }, ctx: ActorCtx): { row: EnrollmentRow; enrollment: ConnectEnrollment; token: string } {
    const { platform } = checkCell(target.kind, req.platform);
    const asked = req.options && typeof req.options === 'object' && !Array.isArray(req.options) ? { ...(req.options as Record<string, unknown>) } : {};
    // The admin confirmed "a shell as the installing user" when the target was made; a later command for it does not ask again.
    if (target.kind === 'host' && asked.hostAccess === undefined && this.d.store.enrollments(target.id).some((e) => e.params.hostAccess === true)) asked.hostAccess = true;
    const options = this.#optionsFor(target, checkOptions(target.kind, platform, asked, !!this.d.config.caFile));
    const ttl = checkTtl(req.ttlMinutes, target.kind, this.d.settings.tokenTtlMinutes());
    const maxUses = checkMaxUses(req.maxUses, target.kind);
    return this.d.store.tx(() => {
      if (CONNECT_ROLE[target.kind] === 'single' && this.d.registry.liveNodes(target.id).length > 0) {
        throw enrollRefusal('target_enrolled', 'This single already has a node. Revoke it first to enroll another.', 'CONFLICT');
      }
      const now = this.#now();
      const token = generateToken();
      const row: Omit<EnrollmentRow, 'uses' | 'firstUsedAt' | 'lastUsedAt' | 'revokedAt'> = {
        id: newEnrollmentId(),
        targetId: target.id,
        tokenHash: hashToken(token),
        last4: tokenLast4(token),
        platform,
        params: options,
        maxUses,
        expiresAt: new Date(now.getTime() + ttl * 60_000).toISOString(),
        createdAt: now.toISOString(),
        createdBy: ctx.userId,
      };
      this.d.store.insertEnrollment(row);
      this.d.events.record({ type: 'enrollment.created', targetId: target.id, enrollmentId: row.id, actor: ctx.actor, ip: ctx.ip, detail: { platform, maxUses, ttlMinutes: ttl } });
      const stored = this.d.store.enrollment(row.id)!;
      return { row: stored, enrollment: toEnrollment(stored, now), token };
    });
  }

  /** The target's own settings fill what the request leaves out, so the plan agrees with the target (and a Kubernetes namespace never changes). */
  #optionsFor(target: TargetRow, options: ConnectInstallOptions): ConnectInstallOptions {
    const merged: ConnectInstallOptions = { ...options };
    if (target.kind === 'kubernetes') {
      merged.namespace = target.settings.namespace ?? merged.namespace;
      if (!merged.storageClass && target.settings.storageClass) merged.storageClass = target.settings.storageClass;
      if (!merged.storage && target.settings.storage) merged.storage = target.settings.storage;
    } else if (!merged.workspaceImage && target.settings.workspaceImage) merged.workspaceImage = target.settings.workspaceImage;
    return merged;
  }

  list(targetId: string): ConnectEnrollment[] {
    const now = this.#now();
    return this.d.store.enrollments(targetId).map((e) => toEnrollment(e, now));
  }

  /** THE enrollment resolver: one by id under a target (404 for another target's), so one authorization check can wrap it. */
  resolve(targetId: string, enrollmentId: string): EnrollmentRow {
    const e = this.d.store.enrollment(enrollmentId);
    if (!e || e.targetId !== targetId) throw new AppError('NOT_FOUND', 'That token doesn’t exist.');
    return e;
  }

  /** Revokes a token: it stops working at once. A node already enrolled with it is unaffected. */
  revoke(e: EnrollmentRow, ctx: ActorCtx): void {
    this.d.store.tx(() => {
      if (!this.d.store.revokeEnrollment(e.id, this.#now().toISOString())) return;
      this.d.events.record({ type: 'enrollment.revoked', targetId: e.targetId, enrollmentId: e.id, actor: ctx.actor, ip: ctx.ip, detail: { last4: e.last4 } });
    });
  }

  // ---- what T4's routes ask ----------------------------------------------------------------------------------------------------------

  #byToken(token: string): EnrollmentRow | null {
    if (!isConnectToken(token)) return null;
    return this.d.store.enrollmentByHash(hashToken(token));
  }

  lookup(token: string): { enrollment: ConnectEnrollment; target: ReturnType<Registry['record']>; options: ConnectInstallOptions; usable: boolean } | null {
    const row = this.#byToken(token);
    if (!row) return null;
    const target = this.d.registry.target(row.targetId);
    if (!target) return null;
    const now = this.#now();
    return { enrollment: toEnrollment(row, now), target: this.d.registry.record(target), options: row.params, usable: enrollmentState(row, now) === 'waiting' };
  }

  status(token: string): ConnectEnrollStatus | null {
    const row = this.#byToken(token);
    if (!row) return null;
    const now = this.#now();
    const state = enrollmentState(row, now);
    if (state === 'revoked') return { state: 'revoked' };
    if (row.uses === 0) return { state: state === 'expired' ? 'expired' : 'waiting' };
    // used at least once: a spent token answers for a while after its last use, a usable one (a cluster's) always does
    if (state !== 'waiting' && now.getTime() - Date.parse(row.lastUsedAt ?? row.createdAt) > CONNECT_TOKEN_STATUS_GRACE_MINUTES * 60_000) return null;
    const node = this.d.store.nodesOfEnrollment(row.id)[0];
    if (!node) return { state: state === 'expired' ? 'expired' : 'waiting' };
    if (node.revokedAt) return { state: 'revoked', node: node.id, target: node.targetId };
    return { state: this.#connected(node.id) ? 'connected' : 'enrolled', node: node.id, target: node.targetId };
  }

  // ---- POST /connect/v1/enroll ---------------------------------------------------------------------------------------------------------

  /**
   * One use of a token for a node. The agent hands over its PUBLIC key (the private half never leaves it). Refusals are `AppError`s whose
   * `details.reason` is one of `CONNECT_ENROLL_REASONS`. Only an unknown token counts against the address.
   */
  enroll(token: string | null, req: Partial<ConnectEnrollRequest> | null, ip: string | null): ConnectEnrollResult {
    const key = ip ?? 'unknown';
    if (this.d.limiter.blocked(key)) throw new AppError('RATE_LIMITED', 'Too many wrong tokens from this address. Wait a few minutes.', { details: { retryAfterS: 600 } });
    if (!this.d.store.canWrite) throw enrollRefusal('store_locked', 'The portal’s store is locked right now, so nothing can be enrolled. Try again shortly.', 'SERVICE_UNAVAILABLE');
    const found = token ? this.#byToken(token) : null;
    if (!found) {
      this.d.limiter.fail(key);
      this.d.events.record({ type: 'enrollment.rejected', actor: 'anonymous', ip, detail: { reason: 'token_invalid' } });
      throw enrollRefusal('token_invalid', MESSAGES.token_invalid, 'UNAUTHORIZED');
    }
    const reject = (reason: 'token_expired' | 'token_used' | 'token_revoked', row: EnrollmentRow): never => {
      this.d.events.record({ type: 'enrollment.rejected', targetId: row.targetId, enrollmentId: row.id, actor: 'anonymous', ip, detail: { reason, last4: row.last4 } });
      throw enrollRefusal(reason, MESSAGES[reason], 'UNAUTHORIZED');
    };
    const refuseUnusable = (row: EnrollmentRow): void => {
      const state = enrollmentState(row, this.#now());
      if (state === 'revoked') reject('token_revoked', row);
      if (state === 'used') reject('token_used', row);
      if (state === 'expired') reject('token_expired', row);
    };
    refuseUnusable(found);

    const body = req && typeof req === 'object' ? req : {};
    const keyProblem = publicKeyProblem(body.publicKey);
    if (keyProblem) throw enrollRefusal('bad_key', keyProblem, 'VALIDATION_FAILED', { publicKey: keyProblem });
    const hello = cleanHello(body.hello, this.#now());
    if (!hello) throw invalid({ hello: 'Say what the agent is (its mode).' });
    const publicKey = body.publicKey as string;
    if (body.nodeName !== undefined && typeof body.nodeName !== 'string') throw invalid({ nodeName: 'Text.' });

    const result = this.d.store.tx(() => {
      const row = this.d.store.enrollment(found.id);
      if (!row) throw enrollRefusal('token_invalid', MESSAGES.token_invalid, 'UNAUTHORIZED');
      refuseUnusable(row);
      const target = this.d.registry.target(row.targetId);
      if (!target) throw enrollRefusal('token_invalid', MESSAGES.token_invalid, 'UNAUTHORIZED');
      const urlProblem = connectOriginProblem(target.portalUrl, this.d.config.allowHttp);
      if (urlProblem) throw enrollRefusal('insecure_url', urlProblem, 'VALIDATION_FAILED', { portalUrl: urlProblem });
      if (hello.mode !== target.kind) throw invalid({ 'hello.mode': `This token is for a ${target.kind} target; the agent was installed as ${hello.mode}.` });
      if (CONNECT_ROLE[target.kind] === 'single' && this.d.registry.liveNodes(target.id).length > 0) {
        throw enrollRefusal('target_enrolled', 'This target already has a node. Revoke it in the portal first.', 'CONFLICT');
      }
      const name = this.d.store.freeNodeName(target.id, nodeNameOf(body.nodeName, hello.hostname, row.params.nodeName));
      if (!name) throw enrollRefusal('name_taken', 'Too many nodes share that name. Pick another with PILOT_NODE_NAME.', 'CONFLICT');
      const now = this.#now().toISOString();
      if (!this.d.store.useEnrollment(row.id, now)) {
        refuseUnusable(this.d.store.enrollment(row.id) ?? row);
        throw enrollRefusal('token_used', MESSAGES.token_used, 'UNAUTHORIZED'); // lost the race for the last use
      }
      const nodeId = newNodeId();
      const summary: NodeSummary = { hostname: hello.hostname, mode: hello.mode, runtime: hello.runtime, services: hello.services };
      if (hello.swarm) summary.swarm = hello.swarm;
      this.d.store.insertNode({
        id: nodeId,
        targetId: target.id,
        enrollmentId: row.id,
        name,
        publicKey,
        keyFingerprint: keyFingerprint(publicKey),
        agentVersion: hello.agentVersion,
        agentBuild: hello.agentBuild,
        protocol: hello.protocol,
        os: hello.os,
        arch: hello.arch,
        firstSeenAt: now,
        createdAt: now,
        createdBy: row.createdBy,
        info: summary,
      });
      this.d.registry.activate(target.id);
      const after = this.d.store.enrollment(row.id)!;
      this.d.events.record({ type: 'node.enrolled', targetId: target.id, nodeId, enrollmentId: row.id, actor: agentActor(nodeId), ip, detail: { name, mode: hello.mode, os: hello.os, arch: hello.arch, version: hello.agentVersion, build: hello.agentBuild, fingerprint: keyFingerprint(publicKey) } });
      this.d.events.record({ type: 'enrollment.used', targetId: target.id, nodeId, enrollmentId: row.id, actor: agentActor(nodeId), ip, detail: { uses: after.uses, maxUses: after.maxUses, last4: row.last4 } });
      return { nodeId, target };
    });
    this.d.registry.notifyChange({ what: 'node-added', targetId: result.target.id, nodeId: result.nodeId });
    return {
      node: result.nodeId,
      target: result.target.id,
      portalId: this.d.portalId(),
      portalVersion: this.d.portalVersion,
      tunnel: connectTunnelUrl(result.target.portalUrl),
      protocol: CONNECT_PROTOCOL,
    };
  }
}
