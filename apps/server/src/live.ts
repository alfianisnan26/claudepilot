import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  LIVE_PATH,
  LIVE_TOPICS,
  actorUserId,
  platformRef,
  type Actor,
  type LiveMessage,
  type LivePresence,
  type LiveTopic,
  type PlatformArea,
  type UserId,
  type Workspace,
  type WorkspaceUsage,
} from '@portal/contracts';
import { WebSocketServer, type WebSocket } from 'ws';
import { actorOfSocket, can, onAccessChange, visible } from './authz/seam.js';

const PING_MS = 25_000;
/** While a page shows workspaces: how often they're listed again, for changes made outside the portal (Kubernetes). */
const WORKSPACES_EVERY_MS = 5_000;
const USAGE_EVERY_MS = 5_000;
/** A burst of changes (a create's progress, a failover moving ten workspaces) becomes one push. */
const COALESCE_MS = 250;

export interface LiveSources {
  workspaces: () => Promise<Workspace[]>;
  usage: () => Promise<WorkspaceUsage[]>;
}

interface Client {
  /** Organizations slice 0 (P1): who opened it, read once at the handshake. Slice 2 (P5): everything it is sent is cut to this person. */
  actor: Actor;
  topics: Set<LiveTopic>;
  /** The workspace-list version this client last received. */
  seen: number;
  /** The workspace list as this client last received it (its own cut), to send again only when ITS cut changed. */
  lastWorkspaces: string | null;
}

/**
 * Organizations slice 2 (P5, organizations PRD §14 G9): the topics about the portal itself (Claude accounts and their usage, storage, pools,
 * the Claude Code pin, automatic moves, Connect targets) are told only to whoever may view that platform area. The others carry no data
 * (a nudge to load a page again, whose route filters by the person) or carry data the hub cuts per person (`workspaces`, `usage`).
 */
export const LIVE_TOPIC_AREA: Partial<Record<LiveTopic, PlatformArea>> = {
  accounts: 'usage',
  claudeusage: 'usage',
  autotransfer: 'usage',
  system: 'system',
  pools: 'settings',
  claudeversion: 'version',
  connect: 'targets',
};

/** Who may be told what, through the seam: the default of the hub. Tests may pass their own. */
export interface LiveAccess {
  /** Whether this person may hear of `topic` at all. */
  topic(actor: Actor, topic: LiveTopic): boolean;
  /** The workspaces (or their usage rows, by workspace id) this person may view. */
  workspaces<T extends { id: string }>(actor: Actor, rows: readonly T[]): T[];
}

export const seamLiveAccess: LiveAccess = {
  topic(actor, topic) {
    if (actor.kind === 'anonymous') return false;
    const area = LIVE_TOPIC_AREA[topic];
    return !area || can(actor, 'view', platformRef(area)).allow;
  },
  workspaces: (actor, rows) => (actor.kind === 'anonymous' ? [] : visible(actor, 'workspace', rows, (r) => r.id)),
};

/** Tabs with the same key see the same cut: one person, acting the same way (a socket is always a signed-in person). */
const personKey = (a: Actor): string => (a.kind === 'anonymous' ? '-' : a.kind === 'system' ? `system:${a.job}` : `${a.kind}:${a.userId}`);

/** Browsers send cookies on cross-site WebSocket handshakes, so the origin must be this host. */
function sameOrigin(req: IncomingMessage): boolean {
  try {
    return !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function refuse(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * The live socket (`/api/live`, one per tab): pushes the workspace list and usage while a page shows
 * them, and tells pages when accounts, pools or the portal's storage state change, so nothing polls.
 * Listing runs once for all tabs, only while someone watches, and a list goes out only when it changed.
 */
export class LiveHub {
  readonly #clients = new Map<WebSocket, Client>();
  readonly #coalesce = new Map<LiveTopic, NodeJS.Timeout>();
  #snapshot: { json: string; rows: Workspace[]; version: number; at: number } | null = null;
  #usage: { rows: WorkspaceUsage[]; at: number } | null = null;
  #listing: Promise<void> | null = null;
  #listAgain = false;
  #workspacesTimer: NodeJS.Timeout | undefined;
  #usageTimer: NodeJS.Timeout | undefined;
  #lastError = 0;
  /** A tab said it is visible and in use, or not (PWA PRD §11.2); `null` when its socket closed. `connection` is the socket, a key. */
  onPresence?: (connection: object, presence: LivePresence | null, req: IncomingMessage) => void;

  readonly #offAccess: () => void;

  constructor(
    private readonly sources: LiveSources,
    private readonly authorized: (req: IncomingMessage) => boolean,
    private readonly access: LiveAccess = seamLiveAccess,
  ) {
    // A right taken away (a share ended, an account disabled or removed from a workspace) is applied to that person's open tabs at once:
    // their workspace list is cut again and sent if it changed, and topics they may no longer hear of are dropped.
    this.#offAccess = onAccessChange((c) => this.#reconsider(c.userId));
  }

  attach(server: Server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== LIVE_PATH) return; // the terminal's, or Vite's
      if (!sameOrigin(req)) return refuse(socket, 403, 'Forbidden');
      if (!this.authorized(req)) return refuse(socket, 401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, (ws) => this.#join(ws, req));
    });
  }

  /** Who each open tab is (organizations slice 0), for tests and diagnostics. */
  actors(): Actor[] {
    return [...this.#clients.values()].map((c) => c.actor);
  }

  /**
   * Something changed. Workspaces are listed again (and pushed to each tab whose own cut differs); other topics tell pages to reload.
   * `to`: the people it concerns (a notification arrived for them), so nobody else's tab is told; absent, everyone who may hear of the topic.
   */
  publish(topic: LiveTopic, to?: readonly UserId[]): void {
    if (to) return this.#publishTo(topic, to);
    // Whatever was listed before this change is stale, even if nobody is watching right now.
    if (topic === 'workspaces' && this.#snapshot) this.#snapshot.at = 0;
    if (this.#coalesce.has(topic) || !this.#watched(topic)) return;
    this.#coalesce.set(
      topic,
      setTimeout(() => {
        this.#coalesce.delete(topic);
        if (topic === 'workspaces') void this.#refreshWorkspaces();
        else if (topic === 'accounts' || topic === 'system' || topic === 'pools' || topic === 'tickets' || topic === 'ci' || topic === 'claudeusage' || topic === 'repos' || topic === 'glance' || topic === 'claudeversion' || topic === 'notify' || topic === 'triggers' || topic === 'autotransfer' || topic === 'connect' || topic === 'attention' || topic === 'keepgoing') this.#send(topic, JSON.stringify({ type: topic } satisfies LiveMessage));
      }, COALESCE_MS).unref(),
    );
  }

  /** Open sockets, for tests and diagnostics. */
  get clients() {
    return this.#clients.size;
  }

  /** Whether some open page watches `topic`: a module that only pushes to pages can skip work while none does. */
  watching(topic: LiveTopic): boolean {
    return this.#watched(topic);
  }

  close() {
    this.#offAccess();
    for (const ws of this.#clients.keys()) ws.terminate();
    this.#clients.clear();
    this.#schedule();
    for (const t of this.#coalesce.values()) clearTimeout(t);
  }

  #join(ws: WebSocket, req: IncomingMessage) {
    const client: Client = { actor: actorOfSocket(req, this.authorized), topics: new Set(), seen: 0, lastWorkspaces: null };
    this.#clients.set(ws, client);
    let alive = true;
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, PING_MS);
    ws.on('pong', () => (alive = true));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: { type?: unknown; topics?: unknown };
      try {
        msg = JSON.parse(String(data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'presence') return this.#presence(ws, msg as Record<string, unknown>, req);
      if (msg.type !== 'subscribe' || !Array.isArray(msg.topics)) return;
      const before = client.topics;
      // A topic this person may not hear of is not subscribed at all (P5): asking for it is not an error, it just never comes.
      client.topics = new Set(LIVE_TOPICS.filter((t) => (msg.topics as unknown[]).includes(t) && this.access.topic(client.actor, t)));
      // A page that starts watching gets the current data at once (or as soon as it's listed).
      if (client.topics.has('workspaces') && !before.has('workspaces')) {
        client.seen = 0;
        client.lastWorkspaces = null;
        const fresh = this.#snapshot && Date.now() - this.#snapshot.at < WORKSPACES_EVERY_MS;
        if (fresh) this.#deliverWorkspaces();
        else void this.#refreshWorkspaces();
      }
      if (client.topics.has('usage') && !before.has('usage') && this.#usage && Date.now() - this.#usage.at < USAGE_EVERY_MS)
        ws.send(this.#usageFrame(client.actor, this.#usage.rows));
      this.#schedule();
    });
    ws.on('close', () => {
      clearInterval(ping);
      this.#clients.delete(ws);
      this.#schedule();
      this.#callPresence(ws, null, req);
    });
    ws.on('error', () => ws.terminate());
  }

  /** Only the four fields, each checked: nothing here is trusted for more than "this tab is in use". */
  #presence(ws: WebSocket, m: Record<string, unknown>, req: IncomingMessage) {
    const id = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null);
    if (typeof m.visible !== 'boolean' || typeof m.active !== 'boolean') return;
    this.#callPresence(ws, { type: 'presence', device: id(m.device, /^dst_[0-9a-f]{12}$/), visible: m.visible, active: m.active, session: id(m.session, /^[A-Za-z0-9_-]{1,100}$/) }, req);
  }

  #callPresence(ws: WebSocket, p: LivePresence | null, req: IncomingMessage) {
    try {
      this.onPresence?.(ws, p, req);
    } catch (e) {
      this.#logError('presence', e);
    }
  }

  #watched(topic: LiveTopic) {
    for (const c of this.#clients.values()) if (c.topics.has(topic)) return true;
    return false;
  }

  #send(topic: LiveTopic, frame: string) {
    for (const [ws, c] of this.#clients) if (c.topics.has(topic) && ws.readyState === ws.OPEN && this.access.topic(c.actor, topic)) ws.send(frame);
  }

  /** A nudge for named people only: their tabs that watch the topic. Not coalesced with everyone's (it is rare and small). */
  #publishTo(topic: LiveTopic, to: readonly UserId[]): void {
    if (topic === 'workspaces' || topic === 'usage') return this.publish(topic); // data topics are cut per person anyway
    const people = new Set<string>(to);
    const frame = JSON.stringify({ type: topic } satisfies LiveMessage);
    for (const [ws, c] of this.#clients) {
      const userId = actorUserId(c.actor);
      if (userId && people.has(userId) && c.topics.has(topic) && ws.readyState === ws.OPEN && this.access.topic(c.actor, topic)) ws.send(frame);
    }
  }

  /** A person's rights changed: drop what they may no longer hear of, and send their workspace list again if their cut changed. */
  #reconsider(userId: UserId) {
    let any = false;
    for (const c of this.#clients.values()) {
      if (actorUserId(c.actor) !== userId) continue;
      any = true;
      for (const t of [...c.topics]) if (!this.access.topic(c.actor, t)) c.topics.delete(t);
      c.seen = 0;
    }
    if (!any) return;
    this.#deliverWorkspaces();
    this.#schedule();
  }

  /** The usage frame for one person: only rows of workspaces they may view. */
  #usageFrame(actor: Actor, rows: readonly WorkspaceUsage[]): string {
    return JSON.stringify({ type: 'usage', data: this.access.workspaces(actor, rows) } satisfies LiveMessage);
  }

  /** Runs the listing and usage loops only while some page watches them. */
  #schedule() {
    const lists = this.#watched('workspaces');
    if (lists && !this.#workspacesTimer) {
      this.#workspacesTimer = setInterval(() => void this.#refreshWorkspaces(), WORKSPACES_EVERY_MS);
      this.#workspacesTimer.unref();
    } else if (!lists && this.#workspacesTimer) {
      clearInterval(this.#workspacesTimer);
      this.#workspacesTimer = undefined;
    }
    const usage = this.#watched('usage');
    if (usage && !this.#usageTimer) {
      this.#usageTimer = setInterval(() => void this.#refreshUsage(), USAGE_EVERY_MS);
      this.#usageTimer.unref();
      void this.#refreshUsage();
    } else if (!usage && this.#usageTimer) {
      clearInterval(this.#usageTimer);
      this.#usageTimer = undefined;
    }
  }

  /** One listing at a time; a change during one queues exactly one more. */
  #refreshWorkspaces(): Promise<void> {
    if (this.#listing) {
      this.#listAgain = true;
      return this.#listing;
    }
    if (!this.#watched('workspaces')) return Promise.resolve();
    this.#listing = (async () => {
      try {
        const rows = await this.sources.workspaces();
        const json = JSON.stringify(rows);
        if (json === this.#snapshot?.json) this.#snapshot.at = Date.now();
        else this.#snapshot = { json, rows, version: (this.#snapshot?.version ?? 0) + 1, at: Date.now() };
        this.#deliverWorkspaces();
      } catch (e) {
        this.#logError('listing workspaces', e);
      }
    })().finally(() => {
      this.#listing = null;
      if (this.#listAgain) {
        this.#listAgain = false;
        void this.#refreshWorkspaces();
      }
    });
    return this.#listing;
  }

  /**
   * Each tab gets ITS cut of the list (P5): the workspaces its person may view. The cut is made once per person per version (two tabs of
   * one person share it), and a tab is sent it only when it differs from what that tab last received.
   */
  #deliverWorkspaces() {
    const s = this.#snapshot;
    if (!s) return;
    const cuts = new Map<string, string>();
    for (const [ws, c] of this.#clients) {
      if (!c.topics.has('workspaces') || c.seen >= s.version || ws.readyState !== ws.OPEN) continue;
      const key = personKey(c.actor);
      let data = cuts.get(key);
      if (data === undefined) cuts.set(key, (data = JSON.stringify(this.access.workspaces(c.actor, s.rows))));
      c.seen = s.version;
      if (data === c.lastWorkspaces) continue;
      c.lastWorkspaces = data;
      ws.send(`{"type":"workspaces","data":${data}}`);
    }
  }

  async #refreshUsage() {
    try {
      const rows = await this.sources.usage();
      this.#usage = { rows, at: Date.now() };
      const cuts = new Map<string, string>();
      for (const [ws, c] of this.#clients) {
        if (!c.topics.has('usage') || ws.readyState !== ws.OPEN) continue;
        const key = personKey(c.actor);
        let frame = cuts.get(key);
        if (frame === undefined) cuts.set(key, (frame = this.#usageFrame(c.actor, rows)));
        ws.send(frame);
      }
    } catch (e) {
      this.#logError('reading usage', e);
    }
  }

  #logError(what: string, e: unknown) {
    if (Date.now() - this.#lastError < 60_000) return;
    this.#lastError = Date.now();
    console.error(`[live] ${what} failed: ${(e as Error).message}`);
  }
}
