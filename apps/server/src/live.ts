import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { LIVE_PATH, LIVE_TOPICS, type LiveMessage, type LivePresence, type LiveTopic, type Workspace, type WorkspaceUsage } from '@portal/contracts';
import { WebSocketServer, type WebSocket } from 'ws';

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
  topics: Set<LiveTopic>;
  /** The workspace-list version this client last received. */
  seen: number;
}

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
  #snapshot: { json: string; version: number; at: number } | null = null;
  #usage: { json: string; at: number } | null = null;
  #listing: Promise<void> | null = null;
  #listAgain = false;
  #workspacesTimer: NodeJS.Timeout | undefined;
  #usageTimer: NodeJS.Timeout | undefined;
  #lastError = 0;
  /** A tab said it is visible and in use, or not (PWA PRD §11.2); `null` when its socket closed. `connection` is the socket, a key. */
  onPresence?: (connection: object, presence: LivePresence | null, req: IncomingMessage) => void;

  constructor(
    private readonly sources: LiveSources,
    private readonly authorized: (req: IncomingMessage) => boolean,
  ) {}

  attach(server: Server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== LIVE_PATH) return; // the terminal's, or Vite's
      if (!sameOrigin(req)) return refuse(socket, 403, 'Forbidden');
      if (!this.authorized(req)) return refuse(socket, 401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, (ws) => this.#join(ws, req));
    });
  }

  /** Something changed. Workspaces are listed again (and pushed if different); other topics tell pages to reload. */
  publish(topic: LiveTopic) {
    // Whatever was listed before this change is stale, even if nobody is watching right now.
    if (topic === 'workspaces' && this.#snapshot) this.#snapshot.at = 0;
    if (this.#coalesce.has(topic) || !this.#watched(topic)) return;
    this.#coalesce.set(
      topic,
      setTimeout(() => {
        this.#coalesce.delete(topic);
        if (topic === 'workspaces') void this.#refreshWorkspaces();
        else if (topic === 'accounts' || topic === 'system' || topic === 'pools' || topic === 'tickets' || topic === 'ci' || topic === 'claudeusage' || topic === 'repos' || topic === 'glance' || topic === 'claudeversion' || topic === 'notify' || topic === 'triggers' || topic === 'autotransfer' || topic === 'connect') this.#send(topic, JSON.stringify({ type: topic } satisfies LiveMessage));
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
    for (const ws of this.#clients.keys()) ws.terminate();
    this.#clients.clear();
    this.#schedule();
    for (const t of this.#coalesce.values()) clearTimeout(t);
  }

  #join(ws: WebSocket, req: IncomingMessage) {
    const client: Client = { topics: new Set(), seen: 0 };
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
      client.topics = new Set(LIVE_TOPICS.filter((t) => (msg.topics as unknown[]).includes(t)));
      // A page that starts watching gets the current data at once (or as soon as it's listed).
      if (client.topics.has('workspaces') && !before.has('workspaces')) {
        client.seen = 0;
        const fresh = this.#snapshot && Date.now() - this.#snapshot.at < WORKSPACES_EVERY_MS;
        if (fresh) this.#deliverWorkspaces();
        else void this.#refreshWorkspaces();
      }
      if (client.topics.has('usage') && !before.has('usage') && this.#usage && Date.now() - this.#usage.at < USAGE_EVERY_MS)
        ws.send(this.#usage.json);
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
    for (const [ws, c] of this.#clients) if (c.topics.has(topic) && ws.readyState === ws.OPEN) ws.send(frame);
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
        const json = JSON.stringify(await this.sources.workspaces());
        if (json === this.#snapshot?.json) this.#snapshot.at = Date.now();
        else this.#snapshot = { json, version: (this.#snapshot?.version ?? 0) + 1, at: Date.now() };
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

  #deliverWorkspaces() {
    const s = this.#snapshot;
    if (!s) return;
    const frame = `{"type":"workspaces","data":${s.json}}`;
    for (const [ws, c] of this.#clients) {
      if (!c.topics.has('workspaces') || c.seen >= s.version || ws.readyState !== ws.OPEN) continue;
      ws.send(frame);
      c.seen = s.version;
    }
  }

  async #refreshUsage() {
    try {
      const json = JSON.stringify({ type: 'usage', data: await this.sources.usage() } satisfies LiveMessage);
      this.#usage = { json, at: Date.now() };
      this.#send('usage', json);
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
