import {
  REPORTER_BRIDGE_VERSION,
  REPORTER_EVIDENCE_SCHEMA,
  REPORTER_LIMITS,
  type ReporterBuildInfo,
  type ReporterEvidence,
  type ReporterHostMessage,
  type ReporterPanelMessage,
} from '@portal/contracts';

/*
 * The panel's half of the bridge (docs/prd/ui-reporter.md): it takes messages only from window.parent and only from the origin the
 * embed was opened for, checks every shape, and posts back with that origin as targetOrigin. Everything the host page sends is
 * untrusted: a message that does not fit is dropped silently (no reply, so a hostile page learns nothing).
 */

const PREFIX = 'pilot-reporter:';
const MEDIA = ['image/png', 'image/jpeg', 'image/webp'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 8192): v is string => typeof v === 'string' && v.length <= max;
const isId = (v: unknown): v is string => isStr(v, 200) && v.length > 0;
const strOrNull = (v: unknown, max = 2000) => v === null || isStr(v, max);
/** A cross-realm ArrayBuffer (structured clone makes it in this realm, but a check by tag survives either way). */
const isBuffer = (v: unknown): v is ArrayBuffer => Object.prototype.toString.call(v) === '[object ArrayBuffer]';

const isPage = (v: unknown): v is { url: string; title: string } => isObj(v) && isStr(v.url, 4096) && isStr(v.title, 2000);

export function isBuild(v: unknown): v is ReporterBuildInfo {
  return (
    isObj(v) &&
    strOrNull(v.version, 200) &&
    strOrNull(v.commit, 200) &&
    strOrNull(v.branch, 200) &&
    strOrNull(v.environment, 50) &&
    strOrNull(v.builtAt, 100) &&
    strOrNull(v.repo, 300)
  );
}

const isRect = (v: unknown) =>
  isObj(v) && ['x', 'y', 'w', 'h'].every((k) => typeof v[k] === 'number' && Number.isFinite(v[k] as number));

/** The parts of an evidence bundle the panel itself reads; the server re-validates the whole bundle. */
export function isEvidence(v: unknown): v is ReporterEvidence {
  if (!isObj(v) || v.schema !== REPORTER_EVIDENCE_SCHEMA) return false;
  if (!isObj(v.page) || !isStr(v.page.url, 4096) || !isStr(v.page.path, 4096)) return false;
  if (!isBuild(v.build)) return false;
  const a = v.anchor;
  if (!isObj(a) || !isStr(a.path, 4096) || !isRect(a.rect) || !isObj(a.viewport) || (a.mode !== 'full' && a.mode !== 'crop')) return false;
  if (!(a.selector === null || isStr(a.selector, 2000))) return false;
  if (!(a.relative === null || isRect(a.relative))) return false;
  if (!Array.isArray(v.console) || v.console.length > REPORTER_LIMITS.consoleEntries) return false;
  if (!Array.isArray(v.network) || v.network.length > REPORTER_LIMITS.networkEntries) return false;
  if (!Array.isArray(v.errorSignatures)) return false;
  return isObj(v.checks) && typeof v.checks.ran === 'boolean' && Array.isArray(v.checks.findings);
}

/** One host message, or null when it is not one we know or does not fit its shape. */
export function parseHostMessage(data: unknown): ReporterHostMessage | null {
  if (!isObj(data) || typeof data.type !== 'string' || !data.type.startsWith(PREFIX)) return null;
  const d = data;
  switch (d.type) {
    case 'pilot-reporter:hello':
      return typeof d.bridge === 'number' && isStr(d.sdkVersion, 50) && isPage(d.page) && isBuild(d.build) ? (d as ReporterHostMessage) : null;
    case 'pilot-reporter:navigated':
      return isPage(d.page) ? (d as ReporterHostMessage) : null;
    case 'pilot-reporter:capture-result':
      return isId(d.requestId) &&
        isBuffer(d.screenshot) &&
        d.screenshot.byteLength > 0 &&
        d.screenshot.byteLength <= REPORTER_LIMITS.screenshotBytes &&
        (MEDIA as readonly unknown[]).includes(d.mediaType) &&
        isEvidence(d.evidence)
        ? (d as ReporterHostMessage)
        : null;
    case 'pilot-reporter:capture-cancelled':
      return isId(d.requestId) && (d.reason === 'user' || d.reason === 'error') && (d.message === undefined || isStr(d.message, 500))
        ? (d as ReporterHostMessage)
        : null;
    case 'pilot-reporter:capture-started':
      return isId(d.requestId) && (d.mode === 'full' || d.mode === 'crop') ? (d as ReporterHostMessage) : null;
    case 'pilot-reporter:panel-opened':
    case 'pilot-reporter:focus-ended':
      return { type: d.type } as ReporterHostMessage;
    case 'pilot-reporter:callout-clicked':
    case 'pilot-reporter:focus-changed':
      return isId(d.key) && isId(d.captureId) ? (d as ReporterHostMessage) : null;
    case 'pilot-reporter:focus-missing':
      return isId(d.key) && (d.captureId === null || isId(d.captureId)) && (d.reason === 'other-page' || d.reason === 'not-found')
        ? (d as ReporterHostMessage)
        : null;
    default:
      return null;
  }
}

/** True when the host speaks our bridge major. */
export const bridgeCompatible = (m: ReporterHostMessage) => m.type !== 'pilot-reporter:hello' || m.bridge === REPORTER_BRIDGE_VERSION;

/** The window surface the bridge needs (a real Window, or a fake in tests). */
export interface BridgeWindow {
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}
export interface BridgeTarget {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

export interface PanelBridge {
  post(msg: ReporterPanelMessage): void;
  dispose(): void;
}

/**
 * Listens on `self` for messages from `parent` at `origin` and hands valid ones to `onMessage`; `post` sends to `parent` with
 * `origin` as targetOrigin (never '*'). A null parent (the embed opened on its own, not framed) receives and sends nothing.
 */
export function createPanelBridge(opts: {
  self: BridgeWindow;
  parent: BridgeTarget | null;
  origin: string;
  onMessage: (m: ReporterHostMessage) => void;
}): PanelBridge {
  const { self, parent, origin, onMessage } = opts;
  const listener = (e: MessageEvent) => {
    if (!parent || e.source !== (parent as unknown) || e.origin !== origin) return;
    const m = parseHostMessage(e.data);
    if (m && bridgeCompatible(m)) onMessage(m);
  };
  self.addEventListener('message', listener);
  return {
    post(msg) {
      if (!parent) return;
      try {
        parent.postMessage(msg, origin);
      } catch {
        // the host went away
      }
    },
    dispose: () => self.removeEventListener('message', listener),
  };
}

/** An exact origin (scheme, host, port), nothing more; null when `raw` is not one. */
export function exactOrigin(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin === raw ? raw : null;
  } catch {
    return null;
  }
}
