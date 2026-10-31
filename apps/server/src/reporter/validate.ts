// UI reporter (docs/prd/ui-reporter-server.md): everything the page sends is untrusted input. This file turns it into what the server
// keeps: origins and sites checked, captures and anchors bounded, the evidence bundle parsed against ReporterEvidence (schema version,
// caps, truncation) and re-redacted, screenshots checked by their magic bytes. A value that cannot be made safe is refused (422), never
// passed on as it came.

import { AppError } from '@isnanme/core';
import {
  REPORTER_EVIDENCE_SCHEMA,
  REPORTER_ANNOTATION_COLORS,
  REPORTER_LIMITS,
  type ReporterAnchor,
  type ReporterAnnotation,
  type ReporterAnnotationColor,
  type ReporterBuildInfo,
  type ReporterCaptureInput,
  type ReporterCheckFinding,
  type ReporterChecks,
  type ReporterComponentNode,
  type ReporterConsoleEntry,
  type ReporterDeviceInfo,
  type ReporterEvidence,
  type ReporterInteraction,
  type ReporterNetworkEntry,
  type ReporterPageInfo,
  type ReporterPageState,
  type ReporterPerformance,
  type ReporterSessionTarget,
  type ReporterSite,
} from '@portal/contracts';
import { redact } from '../chat/redact.js';

export const invalid = (field: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });

/* ---------- Redaction ---------- */

/**
 * The chat's credential shapes (chat/redact.ts), plus what a web page tends to leak that a terminal does not: JSON Web Tokens, and long
 * `prefix_<base62>` keys (Stripe-like, Supabase-like). Applied to every string of the evidence the server keeps, whatever the SDK masked.
 */
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const PREFIXED_KEY = /(?<![A-Za-z0-9])[a-z]{2,10}_(?:live_|test_|prod_)?[A-Za-z0-9]{24,}(?![A-Za-z0-9])/g;

export function redactText(text: string): string {
  if (!text) return text;
  return redact(text).replace(JWT, '[redacted]').replace(PREFIXED_KEY, (m) => (/[0-9]/.test(m) && /[A-Z]/.test(m) ? '[redacted]' : m));
}

/** A URL with every query VALUE replaced (keys kept), secret-looking path segments redacted and the userinfo dropped; what is not a URL is redacted as text. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    const segs = u.pathname.split('/');
    u.pathname = segs.map((seg, i) => redactSegment(seg, i > 0 ? segs[i - 1] : undefined)).join('/');
    const keys = [...u.searchParams.keys()];
    if (keys.length) u.search = keys.map((k) => `${encodeURIComponent(k)}=[redacted]`).join('&');
    return redactText(u.toString().replace(/%5Bredacted%5D/g, '[redacted]'));
  } catch {
    return redactText(raw.replace(/([?&][^=&#]+=)[^&#]*/g, '$1[redacted]'));
  }
}

/* ---------- Small readers ---------- */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function str(v: unknown, max: number, field: string, opts: { nullable?: boolean; required?: boolean } = {}): string {
  if (v === null || v === undefined) {
    if (opts.required) throw invalid(field, `${field} is required.`);
    return '';
  }
  if (typeof v !== 'string') throw invalid(field, `${field} must be text.`);
  // Control characters out (newlines and tabs stay), then capped: what the SDK sends past the cap is truncated, not refused.
  return redactText(v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max));
}
const strOrNull = (v: unknown, max: number, field: string): string | null => (v === null || v === undefined ? null : str(v, max, field));
/** A one-line value (a branch, a browser name): line breaks and tabs out as well, so it can never forge a line where it is quoted. */
const lineOrNull = (v: unknown, max: number, field: string): string | null => {
  const s = strOrNull(v, max, field);
  return s === null ? null : s.replace(/[\r\n\t\u2028\u2029]+/g, ' ').trim() || null;
};

function num(v: unknown, field: string, opts: { min?: number; max?: number; nullable?: boolean } = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(field, `${field} must be a number.`);
  const min = opts.min ?? -1e12;
  const max = opts.max ?? 1e12;
  if (v < min || v > max) throw invalid(field, `${field} is out of range.`);
  return v;
}
/**
 * A wall-clock time in epoch milliseconds, as the SDK stamps console, network and interaction entries (Date.now(), or
 * performance.timeOrigin + startTime for resources): from 1970 to a day ahead of this server's clock (a device clock runs fast at times).
 * The generic number range (+-1e12, about September 2001) refused every real report (PILOT-1111).
 */
export const epochMs = (v: unknown, field: string, now = Date.now()): number => num(v, field, { min: 0, max: now + 86_400_000 });
const numOrNull = (v: unknown, field: string, opts: { min?: number; max?: number } = {}): number | null =>
  v === null || v === undefined ? null : num(v, field, opts);
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function oneOf<T extends string>(v: unknown, list: readonly T[], field: string, fallback?: T): T {
  if (typeof v === 'string' && (list as readonly string[]).includes(v)) return v as T;
  if (fallback !== undefined) return fallback;
  throw invalid(field, `${field} must be one of ${list.join(', ')}.`);
}

function list<T>(v: unknown, cap: number, field: string, each: (x: unknown, i: number) => T): { items: T[] } {
  if (v === undefined || v === null) return { items: [] };
  if (!Array.isArray(v)) throw invalid(field, `${field} must be a list.`);
  // Over the cap is refused: the SDK caps before it sends, so a longer list is not this SDK's.
  if (v.length > cap) throw invalid(field, `${field} holds more than ${cap} entries.`);
  return { items: v.map((x, i) => each(x, i)) };
}

/* ---------- Origins, sites, targets ---------- */

/** An exact origin (http or https, a host, an optional port), lowercase, no path; null when it is not one. */
export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    if (u.pathname !== '/' || u.search || u.hash) return null;
    // A plain host name or address: no wildcard, nothing a browser would not write in an Origin header.
    if (!/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/.test(u.hostname)) return null;
    // Exactly an origin as a browser writes it (a default port, a trailing slash and the case of the host aside): nothing else in it.
    if (raw.toLowerCase().replace(/\/$/, '').replace(/:443$|:80$/, '') !== u.origin) return null;
    return u.origin;
  } catch {
    return null;
  }
}

const ENV = /^[a-z0-9][a-z0-9-]{0,19}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100}){1,3}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

export function cleanSites(raw: unknown): ReporterSite[] {
  if (!Array.isArray(raw)) throw invalid('sites', 'Sites are a list.');
  if (raw.length > REPORTER_LIMITS.sites) throw invalid('sites', `At most ${REPORTER_LIMITS.sites} sites.`);
  const seen = new Set<string>();
  return raw.map((s, i) => {
    const f = `sites[${i}]`;
    if (!isObj(s)) throw invalid(f, 'A site is { origin, environment, repo, label, branch }.');
    const origin = normalizeOrigin(s.origin);
    if (!origin) throw invalid(`${f}.origin`, 'An exact origin, like https://stg.example.com (no path, no wildcard).');
    if (seen.has(origin)) throw invalid(`${f}.origin`, `${origin} is listed twice.`);
    seen.add(origin);
    const environment = typeof s.environment === 'string' ? s.environment.trim().toLowerCase() : '';
    if (!ENV.test(environment)) throw invalid(`${f}.environment`, 'An environment: lowercase letters, digits and dashes, 1-20 characters (stg, uat, prod).');
    const repo = typeof s.repo === 'string' ? s.repo.trim() : '';
    if (!REPO.test(repo)) throw invalid(`${f}.repo`, 'A repo path like group/name.');
    const label = typeof s.label === 'string' && s.label.trim() ? s.label.replace(/[\u0000-\u001f\u007f<>"]/g, '').trim().slice(0, 60) : null;
    const branch = typeof s.branch === 'string' && s.branch.trim() ? s.branch.trim() : null;
    if (branch !== null && (!BRANCH.test(branch) || branch.includes('..'))) throw invalid(`${f}.branch`, 'A branch name.');
    return { origin, environment, repo, label, branch };
  });
}

export const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function cleanSessionTargets(raw: unknown): ReporterSessionTarget[] {
  if (!Array.isArray(raw)) throw invalid('sessionTargets', 'Session targets are a list.');
  if (raw.length > REPORTER_LIMITS.sessionTargets) throw invalid('sessionTargets', `At most ${REPORTER_LIMITS.sessionTargets} sessions.`);
  const seen = new Set<string>();
  return raw.map((t, i) => {
    const f = `sessionTargets[${i}]`;
    if (!isObj(t) || typeof t.sessionId !== 'string' || !SESSION_ID.test(t.sessionId)) throw invalid(f, 'A session target is { sessionId, label }.');
    if (seen.has(t.sessionId)) throw invalid(f, 'That session is listed twice.');
    seen.add(t.sessionId);
    const label = typeof t.label === 'string' ? t.label.replace(/[\u0000-\u001f\u007f<>"]/g, '').trim().slice(0, 60) : '';
    return { sessionId: t.sessionId, label: label || t.sessionId };
  });
}

/* ---------- Build info, anchors, captures ---------- */

export function cleanBuild(raw: unknown): ReporterBuildInfo {
  const b = isObj(raw) ? raw : {};
  const sha = (v: unknown) => {
    const s = strOrNull(v, 64, 'build.commit');
    return s && /^[0-9a-fA-F]{7,40}$/.test(s) ? s.toLowerCase() : null;
  };
  return {
    version: lineOrNull(b.version, 80, 'build.version'),
    commit: sha(b.commit),
    branch: lineOrNull(b.branch, 200, 'build.branch'),
    environment: lineOrNull(b.environment, 40, 'build.environment'),
    builtAt: lineOrNull(b.builtAt, 40, 'build.builtAt'),
    repo: lineOrNull(b.repo, 200, 'build.repo'),
  };
}

const rect = (v: unknown, field: string) => {
  if (!isObj(v)) throw invalid(field, `${field} is { x, y, w, h }.`);
  return { x: num(v.x, `${field}.x`), y: num(v.y, `${field}.y`), w: num(v.w, `${field}.w`, { min: 0 }), h: num(v.h, `${field}.h`, { min: 0 }) };
};

/** A segment that follows one of these names is a secret by its place (a reset link, a magic sign-in link, an invite). */
const SECRET_AFTER = /^(?:reset|reset-password|password-reset|token|tokens|magic|magic-link|invite|invites|invitation|verify|verification|confirm|activate|activation|auth|login|signin|sign-in|unsubscribe|share|s)$/i;

/** One path segment, redacted when it looks like a secret: a credential shape, a long random-looking run, or what follows a SECRET_AFTER name. */
function redactSegment(seg: string, prev: string | undefined): string {
  if (!seg) return seg;
  const r = redactText(seg);
  if (r !== seg) return '[redacted]';
  if (/^[A-Za-z0-9_-]{32,}$/.test(seg) && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg)) return '[redacted]';
  if (prev !== undefined && SECRET_AFTER.test(prev) && /^[A-Za-z0-9_.~%-]{16,}$/.test(seg)) return '[redacted]';
  return seg;
}

/** A path plus search, no hash, starting with "/": control characters out, secret-looking segments and every query value redacted. */
export function cleanPath(raw: unknown, field = 'path'): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.length > 2000) throw invalid(field, 'A path starting with "/".');
  const noHash = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').split('#')[0]!;
  if (noHash.startsWith('//')) throw invalid(field, 'A path starting with "/".');
  const q = noHash.indexOf('?');
  const segs = (q < 0 ? noHash : noHash.slice(0, q)).split('/');
  const path = segs.map((seg, i) => redactSegment(seg, i > 0 ? segs[i - 1] : undefined)).join('/');
  if (q < 0) return path;
  const keys = new URLSearchParams(noHash.slice(q + 1));
  const ks = [...keys.keys()];
  return ks.length ? `${path}?${ks.map((k) => `${encodeURIComponent(k)}=[redacted]`).join('&')}` : path;
}

/** Just the path, no search: what callouts and "this page" match on. */
export const pathOnly = (p: string): string => p.split('?')[0]!.split('#')[0]! || '/';

export function cleanAnchor(raw: unknown, field = 'anchor'): ReporterAnchor {
  if (!isObj(raw)) throw invalid(field, 'An anchor is required.');
  const vp = isObj(raw.viewport) ? raw.viewport : null;
  if (!vp) throw invalid(`${field}.viewport`, 'The viewport is required.');
  const rel = raw.relative === null || raw.relative === undefined ? null : rect(raw.relative, `${field}.relative`);
  return {
    path: cleanPath(raw.path, `${field}.path`),
    selector: strOrNull(raw.selector, 500, `${field}.selector`),
    relative: rel,
    rect: rect(raw.rect, `${field}.rect`),
    viewport: { w: num(vp.w, `${field}.viewport.w`, { min: 0, max: 20000 }), h: num(vp.h, `${field}.viewport.h`, { min: 0, max: 20000 }), dpr: num(vp.dpr, `${field}.viewport.dpr`, { min: 0, max: 10 }) },
    mode: oneOf(raw.mode, ['viewport', 'full', 'crop'] as const, `${field}.mode`),
  };
}

export const CAPTURE_ID = /^[A-Za-z0-9-]{8,64}$/;

export function cleanCapture(raw: unknown, origin: string, field = 'capture'): ReporterCaptureInput {
  if (!isObj(raw)) throw invalid(field, 'A capture is { captureId, pageUrl, anchor, note }.');
  if (typeof raw.captureId !== 'string' || !CAPTURE_ID.test(raw.captureId)) throw invalid(`${field}.captureId`, 'A capture id (a UUID).');
  const pageUrl = typeof raw.pageUrl === 'string' ? raw.pageUrl : '';
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    throw invalid(`${field}.pageUrl`, 'The page URL.');
  }
  // A capture is of a page of the site the token was made for, never of somewhere else.
  if (page.origin !== origin) throw invalid(`${field}.pageUrl`, 'The page is not on this site.');
  const note = raw.note === null || raw.note === undefined ? null : str(raw.note, REPORTER_LIMITS.commentChars, `${field}.note`) || null;
  const annotations = cleanAnnotations(raw.annotations, `${field}.annotations`);
  return { captureId: raw.captureId, pageUrl: redactUrl(page.toString()).slice(0, 2000), anchor: cleanAnchor(raw.anchor, `${field}.anchor`), note, ...(annotations.length ? { annotations } : {}) };
}

/* ---------- Annotations ---------- */

/** A coordinate in image pixels: finite, within a screenshot's reach (a full-page shot is tall), kept to one decimal. */
const coord = (v: unknown, field: string) => Math.round(num(v, field, { min: -100_000, max: 100_000 }) * 10) / 10;
const color = (v: unknown, field: string): ReporterAnnotationColor => oneOf(v, REPORTER_ANNOTATION_COLORS, field);
const width = (v: unknown, field: string) => Math.round(num(v, field, { min: 0.5, max: 1000 }) * 10) / 10;

function points(v: unknown, field: string, count: { min: number; max: number }): number[] {
  if (!Array.isArray(v)) throw invalid(field, `${field} is a flat list of x, y numbers.`);
  if (v.length % 2 !== 0 || v.length < count.min * 2 || v.length > count.max * 2) throw invalid(field, `${field} holds ${count.min === count.max ? count.min : `${count.min} to ${count.max}`} points.`);
  return v.map((x, i) => coord(x, `${field}[${i}]`));
}

function annoRect(v: unknown, field: string) {
  const r = rect(v, field);
  // Normalised (a drag up or left gives a negative size in the editor) and bounded like a coordinate.
  return { x: coord(r.x, `${field}.x`), y: coord(r.y, `${field}.y`), w: coord(r.w, `${field}.w`), h: coord(r.h, `${field}.h`) };
}

/**
 * The marks of a capture (ReporterAnnotation), checked one by one: a known type, a colour of the palette, coordinates in range, the per-mark
 * and per-capture point caps, text without control characters, capped and redacted (chat/redact.ts and the page shapes). Over a cap is
 * refused (the editor caps before it sends). Absent or empty: no marks.
 */
export function cleanAnnotations(raw: unknown, field = 'annotations'): ReporterAnnotation[] {
  const L = REPORTER_LIMITS;
  let total = 0;
  const out = list(raw, L.annotations, field, (x, i): ReporterAnnotation => {
    const f = `${field}[${i}]`;
    if (!isObj(x)) throw invalid(f, 'A mark is { type, ... }.');
    const type = oneOf(x.type, ['pen', 'highlight', 'line', 'arrow', 'rect', 'ellipse', 'blur', 'text', 'step'] as const, `${f}.type`);
    if (type === 'blur') return { type, rect: annoRect(x.rect, `${f}.rect`) };
    if (type === 'rect' || type === 'ellipse') return { type, rect: annoRect(x.rect, `${f}.rect`), color: color(x.color, `${f}.color`), width: width(x.width, `${f}.width`) };
    const n = type === 'pen' || type === 'highlight' ? { min: 1, max: L.annotationPoints / 2 } : type === 'line' || type === 'arrow' ? { min: 2, max: 2 } : { min: 1, max: 1 };
    const pts = points(x.points, `${f}.points`, n);
    total += pts.length;
    if (total > L.annotationPointsTotal) throw invalid(field, `The marks hold more than ${L.annotationPointsTotal} numbers.`);
    const base = { points: pts, color: color(x.color, `${f}.color`), width: width(x.width, `${f}.width`) };
    if (type === 'text') {
      const text = str(x.text, L.annotationTextChars, `${f}.text`).trim();
      if (!text) throw invalid(`${f}.text`, 'A text mark needs its text.');
      return { type, ...base, text };
    }
    if (type === 'step') return { type, ...base, n: Math.round(num(x.n, `${f}.n`, { min: 1, max: 999 })) };
    return { type, ...base };
  }).items;
  return out;
}

/** True when the marks pixelate an area: the screenshot uploaded is then the flattened image, and no original may be stored. */
export const hasBlur = (marks: readonly ReporterAnnotation[] | null | undefined): boolean => !!marks?.some((m) => m.type === 'blur');

/** The annotated image: PNG or WebP only (what a canvas exports), by its magic bytes, within the screenshot cap. */
export function checkAnnotated(bytes: Buffer, declared: string | undefined): 'image/png' | 'image/webp' {
  const type = checkScreenshot(bytes, declared);
  if (type !== 'image/png' && type !== 'image/webp') throw invalid('annotated', 'An annotated image is a PNG or WebP image.');
  return type;
}

/* ---------- Screenshots ---------- */

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';

/** The image type its first bytes say, or null: PNG, JPEG or WebP only (never what a header claims). */
export function sniffImage(bytes: Buffer): ImageType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function checkScreenshot(bytes: Buffer, declared: string | undefined): ImageType {
  if (!bytes.length) throw invalid('screenshot', 'The screenshot is empty.');
  if (bytes.length > REPORTER_LIMITS.screenshotBytes) throw new AppError('PAYLOAD_TOO_LARGE', `The screenshot is larger than ${REPORTER_LIMITS.screenshotBytes / 1024 / 1024} MB.`);
  const type = sniffImage(bytes);
  if (!type) throw invalid('screenshot', 'A screenshot is a PNG, JPEG or WebP image.');
  const d = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  if (d && d !== 'application/octet-stream' && d !== type) throw invalid('screenshot', 'The image is not the type it says it is.');
  return type;
}

/* ---------- The evidence bundle ---------- */

const T = REPORTER_LIMITS.textChars;

function page(v: unknown): ReporterPageInfo {
  const p = isObj(v) ? v : {};
  return {
    url: redactUrl(str(p.url, 2000, 'page.url')),
    origin: str(p.origin, 300, 'page.origin'),
    host: str(p.host, 255, 'page.host'),
    path: str(p.path, 2000, 'page.path'),
    search: str(p.search, 2000, 'page.search').replace(/([?&][^=&#]+=)[^&#]*/g, '$1[redacted]'),
    hash: str(p.hash, 300, 'page.hash'),
    title: str(p.title, 300, 'page.title'),
    referrer: p.referrer ? redactUrl(str(p.referrer, 2000, 'page.referrer')) : '',
    lang: str(p.lang, 40, 'page.lang'),
    route: strOrNull(p.route, 300, 'page.route'),
    historyLength: numOrNull(p.historyLength, 'page.historyLength', { min: 0, max: 1e6 }) ?? 0,
  };
}

function nameVersion(v: unknown, field: string) {
  const o = isObj(v) ? v : {};
  return { name: lineOrNull(o.name, 80, `${field}.name`), version: lineOrNull(o.version, 80, `${field}.version`) };
}

function device(v: unknown): ReporterDeviceInfo {
  const d = isObj(v) ? v : {};
  const scr = isObj(d.screen) ? d.screen : {};
  const vp = isObj(d.viewport) ? d.viewport : {};
  const c = isObj(d.connection) ? d.connection : {};
  return {
    userAgent: str(d.userAgent, 500, 'device.userAgent'),
    browser: nameVersion(d.browser, 'device.browser'),
    os: nameVersion(d.os, 'device.os'),
    mobile: boolOrNull(d.mobile),
    touch: d.touch === true,
    screen: { w: numOrNull(scr.w, 'device.screen.w', { min: 0, max: 20000 }) ?? 0, h: numOrNull(scr.h, 'device.screen.h', { min: 0, max: 20000 }) ?? 0, dpr: numOrNull(scr.dpr, 'device.screen.dpr', { min: 0, max: 10 }) ?? 1, orientation: strOrNull(scr.orientation, 40, 'device.screen.orientation') },
    viewport: { w: numOrNull(vp.w, 'device.viewport.w', { min: 0, max: 20000 }) ?? 0, h: numOrNull(vp.h, 'device.viewport.h', { min: 0, max: 20000 }) ?? 0 },
    hardwareConcurrency: numOrNull(d.hardwareConcurrency, 'device.hardwareConcurrency', { min: 0, max: 1024 }),
    deviceMemoryGb: numOrNull(d.deviceMemoryGb, 'device.deviceMemoryGb', { min: 0, max: 4096 }),
    connection: {
      effectiveType: strOrNull(c.effectiveType, 20, 'device.connection.effectiveType'),
      downlinkMbps: numOrNull(c.downlinkMbps, 'device.connection.downlinkMbps', { min: 0 }),
      rttMs: numOrNull(c.rttMs, 'device.connection.rttMs', { min: 0 }),
      saveData: boolOrNull(c.saveData),
    },
    timezone: strOrNull(d.timezone, 80, 'device.timezone'),
    locale: strOrNull(d.locale, 40, 'device.locale'),
  };
}

const keyNames = (v: unknown, field: string) => list(v, 200, field, (x, i) => str(x, 200, `${field}[${i}]`)).items;

/** App state is the app's own JSON: re-serialized, every string redacted, and capped (a quarter of the evidence budget). */
function appState(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  const walk = (x: unknown, depth: number): unknown => {
    if (depth > 12) return '[deep]';
    if (typeof x === 'string') return redactText(x.slice(0, T));
    if (typeof x === 'number' || typeof x === 'boolean' || x === null) return x;
    if (Array.isArray(x)) return x.slice(0, 200).map((y) => walk(y, depth + 1));
    if (isObj(x)) {
      const out: Record<string, unknown> = {};
      for (const [k, y] of Object.entries(x).slice(0, 200)) out[redactText(k.slice(0, 200))] = /pass|secret|token|auth|cookie|session|key/i.test(k) ? '[redacted]' : walk(y, depth + 1);
      return out;
    }
    return null;
  };
  const cleaned = walk(v, 0);
  const json = JSON.stringify(cleaned);
  return json.length > REPORTER_LIMITS.evidenceBytes / 4 ? { truncated: true, preview: json.slice(0, 4000) } : cleaned;
}

function state(v: unknown): ReporterPageState {
  const s = isObj(v) ? v : {};
  const sc = isObj(s.scroll) ? s.scroll : {};
  const keys = isObj(s.storageKeys) ? s.storageKeys : {};
  return {
    scroll: { x: numOrNull(sc.x, 'state.scroll.x') ?? 0, y: numOrNull(sc.y, 'state.scroll.y') ?? 0, maxY: numOrNull(sc.maxY, 'state.scroll.maxY') ?? 0 },
    visibility: str(s.visibility, 20, 'state.visibility'),
    online: s.online !== false,
    colorScheme: s.colorScheme === 'dark' ? 'dark' : 'light',
    reducedMotion: s.reducedMotion === true,
    focused: strOrNull(s.focused, 500, 'state.focused'),
    storageKeys: { local: keyNames(keys.local, 'state.storageKeys.local'), session: keyNames(keys.session, 'state.storageKeys.session'), cookies: keyNames(keys.cookies, 'state.storageKeys.cookies') },
    app: appState(s.app),
  };
}

function consoleEntry(x: unknown, i: number): ReporterConsoleEntry {
  const f = `console[${i}]`;
  if (!isObj(x)) throw invalid(f, 'A console entry.');
  const e: ReporterConsoleEntry = { ts: epochMs(x.ts, `${f}.ts`), level: oneOf(x.level, ['log', 'info', 'warn', 'error', 'debug'] as const, `${f}.level`, 'log'), text: str(x.text, T, `${f}.text`) };
  if (x.stack !== undefined && x.stack !== null) e.stack = str(x.stack, T, `${f}.stack`);
  return e;
}

function networkEntry(x: unknown, i: number): ReporterNetworkEntry {
  const f = `network[${i}]`;
  if (!isObj(x)) throw invalid(f, 'A network entry.');
  const e: ReporterNetworkEntry = {
    ts: epochMs(x.ts, `${f}.ts`),
    method: str(x.method, 12, `${f}.method`).toUpperCase() || 'GET',
    url: redactUrl(str(x.url, 2000, `${f}.url`)),
    status: numOrNull(x.status, `${f}.status`, { min: 0, max: 999 }),
    durationMs: numOrNull(x.durationMs, `${f}.durationMs`, { min: 0 }),
    initiator: oneOf(x.initiator, ['fetch', 'xhr', 'resource', 'beacon', 'websocket'] as const, `${f}.initiator`, 'resource'),
    sizeBytes: numOrNull(x.sizeBytes, `${f}.sizeBytes`, { min: 0 }),
  };
  if (x.error !== undefined && x.error !== null) e.error = str(x.error, 300, `${f}.error`);
  return e;
}

function componentNode(x: unknown, i: number): ReporterComponentNode {
  const f = `components[${i}]`;
  if (!isObj(x)) throw invalid(f, 'A component node.');
  const n: ReporterComponentNode = { name: str(x.name, 200, `${f}.name`), depth: num(x.depth, `${f}.depth`, { min: 0, max: 10000 }) };
  if (Array.isArray(x.props)) n.props = x.props.slice(0, 50).map((p, j) => str(p, 100, `${f}.props[${j}]`));
  if (typeof x.source === 'string') n.source = str(x.source, 300, `${f}.source`);
  return n;
}

function performance(v: unknown): ReporterPerformance {
  const p = isObj(v) ? v : {};
  const n = isObj(p.navigation) ? p.navigation : {};
  const w = isObj(p.vitals) ? p.vitals : {};
  const l = isObj(p.longTasks) ? p.longTasks : {};
  const m = isObj(p.memory) ? p.memory : {};
  const ms = (x: unknown, f: string) => numOrNull(x, f, { min: 0, max: 1e9 });
  return {
    navigation: { ttfbMs: ms(n.ttfbMs, 'performance.navigation.ttfbMs'), domContentLoadedMs: ms(n.domContentLoadedMs, 'performance.navigation.domContentLoadedMs'), loadMs: ms(n.loadMs, 'performance.navigation.loadMs'), type: strOrNull(n.type, 40, 'performance.navigation.type') },
    vitals: { lcpMs: ms(w.lcpMs, 'performance.vitals.lcpMs'), cls: numOrNull(w.cls, 'performance.vitals.cls', { min: 0, max: 1000 }), inpMs: ms(w.inpMs, 'performance.vitals.inpMs'), fcpMs: ms(w.fcpMs, 'performance.vitals.fcpMs') },
    longTasks: { count: numOrNull(l.count, 'performance.longTasks.count', { min: 0 }) ?? 0, totalMs: ms(l.totalMs, 'performance.longTasks.totalMs') ?? 0 },
    memory: { usedJsHeapBytes: numOrNull(m.usedJsHeapBytes, 'performance.memory.usedJsHeapBytes', { min: 0 }), totalJsHeapBytes: numOrNull(m.totalJsHeapBytes, 'performance.memory.totalJsHeapBytes', { min: 0 }) },
  };
}

function interaction(x: unknown, i: number): ReporterInteraction {
  const f = `interactions[${i}]`;
  if (!isObj(x)) throw invalid(f, 'An interaction.');
  const kind = oneOf(x.kind, ['click', 'input', 'change', 'submit', 'navigate', 'key', 'scroll'] as const, `${f}.kind`);
  const out: ReporterInteraction = { ts: epochMs(x.ts, `${f}.ts`), kind, selector: strOrNull(x.selector, 500, `${f}.selector`), label: strOrNull(x.label, 120, `${f}.label`) };
  // Input values are never kept, whatever the SDK sent: text is masked, only a select's label or a check state passes.
  if (x.value !== undefined && x.value !== null) {
    const v = str(x.value, 120, `${f}.value`);
    out.value = kind === 'input' ? '[masked]' : kind === 'change' && /^(checked|unchecked)$/.test(v) ? v : kind === 'change' ? v : '[masked]';
  }
  if (x.detail !== undefined && x.detail !== null) {
    const d = str(x.detail, 2000, `${f}.detail`);
    out.detail = kind === 'navigate' ? (d.startsWith('/') ? cleanPathLoose(d) : '') : kind === 'key' ? (/^(Enter|Escape|Tab|Arrow(Up|Down|Left|Right))$/.test(d) ? d : '') : d.slice(0, 120);
  }
  return out;
}

const cleanPathLoose = (p: string) => {
  try {
    return cleanPath(p);
  } catch {
    return '';
  }
};

function checkFinding(x: unknown, i: number): ReporterCheckFinding {
  const f = `checks.findings[${i}]`;
  if (!isObj(x)) throw invalid(f, 'A check finding.');
  return {
    source: oneOf(x.source, ['axe', 'target-size', 'contrast', 'overflow', 'truncation'] as const, `${f}.source`),
    rule: str(x.rule, 120, `${f}.rule`),
    severity: oneOf(x.severity, ['critical', 'serious', 'moderate', 'minor'] as const, `${f}.severity`, 'minor'),
    message: str(x.message, 500, `${f}.message`),
    selector: strOrNull(x.selector, 500, `${f}.selector`),
    help: strOrNull(x.help, 500, `${f}.help`),
  };
}

function checks(v: unknown): ReporterChecks {
  if (!isObj(v)) return { ran: false, error: 'The SDK sent no checks.', findings: [] };
  const findings = list(v.findings, REPORTER_LIMITS.checkFindings, 'checks.findings', checkFinding).items;
  const out: ReporterChecks = { ran: v.ran === true, findings };
  if (!out.ran) out.error = typeof v.error === 'string' && v.error ? str(v.error, 300, 'checks.error') : 'The checks did not run.';
  return out;
}

/**
 * Parses and cleans an evidence bundle. Refused (422) for a wrong schema version, a list over its cap, or a shape that is not the contract's;
 * every string is capped and redacted; app state is re-serialized; the result is what the server stores and shows.
 */
export function parseEvidence(bytes: Buffer): ReporterEvidence {
  if (bytes.length > REPORTER_LIMITS.evidenceBytes) throw new AppError('PAYLOAD_TOO_LARGE', `The evidence is larger than ${REPORTER_LIMITS.evidenceBytes / 1024 / 1024} MB.`);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalid('evidence', 'The evidence is not JSON.');
  }
  if (!isObj(raw)) throw invalid('evidence', 'The evidence is an object.');
  if (raw.schema !== REPORTER_EVIDENCE_SCHEMA) throw invalid('evidence.schema', `This portal reads evidence schema ${REPORTER_EVIDENCE_SCHEMA}.`);
  // One line each (quoted in the ticket description), capped and redacted like every string; empty ones dropped.
  const captureGaps = list(raw.captureGaps, REPORTER_LIMITS.captureGaps, 'captureGaps', (x, i) => lineOrNull(x, 200, `captureGaps[${i}]`)).items.filter(
    (g): g is string => !!g,
  );
  const dom = isObj(raw.dom) ? { selector: strOrNull(raw.dom.selector, 500, 'dom.selector'), path: str(raw.dom.path, 1000, 'dom.path'), snippet: str(raw.dom.snippet, T, 'dom.snippet') } : null;
  return {
    schema: REPORTER_EVIDENCE_SCHEMA,
    sdkVersion: str(raw.sdkVersion, 40, 'sdkVersion'),
    capturedAt: str(raw.capturedAt, 40, 'capturedAt'),
    page: page(raw.page),
    device: device(raw.device),
    state: state(raw.state),
    build: cleanBuild(raw.build),
    anchor: cleanAnchor(raw.anchor),
    dom,
    components: list(raw.components, REPORTER_LIMITS.componentNodes, 'components', componentNode).items,
    framework: strOrNull(raw.framework, 40, 'framework'),
    console: list(raw.console, REPORTER_LIMITS.consoleEntries, 'console', consoleEntry).items,
    network: list(raw.network, REPORTER_LIMITS.networkEntries, 'network', networkEntry).items,
    performance: performance(raw.performance),
    interactions: list(raw.interactions, REPORTER_LIMITS.interactionEntries, 'interactions', interaction).items,
    checks: checks(raw.checks),
    errorSignatures: list(raw.errorSignatures, 50, 'errorSignatures', (x, i) => str(x, 300, `errorSignatures[${i}]`)).items,
    ...(captureGaps.length ? { captureGaps } : {}),
  };
}

/**
 * The evidence of a page of THIS site (the token's origin), or refused (422): page.origin, page.url and page.host must name the site, and
 * page.path must be a path on it. Empty values are filled in from the site. Run before anything is stored or a repro is built from it, so a
 * page cannot point a ticket's steps or its Playwright file at another origin.
 */
export function pinEvidence(e: ReporterEvidence, origin: string): ReporterEvidence {
  const site = new URL(origin);
  const refuse = (f: string) => invalid(`evidence.page.${f}`, 'The evidence is not of this site.');
  if (e.page.origin && normalizeOrigin(e.page.origin) !== origin) throw refuse('origin');
  // The SDK sends location.hostname (no port); a port-ful site (http://localhost:3000) is still the same site.
  if (e.page.host && e.page.host.toLowerCase() !== site.host && e.page.host.toLowerCase() !== site.hostname) throw refuse('host');
  if (e.page.url) {
    let u: URL;
    try {
      u = new URL(e.page.url);
    } catch {
      throw refuse('url');
    }
    if (u.origin !== origin) throw refuse('url');
  }
  let path = '/';
  if (e.page.path) {
    try {
      path = pathOnly(cleanPath(e.page.path, 'evidence.page.path'));
    } catch {
      throw refuse('path');
    }
  }
  return { ...e, page: { ...e.page, origin, host: site.host, path } };
}

/** The few numbers a list row, a description and a duplicate search need from one evidence bundle. */
export function evidenceFacts(e: ReporterEvidence) {
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of e.checks.findings) counts[f.severity]++;
  return {
    consoleErrors: e.console.filter((c) => c.level === 'error').length,
    failedRequests: e.network.filter((n) => n.error !== undefined || (n.status !== null && n.status >= 400)).length,
    lcpMs: e.performance.vitals.lcpMs,
    checkCounts: counts,
    errorSignatures: e.errorSignatures,
  };
}
