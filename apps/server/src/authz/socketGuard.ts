// THE SOCKET GUARD (T-1043 S0b, D-82): what the route guard (routeGuard.ts) is for HTTP, for every WebSocket upgrade. A socket module never
// listens for `upgrade` itself: it calls `onSocket(server, path, deps, handler)`, and the guard runs the path's DECLARED socket policy
// (`declareSocketPolicies`, in the module's `authz.ts`) through the one `can()` (the HTTP guard's own `decidePolicy`), for the real actor:
//
//   - The handshake (`connect`): a `public`, `bearer` or `handler` socket is its own door (the agents' tunnel: its own node-key handshake) and
//     goes on. Any other: the Origin must be this host (403), someone must be signed in (401), the founding owner goes on untouched (today's
//     behaviour), anyone else is refused a socket with no declaration, and otherwise asks `can()` on what `connect` declares.
//   - Each message (`grant.allows(type, message)`): the founding owner is let through; anyone else is refused a message type with no
//     declaration, and otherwise asks `can()` on what that type declares (`from: 'body'` reads the message's own fields).
//   - Every refusal is closed like an unknown target: the handshake answers the same `404 Not Found` an upgrade nobody serves gets (sockets.ts),
//     a refused message gets what its module answers for an object that does not exist. Neither names the topic, the session or the path.
// It only ever refuses: each module's own checks (its sign-in check, which still refuses a member account: MU2 S1a) stay, and the socket
// guard in sockets.ts still cuts a socket when the sign-in that opened it ends.

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Actor, RoutePolicy } from '@portal/contracts';
import { actorOfSignedIn, decidePolicy, isFoundingOwner, type PolicyReader, type RouteGuardDeps, type SignedIn } from './routeGuard.js';

/** What one socket declares: its handshake, and each message type it acts on. */
export interface SocketPolicy {
  /** The handshake, read off its path params (`/:target/:name`) and its query. */
  connect: RoutePolicy;
  /** Each typed message the module acts on, by its `type`. A message type with no row is refused to anyone but the founding owner. */
  messages: Record<string, RoutePolicy>;
  /** What untyped frames (a terminal's bytes, a screen's stream) act on, when there are any: they act on what `connect` checked. */
  frames?: string;
}

/** A socket's declarations, keyed by its path as the module serves it (`/api/workspaces/:target/:name/shell`). */
export type SocketPolicies = Record<string, SocketPolicy>;

const declared = new Map<string, { module: string; policy: SocketPolicy }>();

/** Declares a module's sockets. The same path twice is fine when it is the same declaration (modules load more than once in tests). */
export function declareSocketPolicies(module: string, policies: SocketPolicies): void {
  for (const [path, policy] of Object.entries(policies)) {
    const had = declared.get(path);
    if (had && JSON.stringify(had.policy) !== JSON.stringify(policy)) throw new Error(`The socket ${path} is declared twice, differently (${had.module}, ${module}).`);
    declared.set(path, { module, policy });
  }
}

export const socketPolicyFor = (path: string): SocketPolicy | undefined => declared.get(path)?.policy;
export const declaredSockets = (): string[] => [...declared.keys()];

/** The name every guarded `upgrade` listener carries, so a test tells them from a module that listens by itself. */
export const SOCKET_GUARD_NAME = 'socketGuard';

/** Every path a module attached through `onSocket`, in this process (the enumeration test reads it). */
const attached = new Set<string>();
export const attachedSockets = (): string[] => [...attached];

export interface SocketDeps {
  /** Who the handshake's cookie signs in (the same answer the HTTP guard gets). */
  signedIn(req: IncomingMessage): SignedIn;
  idOf?: RouteGuardDeps['idOf'];
}

/** What the handler gets: who is on the connection, the handshake's params and URL, and the check for each message. */
export interface SocketGrant {
  actor: Actor;
  params: Record<string, string>;
  url: URL;
  /** Whether this connection's actor may act with a message of this type (its declared policy, through `can()`). Never throws. */
  allows(type: string, message: Record<string, unknown>): Promise<boolean>;
}

export type SocketHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, grant: SocketGrant) => void;

/** `/a/:b/c` as an exact match, each param one path segment. */
function compile(path: string): { re: RegExp; names: string[] } {
  const names: string[] = [];
  const source = path
    .split('/')
    .map((part) => (part.startsWith(':') ? (names.push(part.slice(1)), '([^/]+)') : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return { re: new RegExp(`^${source}$`), names };
}

/** Browsers send cookies on cross-site WebSocket handshakes, so the Origin must be this host. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** The answer an upgrade nobody serves gets (sockets.ts), so a refused handshake reads exactly like an unknown path. */
export const UPGRADE_NOT_FOUND = 'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

function refuse(socket: Duplex, status: 401 | 403 | 404) {
  if (status === 404) return void socket.end(UPGRADE_NOT_FOUND);
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const OPEN_KINDS = new Set<RoutePolicy['kind']>(['public', 'bearer', 'handler']);

/** A socket's reader: its path params (a name not among them is read from the query, so `target+name+term` can join both), its query, and a message as its body. */
function socketReader(params: Record<string, string>, url: URL, body: Record<string, unknown>): PolicyReader {
  return {
    path: (name) => params[name] ?? url.searchParams.get(name) ?? undefined,
    query: (name, many) => (many ? url.searchParams.getAll(name) : (url.searchParams.get(name) ?? undefined)),
    body: () => body,
  };
}

/** Whether `policy` lets `actor` through. A refusal of any kind (or a hand-on, which a socket has no next route for) is false. */
async function allowed(read: PolicyReader, actor: Actor, policy: RoutePolicy | undefined, idOf: SocketDeps['idOf']): Promise<boolean> {
  if (!policy) return false;
  try {
    return (await decidePolicy(read, actor, policy, idOf)) === 'allow';
  } catch {
    return false;
  }
}

/**
 * Attaches one socket module's path, behind the guard. `handler` runs only for a handshake the declaration allows, with the connection's
 * grant; for a path that is not this one it never runs (another module's, or Vite's). Returns what takes the listener off again (the
 * agents' hub detaches when it closes).
 */
export function onSocket(server: Server, path: string, deps: SocketDeps, handler: SocketHandler): () => void {
  const { re, names } = compile(path);
  attached.add(path);
  const listener = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = re.exec(url.pathname);
    if (!m) return;
    const params: Record<string, string> = {};
    try {
      names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1] ?? '')));
    } catch {
      return refuse(socket, 404);
    }
    const policy = socketPolicyFor(path);
    const grant = (actor: Actor, owner: boolean): SocketGrant => ({
      actor,
      params,
      url,
      allows: async (type, message) => owner || allowed(socketReader(params, url, message), actor, policy?.messages[type], deps.idOf),
    });
    if (policy && OPEN_KINDS.has(policy.connect.kind)) return handler(req, socket, head, grant(actorOfSignedIn(null), false));
    if (!sameOrigin(req)) return refuse(socket, 403);
    const actor = actorOfSignedIn(deps.signedIn(req));
    if (actor.kind === 'anonymous') return refuse(socket, 401);
    if (isFoundingOwner(actor)) return handler(req, socket, head, grant(actor, true));
    // Not the owner: no declaration, or one that does not allow this actor, is the unknown path's 404 (it never tells the socket is there).
    void allowed(socketReader(params, url, {}), actor, policy?.connect, deps.idOf).then(
      (ok) => (ok && !socket.destroyed ? handler(req, socket, head, grant(actor, false)) : refuse(socket, 404)),
      () => refuse(socket, 404),
    );
  };
  Object.defineProperty(listener, 'name', { value: SOCKET_GUARD_NAME });
  server.on('upgrade', listener);
  return () => void server.off('upgrade', listener);
}
