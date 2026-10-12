/**
 * What the live-view bridge knows about the RFB protocol (browser & desktop PRD §12.1, §12.2): the browser-facing
 * handshake it speaks itself, and the filter every message from the viewer passes. noVNC's `viewOnly` only stops a
 * cooperative client, so the bridge decides by the viewer's role; the display's own VNC server enforces view-only
 * for the view password too, so a mistake here can't grant input. Frames pass through untouched.
 */

export type RfbRole = 'viewer' | 'controller';

/** A client that breaks the rules gets its socket closed. */
export class RfbViolation extends Error {}

/** SetEncodings entries a viewer may ask for: the ones noVNC draws, and nothing that unlocks other messages. */
const ALLOWED_ENCODINGS = new Set<number>([
  0, // Raw
  1, // CopyRect
  2, // RRE
  5, // Hextile
  6, // Zlib
  7, // Tight
  15, // TRLE
  16, // ZRLE
  -260, // TightPNG
  -239, // Cursor
  -240, // X Cursor
  -224, // LastRect
  -223, // DesktopSize (the server's notice, not the client's request)
  -32, -31, -30, -29, -28, -27, -26, -25, -24, -23, // Tight quality level
  -256, -255, -254, -253, -252, -251, -250, -249, -248, -247, // Tight compression level
]);

export const MAX_ENCODINGS = 64;
/** A client's cut text is dropped, but it still has to be skipped: no bigger than this. */
export const MAX_CUT_TEXT = 1024 * 1024;

/** One message the filter let through, or dropped, for the bridge to count and tests to see. */
export interface FilterResult {
  forward: Buffer[];
  dropped: number;
}

/**
 * Filters the viewer's messages after the handshake (PRD §12.2).
 *
 * | Message | Viewer | Controller |
 * | SetPixelFormat (0), SetEncodings (2, at most 64, allowlisted), FramebufferUpdateRequest (3) | forward; requests dropped while Private | forward |
 * | KeyEvent (4), PointerEvent (5) | drop | forward |
 * | ClientCutText (6) | drop | drop (the clipboard goes through `xclip`) |
 * | anything else, or an oversized message | close | close |
 */
export class RfbClientFilter {
  #buf: Buffer = Buffer.alloc(0);
  /** What was last sent for them, so a new upstream connection (a role change) can be brought up to date. */
  lastPixelFormat: Buffer | null = null;
  lastEncodings: Buffer | null = null;
  /** Counters for the audit trail and tests: never the contents. */
  stats = { forwarded: 0, dropped: 0, keys: 0, pointers: 0 };

  constructor(
    private readonly state: { role: () => RfbRole; private: () => boolean },
  ) {}

  push(chunk: Buffer): FilterResult {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: Buffer[] = [];
    let dropped = 0;
    for (;;) {
      const need = this.#needed();
      if (need === 0 || this.#buf.length < need) break;
      const msg = this.#buf.subarray(0, need);
      this.#buf = this.#buf.subarray(need);
      const r = this.#decide(msg);
      if (r) out.push(r);
      else dropped++;
    }
    this.stats.dropped += dropped;
    this.stats.forwarded += out.length;
    return { forward: out, dropped };
  }

  /** The size of the message at the front of the buffer, or 0 when its header isn't all here yet. */
  #needed(): number {
    const b = this.#buf;
    if (b.length < 1) return 0;
    switch (b[0]) {
      case 0:
        return 20;
      case 2: {
        if (b.length < 4) return 0;
        const n = b.readUInt16BE(2);
        if (n > MAX_ENCODINGS) throw new RfbViolation(`SetEncodings with ${n} entries`);
        return 4 + 4 * n;
      }
      case 3:
        return 10;
      case 4:
        return 8;
      case 5:
        return 6;
      case 6: {
        if (b.length < 8) return 0;
        const len = b.readUInt32BE(4);
        if (len > MAX_CUT_TEXT) throw new RfbViolation('ClientCutText too large');
        return 8 + len;
      }
      default:
        throw new RfbViolation(`message type ${b[0]}`);
    }
  }

  /** The message to forward, or null to drop it. */
  #decide(msg: Buffer): Buffer | null {
    const role = this.state.role();
    switch (msg[0]) {
      case 0:
        this.lastPixelFormat = Buffer.from(msg);
        return msg;
      case 2: {
        // Keep only the encodings a viewer may use; the count is rewritten to match.
        const n = msg.readUInt16BE(2);
        const kept: number[] = [];
        for (let i = 0; i < n; i++) {
          const e = msg.readInt32BE(4 + 4 * i);
          if (ALLOWED_ENCODINGS.has(e)) kept.push(e);
        }
        const out = Buffer.alloc(4 + 4 * kept.length);
        out[0] = 2;
        out.writeUInt16BE(kept.length, 2);
        kept.forEach((e, i) => out.writeInt32BE(e, 4 + 4 * i));
        this.lastEncodings = out;
        return out;
      }
      case 3:
        // While Private, other viewers' update requests are dropped, so the server sends them nothing.
        return this.state.private() && role !== 'controller' ? null : msg;
      case 4:
        this.stats.keys++;
        return role === 'controller' ? msg : null;
      case 5:
        this.stats.pointers++;
        return role === 'controller' ? msg : null;
      default:
        return null; // ClientCutText: never
    }
  }
}

/**
 * The bridge's side of the browser-facing handshake (PRD §12.1): RFB 3.8 with security type None, since the
 * socket is already authenticated by the portal's session and the bridge logs in to the display itself with
 * the viewer's role. `ClientInit` is read and ignored: the upstream was already told "shared", so no client
 * can disconnect another.
 */
export class RfbClientHandshake {
  #buf: Buffer = Buffer.alloc(0);
  #step: 'version' | 'security' | 'init' | 'done' = 'version';

  /**
   * Feeds the client's handshake bytes. `send` writes to the client; `serverInit` is the display's ServerInit,
   * sent when the client's ClientInit arrives. Returns the bytes that followed the handshake (the client's first
   * messages), once it is done.
   */
  constructor(
    private readonly send: (data: Buffer) => void,
    private readonly serverInit: () => Buffer,
  ) {}

  /** Sends the server's greeting: call once, right after construction. */
  start() {
    this.send(Buffer.from('RFB 003.008\n'));
  }

  get done() {
    return this.#step === 'done';
  }

  push(chunk: Buffer): Buffer | null {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      if (this.#step === 'version') {
        if (this.#buf.length < 12) return null;
        const version = this.#buf.subarray(0, 12).toString('latin1');
        this.#buf = this.#buf.subarray(12);
        if (!/^RFB 003\.00[78]\n$/.test(version)) throw new RfbViolation(`protocol version ${JSON.stringify(version.trim())}`);
        // Security types: one, None (1).
        this.send(Buffer.from([1, 1]));
        this.#step = 'security';
      } else if (this.#step === 'security') {
        if (this.#buf.length < 1) return null;
        const chosen = this.#buf[0];
        this.#buf = this.#buf.subarray(1);
        if (chosen !== 1) throw new RfbViolation('security type other than None');
        this.send(Buffer.alloc(4)); // SecurityResult: OK
        this.#step = 'init';
      } else if (this.#step === 'init') {
        if (this.#buf.length < 1) return null;
        this.#buf = this.#buf.subarray(1);
        this.send(this.serverInit());
        this.#step = 'done';
        const rest = this.#buf;
        this.#buf = Buffer.alloc(0);
        return rest;
      } else return null;
    }
  }
}

/**
 * Reads the display's side as `cpb-vnc` prints it: a `CPB-VNC-OK` line, then raw RFB from ServerInit on. Gives the
 * ServerInit once it's complete, then passes everything after it.
 */
export class UpstreamReader {
  #buf: Buffer = Buffer.alloc(0);
  #ok = false;
  #init: Buffer | null = null;
  /** Called with the bytes after ServerInit. */
  onData: (data: Buffer) => void = () => undefined;
  onError: (message: string) => void = () => undefined;
  /** Called once, when ServerInit is complete. */
  onInit: (serverInit: Buffer) => void = () => undefined;

  get serverInit(): Buffer | null {
    return this.#init;
  }

  push(chunk: Buffer) {
    if (this.#init) return void this.onData(chunk);
    this.#buf = Buffer.concat([this.#buf, chunk]);
    if (!this.#ok) {
      const nl = this.#buf.indexOf(0x0a);
      if (nl < 0) {
        if (this.#buf.length > 512) this.onError('The display sent something unexpected.');
        return;
      }
      const line = this.#buf.subarray(0, nl).toString('utf8');
      this.#buf = this.#buf.subarray(nl + 1);
      if (line.startsWith('CPB-VNC-ERR')) return this.onError(line.slice('CPB-VNC-ERR'.length).trim() || 'The display refused the connection.');
      if (line !== 'CPB-VNC-OK') return this.onError('The display sent something unexpected.');
      this.#ok = true;
    }
    // ServerInit: width, height, pixel format (16), name length (4), name.
    if (this.#buf.length < 24) return;
    const nameLen = this.#buf.readUInt32BE(20);
    if (nameLen > 4096) return this.onError('The display sent something unexpected.');
    if (this.#buf.length < 24 + nameLen) return;
    this.#init = Buffer.from(this.#buf.subarray(0, 24 + nameLen));
    const rest = this.#buf.subarray(24 + nameLen);
    this.#buf = Buffer.alloc(0);
    this.onInit(this.#init);
    if (rest.length) this.onData(rest);
  }
}
