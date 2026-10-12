// The Docker policy's request side (docs/prd/targets-connect.md §11.4 and appendix A): normalising a request target, matching it
// against the table of what a managed workspace needs, and the small validators for query parameters. Nothing here talks to Docker.
//
// The default is deny: a route that is not in `ROUTES` is refused, a method the route doesn't list is refused, and every query parameter
// the proxy forwards is one it validated here (the proxy rebuilds the query from them, so what the daemon sees is what was checked).
import type { ConnectDockerRule } from '@portal/contracts';

/** Why a request was refused, or what to do about a request that matched. */
export interface Refusal {
  rule: ConnectDockerRule;
  message: string;
}

export const refuse = (rule: ConnectDockerRule, message: string): Refusal => ({ rule, message });

export interface Target {
  /** `/v1.46` or null: kept, because the client chose the API version, and forwarded as it came. */
  version: string | null;
  /** The path without the version prefix: no `//`, `.`/`..` segment, NUL, backslash, `%` or control character. */
  path: string;
  query: URLSearchParams;
}

const VERSION = /^\/(v\d{1,2}\.\d{1,3})(?=\/|$)/;

/** Normalises a raw request target (origin-form only). */
export function normalizeTarget(raw: string): Target | Refusal {
  if (!raw.startsWith('/') || raw.startsWith('//')) return refuse('path', 'The request target must be a path.');
  const q = raw.indexOf('?');
  const rawPath = q < 0 ? raw : raw.slice(0, q);
  const rawQuery = q < 0 ? '' : raw.slice(q + 1);
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f\x7f-￿\\%]/.test(rawPath)) return refuse('path', 'The path has a character the policy does not allow (control, non-ASCII, backslash or %-encoding).');
  if (rawPath.includes('//') || /(^|\/)\.\.?(\/|$)/.test(rawPath)) return refuse('path', 'The path has an empty or relative segment.');
  if (rawPath.length > 1 && rawPath.endsWith('/')) return refuse('path', 'The path ends in a slash.');
  if (rawPath.length > 2048 || rawQuery.length > 8192) return refuse('path', 'The request target is too long.');
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f\x7f]/.test(rawQuery)) return refuse('path', 'The query has a control character.');
  const version = VERSION.exec(rawPath);
  const path = version ? rawPath.slice(version[0].length) || '/' : rawPath;
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(rawQuery);
  } catch {
    return refuse('path', 'The query is not valid.');
  }
  return { version: version ? `/${version[1]}` : null, path, query };
}

export const isRefusal = (x: object): x is Refusal => 'rule' in x && 'message' in x && !('path' in x);

/** What a request is, once its path and method match the table. */
export type RouteKind =
  | 'ping'
  | 'version'
  | 'info'
  | 'events'
  | 'list'
  | 'create'
  | 'inspect'
  | 'action'
  | 'kill'
  | 'remove'
  | 'execCreate'
  | 'execStart'
  | 'execResize'
  | 'execInspect'
  | 'stats'
  | 'logs'
  | 'archive'
  | 'volumeCreate'
  | 'volumeInspect'
  | 'volumeRemove'
  | 'imageInspect'
  | 'imagePull';

export interface Route {
  kind: RouteKind;
  /** The container reference, exec id, volume name or image reference the path names. */
  ref?: string;
  /** `start`, `stop` … for `action`. */
  verb?: string;
  /** The request carries a JSON body the policy reads and checks (anything else is streamed or empty). */
  json: boolean;
}

const REF = '[A-Za-z0-9][A-Za-z0-9_.-]{0,254}';
/** A container reference is never one of the collection's own words (`/containers/json`, `/containers/create`, `/containers/prune`). */
const CREF = `(?!(?:json|create|prune)$)${REF}`;

interface Entry {
  methods: string[];
  pattern: RegExp;
  make: (m: RegExpExecArray, method: string) => Route;
}

const entry = (methods: string[], pattern: RegExp, make: (m: RegExpExecArray, method: string) => Route): Entry => ({ methods, pattern, make });

const ROUTES: Entry[] = [
  entry(['GET', 'HEAD'], /^\/_ping$/, () => ({ kind: 'ping', json: false })),
  entry(['GET'], /^\/version$/, () => ({ kind: 'version', json: false })),
  entry(['GET'], /^\/info$/, () => ({ kind: 'info', json: false })),
  entry(['GET'], /^\/events$/, () => ({ kind: 'events', json: false })),
  entry(['GET'], /^\/containers\/json$/, () => ({ kind: 'list', json: false })),
  entry(['POST'], /^\/containers\/create$/, () => ({ kind: 'create', json: true })),
  entry(['GET'], new RegExp(`^/containers/(${CREF})/json$`), (m) => ({ kind: 'inspect', ref: m[1]!, json: false })),
  entry(['POST'], new RegExp(`^/containers/(${CREF})/(start|stop|restart|pause|unpause|wait)$`), (m) => ({ kind: 'action', ref: m[1]!, verb: m[2]!, json: false })),
  entry(['POST'], new RegExp(`^/containers/(${CREF})/kill$`), (m) => ({ kind: 'kill', ref: m[1]!, json: false })),
  entry(['DELETE'], new RegExp(`^/containers/(${CREF})$`), (m) => ({ kind: 'remove', ref: m[1]!, json: false })),
  entry(['POST'], new RegExp(`^/containers/(${CREF})/exec$`), (m) => ({ kind: 'execCreate', ref: m[1]!, json: true })),
  entry(['POST'], /^\/exec\/([0-9a-f]{64})\/start$/, (m) => ({ kind: 'execStart', ref: m[1]!, json: true })),
  entry(['POST'], /^\/exec\/([0-9a-f]{64})\/resize$/, (m) => ({ kind: 'execResize', ref: m[1]!, json: false })),
  entry(['GET'], /^\/exec\/([0-9a-f]{64})\/json$/, (m) => ({ kind: 'execInspect', ref: m[1]!, json: false })),
  entry(['GET'], new RegExp(`^/containers/(${CREF})/stats$`), (m) => ({ kind: 'stats', ref: m[1]!, json: false })),
  entry(['GET'], new RegExp(`^/containers/(${CREF})/logs$`), (m) => ({ kind: 'logs', ref: m[1]!, json: false })),
  entry(['PUT', 'GET', 'HEAD'], new RegExp(`^/containers/(${CREF})/archive$`), (m) => ({ kind: 'archive', ref: m[1]!, json: false })),
  entry(['POST'], /^\/volumes\/create$/, () => ({ kind: 'volumeCreate', json: true })),
  entry(['GET'], /^\/volumes\/(?!(?:create|prune)$)([^/]+)$/, (m) => ({ kind: 'volumeInspect', ref: m[1]!, json: false })),
  entry(['DELETE'], /^\/volumes\/(?!(?:create|prune)$)([^/]+)$/, (m) => ({ kind: 'volumeRemove', ref: m[1]!, json: false })),
  entry(['GET'], /^\/images\/(.+)\/json$/, (m) => ({ kind: 'imageInspect', ref: m[1]!, json: false })),
  entry(['POST'], /^\/images\/create$/, () => ({ kind: 'imagePull', json: false })),
];

/** Matches a method and a normalised path against the table. `method` when only the method is wrong, `build` for the image-build API, `path` otherwise. */
export function classify(method: string, path: string): Route | Refusal {
  let wrongMethod = false;
  for (const e of ROUTES) {
    const m = e.pattern.exec(path);
    if (!m) continue;
    if (e.methods.includes(method)) return e.make(m, method);
    wrongMethod = true;
  }
  if (wrongMethod) return refuse('method', `${method} is not allowed on this path.`);
  if (path === '/build' || path.startsWith('/build/')) return refuse('build', 'Building images through the tunnel is not allowed.');
  return refuse('path', 'This part of the Docker API is not available through the tunnel.');
}

/* ---------------------------------------------------------------------------------------------------------------------------- *
 * Query parameters
 * ---------------------------------------------------------------------------------------------------------------------------- */

/** `1`, `0`, `true` or `false` (what Docker clients send). */
export const flag = (v: string | null): boolean | null => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : null);
export const int = (v: string | null, min = 0, max = 1_000_000_000): number | null => (v !== null && /^-?\d{1,12}$/.test(v) && Number(v) >= min && Number(v) <= max ? Number(v) : null);

/** The signals `kill` and `stop` may name (PRD appendix A). */
export const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', '15', '9', '2', '1']);

/** Builds a query string from checked pairs. */
export function queryOf(pairs: [string, string][]): string {
  const out = new URLSearchParams();
  for (const [k, v] of pairs) out.append(k, v);
  return out.toString();
}

/* ---------------------------------------------------------------------------------------------------------------------------- *
 * Names and images
 * ---------------------------------------------------------------------------------------------------------------------------- */

/** Containers the portal may create: `claudepilot-<plain name>` (PRD appendix A). */
export const CONTAINER_NAME = /^claudepilot-[a-z0-9][a-z0-9._-]{0,62}$/;
/** Volumes: a workspace's home volume. */
export const VOLUME_NAME = /^claudepilot-[a-z0-9][a-z0-9._-]*-home$/;

/** `ghcr.io/x/y` → itself with `:latest` when it names no tag or digest; `docker.io/library/` and `docker.io/` expanded away. */
export function normalizeImageRef(ref: string): string {
  let r = ref.trim();
  r = r.replace(/^(?:index\.)?docker\.io\//, '').replace(/^library\//, '');
  const lastSlash = r.lastIndexOf('/');
  const tail = r.slice(lastSlash + 1);
  if (!tail.includes(':') && !tail.includes('@')) r += ':latest';
  return r;
}

/** The references containers may be created from. An exact match after normalising both sides. */
export class ImageAllow {
  readonly #set: Set<string>;

  constructor(refs: string[]) {
    this.#set = new Set(refs.filter(Boolean).map(normalizeImageRef));
  }

  has(ref: string): boolean {
    return this.#set.has(normalizeImageRef(ref));
  }

  list(): string[] {
    return [...this.#set];
  }
}

/** A plain reference as `fromImage` and `tag` of an image pull, joined; null when it isn't shaped like one. */
export function pullRef(fromImage: string, tag: string | null): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(fromImage)) return null;
  if (tag !== null && !/^[A-Za-z0-9_][A-Za-z0-9_.:@-]{0,127}$/.test(tag)) return null;
  if (!tag) return fromImage;
  return tag.startsWith('sha256:') ? `${fromImage}@${tag}` : `${fromImage}:${tag}`;
}
