// The Codespaces POC service (docs/prd/codespaces-poc.md): GitHub connections (manual token or device flow), the real "connected" check, and
// the codespace lifecycle through the provider, each act gated by who may use the connection's token.
//
// WHO MAY USE A TOKEN (PRD §10, the multi-user rule): a connection is usable by the person who connected it. Anyone else only through an
// explicit share of the secret set that holds the token, decided by the authorization seam (`can(actor, 'operate', pool)`) once the real
// layer runs (multi-user mode); in today's single-owner mode there is nobody to share with, so it is the connector alone. Either way the
// seam must also allow `operate` on that set, so taking the set away takes the connection away. Agents and Portal MCP tokens never act
// with a GitHub token here: persons only (a POC decision, PRD §15 O3).
//
// Storage (PRD §9): the token is a sealed secret (vault.ts); this file keeps only metadata in `<data>/codespaces.json` (connections and the
// codespaces the portal attached), a few KB, owner-only file mode, written on change.

import { AppError, newId } from '@isnanme/core';
import {
  actorUserId,
  type Actor,
  type CodespaceBilling,
  type CodespaceCreateOptions,
  type CodespaceCreateRequest,
  type CodespaceRepo,
  type CodespaceView,
  type CodespacesStatus,
  type DeviceFlowView,
  type GitHubConnectRequest,
  type GitHubConnection,
  type GitHubConnectionCheck,
  type ObjectRef,
} from '@portal/contracts';
import { actorString, authzMode, can, requireCan } from '../authz/seam.js';
import { JsonFile } from '../jsonFile.js';
import type { AuditInput } from '../platform/audit.js';
import { DeviceFlows } from './device.js';
import { GitHubError, appErrorOf, tokenTypeOf, type GitHubClient } from './github.js';
import { CodespacesProvider, SETTLED, checkName, viewOf } from './provider.js';
import { TOKEN_ENTRY, type TokenVault } from './vault.js';

interface Attachment {
  connectionId: string;
  name: string;
  repo: string;
  attachedAt: string;
  by: string;
}

interface Doc {
  version: 1;
  connections: GitHubConnection[];
  attachments: Attachment[];
}

export interface CodespacesOptions {
  gh: GitHubClient;
  host: string;
  vault: TokenVault;
  dataFile: string;
  clientId: string | null;
  scopes: string[];
  audit?: (e: AuditInput) => void;
  now?: () => Date;
  /** Tests: shrinks the device flow's waits. */
  timeScale?: number;
}

const TOKEN_SHAPE = /^[\x21-\x7e]{20,255}$/;
const CACHE_MS = 3_000;
const MAX_CONNECTIONS_PER_USER = 5;

const BILLING: CodespaceBilling = {
  available: false,
  reason:
    'GitHub’s Codespaces API reports no cost or quota per codespace. Usage is billed to the billable owner; see GitHub’s billing settings.',
};

export class Codespaces {
  readonly provider: CodespacesProvider;
  readonly device: DeviceFlows;
  readonly #file: JsonFile<Doc>;
  #doc: Doc;
  readonly #now: () => Date;
  readonly #cache = new Map<string, { at: number; raw: Record<string, unknown> }>();

  constructor(private readonly opts: CodespacesOptions) {
    this.provider = new CodespacesProvider(opts.gh);
    this.#file = new JsonFile<Doc>(opts.dataFile, { version: 1, connections: [], attachments: [] });
    this.#doc = this.#file.read();
    this.#now = opts.now ?? (() => new Date());
    this.device = new DeviceFlows({
      gh: opts.gh,
      clientId: opts.clientId,
      scopes: opts.scopes,
      timeScale: opts.timeScale,
      now: () => this.#now().getTime(),
      onToken: async (ownerId, token, granted) => (await this.#connectToken(ownerId, 'device', token, null, granted)).id,
      audit: (kind, ownerId, detail) => this.#audit(kind, `user:${ownerId}`, ownerId, null, detail),
    });
  }

  stop() {
    this.device.stop();
  }

  /* ---------- Status and connections ---------- */

  status(actor: Actor): CodespacesStatus {
    const userId = person(actor);
    return {
      device: {
        available: this.device.available,
        reason: this.device.available ? null : 'PORTAL_GITHUB_CLIENT_ID is not set.',
        scopes: [...this.opts.scopes],
        host: this.opts.host,
      },
      connections: this.#doc.connections.filter((c) => this.#may(actor, c)).map((c) => this.#fresh(c)),
      pendingFlow: this.device.pendingFor(userId),
    };
  }

  async connect(actor: Actor, req: Partial<GitHubConnectRequest>): Promise<GitHubConnection> {
    const userId = person(actor);
    if (req?.host !== undefined && req.host !== this.opts.host) throw new AppError('VALIDATION_FAILED', `This portal connects to ${this.opts.host} only.`);
    if (req?.method === 'token') {
      const token = typeof req.token === 'string' ? req.token.trim() : '';
      if (!TOKEN_SHAPE.test(token)) throw new AppError('VALIDATION_FAILED', 'Paste the whole token.', { details: { token: 'Paste the whole token.' } });
      return this.#connectToken(userId, 'token', token, null, null);
    }
    if (req?.method === 'secret') {
      const poolId = typeof req.poolId === 'string' ? req.poolId : '';
      const entryName = typeof req.entryName === 'string' ? req.entryName : '';
      // Pointing at an existing secret is using it: the asker must be allowed to operate that set.
      requireCan(actor, 'operate', poolRef(poolId));
      const token = this.opts.vault.open(poolId, entryName);
      if (!token) throw new AppError('VALIDATION_FAILED', 'That secret has no value.', { details: { entryName: 'No value.' } });
      return this.#connectToken(userId, 'token', token, { poolId, entryName }, null);
    }
    throw new AppError('VALIDATION_FAILED', 'Choose a token or a secret.');
  }

  async check(actor: Actor, id: string): Promise<GitHubConnection> {
    const c = this.#use(actor, id);
    const token = this.#token(c);
    const found = await this.#probe(token);
    this.#update(c.id, (x) => {
      x.check = found.check;
      if (found.login) x.login = found.login;
      if (found.scopes !== undefined) x.scopes = found.scopes;
    });
    return this.#fresh(this.#get(c.id));
  }

  disconnect(actor: Actor, id: string, opts: { deleteSecret?: boolean } = {}): { secretDeleted: boolean } {
    const c = this.#use(actor, id);
    let secretDeleted = false;
    if (opts.deleteSecret) {
      if (!c.secret.madeHere) throw new AppError('CONFLICT', 'That secret was not made for this connection: delete it in Secrets & env.');
      this.opts.vault.remove(c.secret.poolId); // refuses (409) while a workspace has the set: nothing is forgotten then
      secretDeleted = true;
    }
    this.#doc.connections = this.#doc.connections.filter((x) => x.id !== id);
    this.#doc.attachments = this.#doc.attachments.filter((a) => a.connectionId !== id);
    this.#save();
    this.#audit('codespaces.disconnected', actorString(actor), person(actor), id, { secretDeleted });
    return { secretDeleted };
  }

  startDevice(actor: Actor): Promise<DeviceFlowView> {
    return this.device.start(person(actor));
  }
  deviceFlow(actor: Actor, flowId: string): DeviceFlowView {
    return this.device.get(flowId, person(actor));
  }
  cancelDevice(actor: Actor, flowId: string): DeviceFlowView {
    return this.device.cancel(flowId, person(actor));
  }

  /* ---------- Codespaces ---------- */

  async repos(actor: Actor, id: string, query: string | null): Promise<CodespaceRepo[]> {
    const c = this.#use(actor, id);
    return this.#gh(c, (t) => this.provider.repos(t, query));
  }

  async options(actor: Actor, id: string, repo: string, ref: string | null): Promise<CodespaceCreateOptions> {
    const c = this.#use(actor, id);
    return this.#gh(c, (t) => this.provider.options(t, repo, ref));
  }

  async list(actor: Actor, id: string): Promise<CodespaceView[]> {
    const c = this.#use(actor, id);
    const raw = await this.#gh(c, (t) => this.provider.list(t));
    const now = Date.now();
    for (const r of raw) if (typeof r.name === 'string') this.#cache.set(`${id}/${r.name}`, { at: now, raw: r });
    return raw.map((r) => viewOf(r, id, this.#attached(id, String(r.name ?? ''))));
  }

  async get(actor: Actor, id: string, name: string, opts: { fresh?: boolean } = {}): Promise<CodespaceView> {
    const c = this.#use(actor, id);
    checkName(name);
    const key = `${id}/${name}`;
    const hit = this.#cache.get(key);
    let raw = !opts.fresh && hit && Date.now() - hit.at < CACHE_MS ? hit.raw : null;
    if (!raw) {
      raw = await this.#gh(c, (t) => this.provider.get(t, name));
      this.#cache.set(key, { at: Date.now(), raw });
    }
    return viewOf(raw, id, this.#attached(id, name));
  }

  async create(actor: Actor, id: string, req: Partial<CodespaceCreateRequest>): Promise<CodespaceView> {
    const c = this.#use(actor, id);
    const raw = await this.#gh(c, (t) => this.provider.create(t, req));
    const view = viewOf(raw, id, true);
    if (!view.name) throw new AppError('SERVICE_UNAVAILABLE', 'GitHub did not say which codespace it made.');
    this.#attach(id, view.name, view.repo, actor);
    this.#audit('codespaces.created', actorString(actor), person(actor), view.name, { connection: id, repo: view.repo, machine: view.machine?.name ?? null });
    return { ...view, attached: true };
  }

  async start(actor: Actor, id: string, name: string): Promise<CodespaceView> {
    const c = this.#use(actor, id);
    const raw = await this.#gh(c, (t) => this.provider.start(t, name));
    this.#cache.delete(`${id}/${name}`);
    this.#audit('codespaces.started', actorString(actor), person(actor), name, { connection: id });
    return viewOf(raw, id, this.#attached(id, name));
  }

  async stopCodespace(actor: Actor, id: string, name: string): Promise<CodespaceView> {
    const c = this.#use(actor, id);
    const raw = await this.#gh(c, (t) => this.provider.stop(t, name));
    this.#cache.delete(`${id}/${name}`);
    this.#audit('codespaces.stopped', actorString(actor), person(actor), name, { connection: id });
    return viewOf(raw, id, this.#attached(id, name));
  }

  /** Deletes the codespace AT GITHUB (uncommitted work in it is lost). The person types its name to confirm. */
  async remove(actor: Actor, id: string, name: string, confirm: unknown): Promise<void> {
    const c = this.#use(actor, id);
    checkName(name);
    if (confirm !== name) throw new AppError('VALIDATION_FAILED', 'Type the codespace’s name to delete it.', { details: { confirm: 'Type its name.' } });
    await this.#gh(c, (t) => this.provider.remove(t, name));
    this.#cache.delete(`${id}/${name}`);
    this.#doc.attachments = this.#doc.attachments.filter((a) => !(a.connectionId === id && a.name === name));
    this.#save();
    this.#audit('codespaces.deleted', actorString(actor), person(actor), name, { connection: id });
  }

  /** Adopts a codespace that already exists at GitHub (made in the browser): the portal starts tracking it. */
  async attach(actor: Actor, id: string, name: string): Promise<CodespaceView> {
    const view = await this.get(actor, id, name, { fresh: true });
    this.#attach(id, name, view.repo, actor);
    return { ...view, attached: true };
  }

  /** Detach from the portal: the portal forgets it; the codespace stays at GitHub, untouched. */
  detach(actor: Actor, id: string, name: string): void {
    this.#use(actor, id);
    checkName(name);
    const before = this.#doc.attachments.length;
    this.#doc.attachments = this.#doc.attachments.filter((a) => !(a.connectionId === id && a.name === name));
    if (this.#doc.attachments.length === before) throw new AppError('NOT_FOUND', 'Not attached.');
    this.#save();
    this.#audit('codespaces.detached', actorString(actor), person(actor), name, { connection: id });
  }

  billing(actor: Actor, id: string): CodespaceBilling {
    this.#use(actor, id);
    return BILLING;
  }

  /**
   * Polls one codespace until it settles (running, stopped, error, removed) or `timeoutMs` passes; for K2's Start and create flows. Backs off
   * from 2 s to 15 s; the provider's 3 s cache keeps two callers from doubling the calls. Returns the last view either way.
   */
  async waitFor(actor: Actor, id: string, name: string, opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<CodespaceView> {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const until = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    let wait = 2_000;
    for (;;) {
      let view: CodespaceView;
      try {
        view = await this.get(actor, id, name, { fresh: true });
      } catch (e) {
        if (e instanceof AppError && e.code === 'NOT_FOUND') return { ...(await this.#gone(id, name)) };
        throw e;
      }
      if (SETTLED.has(view.phase) || Date.now() + wait > until) return view;
      await sleep(wait);
      wait = Math.min(wait * 1.5, 15_000);
    }
  }

  /** The attached codespaces of every connection the actor may use (what K2 turns into workspaces). */
  attached(actor: Actor): { connectionId: string; name: string; repo: string; attachedAt: string }[] {
    const usable = new Set(this.#doc.connections.filter((c) => this.#may(actor, c)).map((c) => c.id));
    return this.#doc.attachments.filter((a) => usable.has(a.connectionId)).map(({ connectionId, name, repo, attachedAt }) => ({ connectionId, name, repo, attachedAt }));
  }

  /* ---------- Inside ---------- */

  async #connectToken(ownerId: string, method: 'token' | 'device', token: string, into: { poolId: string; entryName: string } | null, granted: string[] | null): Promise<GitHubConnection> {
    if (this.#doc.connections.filter((c) => c.ownerId === ownerId).length >= MAX_CONNECTIONS_PER_USER)
      throw new AppError('LIMIT_REACHED', `At most ${MAX_CONNECTIONS_PER_USER} GitHub connections per person.`);
    const found = await this.#probe(token);
    if (found.check.state === 'invalid') throw new AppError('VALIDATION_FAILED', 'GitHub refused that token.', { details: { token: 'GitHub refused it.' } });
    if (found.check.state === 'unknown') throw new AppError('SERVICE_UNAVAILABLE', found.check.detail ?? 'GitHub could not check the token. Try again.');
    const login = found.login ?? 'unknown';
    // The same GitHub account connected again by the same person: the token goes into the same entry as a new version, no second connection.
    const again = this.#doc.connections.find((c) => c.ownerId === ownerId && c.login === login && c.host === this.opts.host);
    const target = into ?? (again ? { poolId: again.secret.poolId, entryName: again.secret.entryName } : null);
    const stored = into ? this.opts.vault.locate(into.poolId, into.entryName) : this.opts.vault.put(token, { login, into: target && this.opts.vault.locate(target.poolId, target.entryName) ? target : null });
    if (!stored) throw new AppError('NOT_FOUND', 'That secret is gone.');
    const madeHere = into ? false : again ? again.secret.madeHere : true;
    const conn: GitHubConnection = {
      id: again?.id ?? newId(),
      ownerId,
      method,
      host: this.opts.host,
      login: found.login,
      scopes: found.scopes ?? null,
      requestedScopes: method === 'device' ? [...this.opts.scopes] : null,
      tokenType: tokenTypeOf(token),
      secret: { ...stored, hint: null, madeHere }, // the hint is read fresh from the Secrets store (#fresh), never kept here
      check: found.check,
      connectedAt: this.#now().toISOString(),
    };
    if (granted && conn.scopes === null) conn.scopes = granted;
    this.#doc.connections = [...this.#doc.connections.filter((c) => c.id !== conn.id), conn];
    this.#save();
    this.#audit('codespaces.connected', `user:${ownerId}`, ownerId, conn.id, { method, login: conn.login, state: conn.check.state, tokenType: conn.tokenType, pool: stored.poolId });
    return this.#fresh(conn);
  }

  /** The real check (PRD §8.3): `GET /user` then `GET /user/codespaces?per_page=1`. Never throws. */
  async #probe(token: string): Promise<{ check: GitHubConnectionCheck; login: string | null; scopes?: string[] | null }> {
    const at = this.#now().toISOString();
    let login: string | null = null;
    let scopes: string[] | null = null;
    try {
      const me = await this.opts.gh.api<{ login?: unknown }>(token, 'GET', '/user');
      login = typeof me.body?.login === 'string' ? me.body.login.slice(0, 40) : null;
      const header = me.headers.get('x-oauth-scopes');
      scopes = header === null ? null : header.split(',').map((s) => s.trim()).filter(Boolean);
    } catch (e) {
      const s = e instanceof GitHubError ? e.status : 0;
      if (s === 401) return { check: { state: 'invalid', detail: 'GitHub refused the token. Connect again.', checkedAt: at }, login: null };
      return { check: { state: 'unknown', detail: e instanceof GitHubError ? e.message : 'GitHub could not be reached.', checkedAt: at }, login: null };
    }
    try {
      await this.opts.gh.api(token, 'GET', '/user/codespaces?per_page=1');
      return { check: { state: 'connected', detail: null, checkedAt: at }, login, scopes };
    } catch (e) {
      const s = e instanceof GitHubError ? e.status : 0;
      if (s === 401) return { check: { state: 'invalid', detail: 'GitHub refused the token. Connect again.', checkedAt: at }, login, scopes };
      if (s === 403 || s === 404)
        return {
          check: { state: 'limited', detail: 'Signed in, but it cannot list codespaces: add the Codespaces permission or the codespace scope.', checkedAt: at },
          login,
          scopes,
        };
      return { check: { state: 'unknown', detail: e instanceof GitHubError ? e.message : 'GitHub could not be reached.', checkedAt: at }, login, scopes };
    }
  }

  /** A connection the actor may use, or a 404 (no existence leak). Persons only. */
  #use(actor: Actor, id: string): GitHubConnection {
    person(actor);
    const c = this.#doc.connections.find((x) => x.id === id);
    if (!c || !this.#may(actor, c)) throw new AppError('NOT_FOUND', 'Not found.');
    return c;
  }

  #may(actor: Actor, c: GitHubConnection): boolean {
    if (actor.kind !== 'user') return false;
    if (!can(actor, 'operate', poolRef(c.secret.poolId)).allow) return false;
    return actor.userId === c.ownerId || authzMode() === 'multi-user';
  }

  #token(c: GitHubConnection): string {
    const t = this.opts.vault.open(c.secret.poolId, c.secret.entryName);
    if (!t) throw new AppError('CONFLICT', 'The token’s secret has no value any more. Connect again.');
    return t;
  }

  async #gh<T>(c: GitHubConnection, call: (token: string) => Promise<T>): Promise<T> {
    try {
      return await call(this.#token(c));
    } catch (e) {
      if (e instanceof GitHubError && e.status === 401)
        this.#update(c.id, (x) => (x.check = { state: 'invalid', detail: 'GitHub refused the token. Connect again.', checkedAt: this.#now().toISOString() }));
      throw appErrorOf(e);
    }
  }

  async #gone(id: string, name: string): Promise<CodespaceView> {
    return { ...viewOf({ name, state: 'Deleted' }, id, this.#attached(id, name)) };
  }

  /** The hint follows the secret (it changes on rotation); a deleted set leaves the connection without a token. */
  #fresh(c: GitHubConnection): GitHubConnection {
    const at = this.opts.vault.locate(c.secret.poolId, c.secret.entryName);
    if (!at) return { ...c, check: { state: 'invalid', detail: 'The token’s secret was deleted. Connect again.', checkedAt: c.check.checkedAt } };
    return { ...c, secret: { ...c.secret, poolName: at.poolName, hint: at.hint } };
  }

  #attached(id: string, name: string): boolean {
    return this.#doc.attachments.some((a) => a.connectionId === id && a.name === name);
  }

  #attach(id: string, name: string, repo: string, actor: Actor) {
    if (this.#attached(id, name)) return;
    this.#doc.attachments.push({ connectionId: id, name, repo, attachedAt: this.#now().toISOString(), by: person(actor) });
    this.#save();
    this.#audit('codespaces.attached', actorString(actor), person(actor), name, { connection: id, repo });
  }

  #get(id: string): GitHubConnection {
    const c = this.#doc.connections.find((x) => x.id === id);
    if (!c) throw new AppError('NOT_FOUND', 'Not found.');
    return c;
  }

  #update(id: string, change: (c: GitHubConnection) => void) {
    const c = this.#doc.connections.find((x) => x.id === id);
    if (!c) return;
    change(c);
    this.#save();
  }

  #save() {
    this.#file.write(this.#doc);
  }

  #audit(kind: string, actor: string, userId: string | null, subject: string | null, detail: Record<string, unknown>) {
    this.opts.audit?.({ kind, actor, userId, subject, detail });
  }
}

export const poolRef = (poolId: string): ObjectRef => ({ type: 'pool', id: poolId, poolType: 'secrets' });

/** The person asking; agents, tokens and anonymous callers are refused (PRD §10). */
function person(actor: Actor): string {
  if (actor.kind !== 'user') throw new AppError('FORBIDDEN', 'Only a person signed in to the portal can use a GitHub connection.');
  const id = actorUserId(actor);
  if (!id) throw new AppError('UNAUTHORIZED', 'Sign in again.');
  return id;
}

export { TOKEN_ENTRY };
