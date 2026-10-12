import { isAppError } from '@isnanme/core';
import type { BrowserTab, PreviewClientMessage, PreviewFrameHeader, PreviewServerEvent } from '@portal/contracts';
import type { WebSocket } from 'ws';
import type { ExecStream } from './companion.js';
import type { BrowserService } from './service.js';
import { CLOSE } from './view.js';

/**
 * One viewer of the proxy browser (browser PRD §22): a preview the portal renders itself, from the browser's own
 * screencast, instead of a VNC session. The page talks JSON (and receives JPEG frames) over a WebSocket; this
 * session turns what a viewer's role allows into the narrow messages `cpb-view` in the browser container
 * understands, and the container's events and frames back into what the page may see.
 *
 * What the portal holds to (the PRD's threat model for the proxy view):
 * - raw CDP never leaves the container: the vocabulary is `PreviewClientMessage`, validated here and again there;
 * - only the holder of control (over HTTPS or localhost) gets past `ping` and `quality`; everyone else watches;
 * - while control is Private other viewers get no frames at all (their socket closes with 4002);
 * - nothing is fetched by the portal: a navigation is the browser's own, and no frame, key, text or URL is stored or logged;
 * - input is rate-limited per socket, and a viewer too slow for the frames gets the newest one, never a backlog.
 */

/* ---------- Validation: the only things that become messages for the container ---------- */

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const int = (v: unknown, lo: number, hi: number): number | null => {
  const n = num(v, lo, hi);
  return n === null ? null : Math.round(n);
};
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Chrome's target ids: 32 hex digits, accepted a little wider so a version change doesn't break tabs. */
const TAB_ID = /^[A-Za-z0-9]{8,64}$/;
const text = (v: unknown, max: number, allowControl = false): string | null => (typeof v === 'string' && v.length <= max && (allowControl || !CONTROL_CHARS.test(v)) ? v : null);

/** A message from a viewer's page as the container may be told it, or null for anything else. */
export function validateClientMessage(raw: unknown): PreviewClientMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'ping':
      return { t: 'ping' };
    case 'back':
    case 'forward':
    case 'reload':
    case 'stop':
      return { t: m.t };
    case 'mouse': {
      if (m.a !== 'move' && m.a !== 'down' && m.a !== 'up' && m.a !== 'wheel') return null;
      const x = num(m.x, 0, 1);
      const y = num(m.y, 0, 1);
      const b = int(m.b ?? 0, 0, 2) as 0 | 1 | 2 | null;
      const cc = int(m.cc ?? 1, 1, 3);
      const dx = num(m.dx ?? 0, -4000, 4000);
      const dy = num(m.dy ?? 0, -4000, 4000);
      const mods = int(m.m ?? 0, 0, 15);
      if (x === null || y === null || b === null || cc === null || dx === null || dy === null || mods === null) return null;
      return { t: 'mouse', a: m.a, x, y, b, cc, dx, dy, m: mods };
    }
    case 'key': {
      if (m.a !== 'down' && m.a !== 'up') return null;
      const key = text(m.key, 32);
      const code = m.code === undefined ? '' : text(m.code, 32);
      const vk = int(m.vk ?? 0, 0, 255);
      const mods = int(m.m ?? 0, 0, 15);
      // The text a key types may be a control character (Enter types a carriage return).
      const t = m.text === undefined ? undefined : text(m.text, 8, true);
      if (!key || code === null || vk === null || mods === null || t === null) return null;
      return { t: 'key', a: m.a, key, code, vk, m: mods, ...(t ? { text: t } : {}) };
    }
    case 'text': {
      const t = text(m.text, 2000, true);
      return t ? { t: 'text', text: t } : null;
    }
    case 'go': {
      const url = text(m.url, 2048);
      return url ? { t: 'go', url } : null;
    }
    case 'newTab': {
      if (m.url === undefined) return { t: 'newTab' };
      const url = text(m.url, 2048);
      return url ? { t: 'newTab', url } : null;
    }
    case 'tab':
    case 'closeTab': {
      const id = typeof m.id === 'string' && TAB_ID.test(m.id) ? m.id : null;
      return id ? { t: m.t, id } : null;
    }
    case 'viewport': {
      if (m.reset === true) return { t: 'viewport', reset: true };
      const w = int(m.w, 100, 4096);
      const h = int(m.h, 100, 4096);
      const dpr = num(m.dpr ?? 1, 1, 4);
      if (w === null || h === null || dpr === null) return null;
      return { t: 'viewport', w, h, dpr, mobile: m.mobile === true };
    }
    case 'quality': {
      const q = int(m.q, 10, 95);
      const maxW = m.maxW === undefined ? undefined : int(m.maxW, 200, 3840);
      const fps = m.fps === undefined ? undefined : int(m.fps, 1, 30);
      if (q === null || maxW === null || fps === null) return null;
      return { t: 'quality', q, ...(maxW ? { maxW } : {}), ...(fps ? { fps } : {}) };
    }
    case 'dialog': {
      if (typeof m.accept !== 'boolean') return null;
      const t = m.text === undefined ? undefined : text(m.text, 2000, true);
      if (t === null) return null;
      return { t: 'dialog', accept: m.accept, ...(t !== undefined ? { text: t } : {}) };
    }
    default:
      return null;
  }
}

/** What a viewer may do: look, and ask for a lighter stream. Everything else is the controller's (PRD §22). */
const VIEWER_MAY = new Set<PreviewClientMessage['t']>(['ping', 'quality']);

/** Messages per second a socket may send, by kind: a person never comes near these. */
const LIMITS = { input: 400, nav: 8, viewport: 6, quality: 3, dialog: 6 } as const;
type Limit = keyof typeof LIMITS;
const limitOf = (t: PreviewClientMessage['t']): Limit =>
  t === 'mouse' || t === 'key' || t === 'text' ? 'input' : t === 'viewport' ? 'viewport' : t === 'quality' ? 'quality' : t === 'dialog' ? 'dialog' : 'nav';

class Bucket {
  #tokens: number;
  #at = Date.now();
  constructor(private readonly perSecond: number) {
    this.#tokens = perSecond;
  }
  take(): boolean {
    const now = Date.now();
    this.#tokens = Math.min(this.perSecond, this.#tokens + ((now - this.#at) / 1000) * this.perSecond);
    this.#at = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/* ---------- The container's output, framed ---------- */

/** A frame bigger than this is not a screencast frame. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Reads `cpb-view`'s stdout: `[kind][u32 length][payload]`, kind 1 a JSON event, kind 2 a frame. */
export class HelperDemux {
  #buf: Buffer = Buffer.alloc(0);
  onEvent: (event: Record<string, unknown>) => void = () => undefined;
  onFrame: (header: PreviewFrameHeader, jpeg: Buffer) => void = () => undefined;
  onProblem: (message: string) => void = () => undefined;

  push(chunk: Buffer) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    for (;;) {
      if (this.#buf.length < 5) return;
      const kind = this.#buf[0];
      const len = this.#buf.readUInt32BE(1);
      if ((kind !== 1 && kind !== 2) || len > MAX_FRAME_BYTES) {
        this.#buf = Buffer.alloc(0);
        return this.onProblem('The browser sent something unexpected.');
      }
      if (this.#buf.length < 5 + len) return;
      const payload = this.#buf.subarray(5, 5 + len);
      this.#buf = this.#buf.subarray(5 + len);
      try {
        if (kind === 1) this.onEvent(JSON.parse(payload.toString('utf8')) as Record<string, unknown>);
        else this.#frame(payload);
      } catch {
        this.onProblem('The browser sent something unexpected.');
      }
    }
  }

  #frame(payload: Buffer) {
    const h = payload.readUInt32BE(0);
    const header = JSON.parse(payload.subarray(4, 4 + h).toString('utf8')) as Record<string, unknown>;
    const dw = int(header.dw, 1, 16384);
    const dh = int(header.dh, 1, 16384);
    const jpeg = payload.subarray(4 + h);
    // Whatever arrives here is a JPEG of the page or it isn't a frame.
    if (dw === null || dh === null || typeof header.tab !== 'string' || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('bad frame');
    this.onFrame({ dw, dh, tab: header.tab.slice(0, 64), emu: header.emu === true }, Buffer.from(jpeg));
  }
}

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const DIALOG_KINDS = ['alert', 'confirm', 'prompt', 'beforeunload'];

/** What the page may be told from the container's events: known shapes, bounded text. */
export function sanitizeEvent(e: Record<string, unknown>): PreviewServerEvent | null {
  switch (e.e) {
    case 'tabs': {
      const tabs: BrowserTab[] = (Array.isArray(e.tabs) ? e.tabs : [])
        .slice(0, 50)
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string' && TAB_ID.test((t as { id: string }).id))
        .map((t) => ({ id: String(t.id), title: clip(t.title, 200), url: clip(t.url, 2000) }));
      return { e: 'tabs', tabs, current: typeof e.current === 'string' && TAB_ID.test(e.current) ? e.current : null };
    }
    case 'url':
      return typeof e.id === 'string' && TAB_ID.test(e.id) ? { e: 'url', id: e.id, url: clip(e.url, 2000), title: clip(e.title, 200) } : null;
    case 'loading':
      return { e: 'loading', on: e.on === true };
    case 'dialog':
      return { e: 'dialog', kind: DIALOG_KINDS.includes(String(e.kind)) ? String(e.kind) : 'alert', message: clip(e.message, 500), prompt: clip(e.prompt, 500) };
    case 'dialog-closed':
      return { e: 'dialog-closed' };
    case 'error':
      return { e: 'error', message: clip(e.message, 200), ...(e.fatal === true ? { fatal: true } : {}) };
    case 'pong':
      return { e: 'pong' };
    default:
      return null; // `ready` is the session's own: it carries the role
  }
}

/** A binary frame for the page: `[u16 header length][header JSON][JPEG]`. */
export function encodeFrame(header: PreviewFrameHeader, jpeg: Buffer): Buffer {
  const head = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(head.length);
  return Buffer.concat([prefix, head, jpeg]);
}

/* ---------- The session ---------- */

const PING_MS = 25_000;

export interface PreviewSessionOptions {
  ws: WebSocket;
  service: BrowserService;
  workspaceId: string;
  device: string;
  /** Whether input is allowed from this connection (HTTPS or localhost). */
  secure: boolean;
}

export class PreviewSession {
  readonly #o: PreviewSessionOptions;
  #upstream: ExecStream | null = null;
  #unwatch: (() => void) | null = null;
  #release: (() => void) | null = null;
  #ping: NodeJS.Timeout | undefined;
  #closed = false;
  #counted = false;
  /** The role this socket opened with: it is fixed for its life, and a change closes the socket (4001). */
  #role: 'viewer' | 'controller' = 'viewer';
  readonly #buckets = new Map<Limit, Bucket>();
  /** The frame being sent and the newest one waiting behind it: a slow viewer skips frames, never queues them. */
  #sending = false;
  #waiting: Buffer | null = null;

  constructor(o: PreviewSessionOptions) {
    this.#o = o;
  }

  #roleNow(): 'viewer' | 'controller' {
    return this.#o.secure ? this.#o.service.roleOf(this.#o.workspaceId, this.#o.device) : 'viewer';
  }

  #event(e: PreviewServerEvent) {
    const { ws } = this.#o;
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
  }

  async run() {
    const { ws, service, workspaceId, device } = this.#o;
    // Listeners first, so a socket that fails or closes while the rest is set up is never left without one.
    const alive = { ok: true };
    this.#ping = setInterval(() => {
      if (!alive.ok) return ws.terminate();
      alive.ok = false;
      ws.ping();
    }, PING_MS);
    ws.on('pong', () => (alive.ok = true));
    ws.on('close', () => this.#teardown());
    ws.on('error', () => this.#teardown());
    // Messages that arrive before the container's helper is there are dropped: the page waits for `ready`.
    ws.on('message', (data, isBinary) => {
      if (isBinary || this.#closed) return;
      this.#fromClient(String(data));
    });

    try {
      this.#release = service.openViewer(workspaceId);
    } catch (e) {
      return this.#close(CLOSE.refused, isAppError(e) && e.expose ? e.message : 'Too many viewers.');
    }
    service.leases.opened(workspaceId, device, 1);
    this.#counted = true;
    this.#role = this.#roleNow();
    this.#unwatch = service.leases.watch(workspaceId, () => this.#onControlChange());
    // While control is Private, a viewer who isn't the holder gets nothing: no helper, no frames.
    if (service.isPrivate(workspaceId) && this.#role !== 'controller') return this.#close(CLOSE.private, 'Private.');

    let upstream: ExecStream;
    try {
      upstream = await service.openView(workspaceId);
    } catch (e) {
      // A refusal (the preview is off, the workspace isn't running) is final; anything else may pass, so the page retries.
      return isAppError(e) && e.code === 'CONFLICT' ? this.#close(CLOSE.refused, e.message) : this.#close(CLOSE.unavailable, isAppError(e) && e.expose ? e.message : 'The browser isn’t answering.');
    }
    if (this.#closed) return upstream.close();
    this.#upstream = upstream;
    const demux = new HelperDemux();
    demux.onProblem = (message) => this.#event({ e: 'error', message });
    demux.onEvent = (raw) => {
      if (raw.e === 'ready') return this.#event({ e: 'ready', role: this.#role });
      const e = sanitizeEvent(raw);
      if (!e) return;
      this.#event(e);
      if (e.e === 'error' && e.fatal) this.#close(CLOSE.unavailable, e.message);
    };
    demux.onFrame = (header, jpeg) => this.#frame(encodeFrame(header, jpeg));
    upstream.onData((d) => demux.push(d));
    upstream.onExit(() => this.#close(CLOSE.unavailable, 'The preview closed.'));
    // The helper's stderr is diagnostics and can hold page text: read and dropped.
    upstream.onError(() => undefined);
  }

  /** Validates, checks the role and the rate, and passes on what remains. */
  #fromClient(raw: string) {
    if (raw.length > 16 * 1024) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const m = validateClientMessage(parsed);
    if (!m) return;
    if (m.t === 'ping') return this.#event({ e: 'pong' });
    if (this.#role !== 'controller' && !VIEWER_MAY.has(m.t)) return;
    const limit = limitOf(m.t);
    let bucket = this.#buckets.get(limit);
    if (!bucket) this.#buckets.set(limit, (bucket = new Bucket(LIMITS[limit])));
    if (!bucket.take()) return;
    this.#o.service.leases.seen(this.#o.workspaceId, this.#o.device);
    // A controller's tab choice brings the tab forward for everyone; a viewer never gets that far.
    this.#upstream?.write(`${JSON.stringify(m.t === 'tab' ? { ...m, activate: true } : m)}\n`);
  }

  #frame(out: Buffer) {
    if (this.#sending) {
      this.#waiting = out; // replaces an older frame that was still waiting
      return;
    }
    this.#send(out);
  }

  #send(data: Buffer) {
    const { ws } = this.#o;
    if (ws.readyState !== ws.OPEN) return;
    this.#sending = true;
    ws.send(data, { binary: true }, () => {
      this.#sending = false;
      const next = this.#waiting;
      this.#waiting = null;
      if (next) this.#send(next);
    });
  }

  #onControlChange() {
    if (this.#closed) return;
    const { service, workspaceId } = this.#o;
    if (this.#roleNow() !== this.#role) return this.#close(CLOSE.roleChanged, 'Control changed.');
    if (this.#role !== 'controller' && service.isPrivate(workspaceId)) this.#close(CLOSE.private, 'Private.');
  }

  #close(code: number, reason: string) {
    if (this.#closed) return;
    const { ws } = this.#o;
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason.slice(0, 120));
    this.#teardown();
  }

  #teardown() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#ping);
    this.#waiting = null;
    this.#unwatch?.();
    this.#upstream?.close(); // the helper ends with its pipe, and the page's viewport override goes with it
    this.#release?.();
    if (this.#counted) this.#o.service.leases.opened(this.#o.workspaceId, this.#o.device, -1);
  }
}
