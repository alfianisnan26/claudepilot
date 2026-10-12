// The Docker policy's decision (docs/prd/targets-connect.md §11.4, appendix A): given a request that normalised and matched a route,
// say what exact request the proxy sends to the daemon, or why it sends none. Profile `managed` is the only one in v1; the host
// operator can widen two things locally (`docker.allowImages`, `docker.allowBinds`), the portal can widen nothing.
//
// Three habits keep it honest. (1) The daemon never sees the client's request: only the one built here, from values this file checked
// (the query is rebuilt from validated keys, a JSON body is a new object from validated fields). (2) A container reference is resolved
// once and its FULL id is what the daemon is told, so the container that was checked is the one acted on. (3) Anything not matched is
// denied with a rule id (`CONNECT_DOCKER_RULES`), which the status message counts.
import type { ConnectDockerRule } from '@portal/contracts';
import { LABEL } from '../../../../workspaces/runtime.js';
import { ExecIds } from './execIds.js';
import {
  CONTAINER_NAME,
  VOLUME_NAME,
  flag,
  int,
  pullRef,
  queryOf,
  refuse,
  SIGNALS,
  type ImageAllow,
  type Refusal,
  type Route,
  type Target,
} from './rules.js';
import { validateCreate, validateExecCreate, validateExecStart, validateVolumeCreate, type Checked } from './schema.js';

export interface Upstream {
  method: string;
  /** With the client's API version prefix when it sent one. */
  path: string;
  /** Built from checked pairs, `''` for none. */
  query: string;
  body: { kind: 'none' } | { kind: 'json'; data: Buffer } | { kind: 'stream' };
  /** The client asked to take over the connection (`Upgrade: tcp`) and the route is the one place that is allowed. */
  upgrade: boolean;
  /** After the daemon answers: what the proxy learns from the response. */
  learn?: { kind: 'execCreate'; container: string };
}

export type Decision =
  | { allow: true; upstream: Upstream }
  /** `rule` is null for an answer that isn't a policy denial (a container that doesn't exist: 404; a daemon that doesn't answer: 502). */
  | { allow: false; status: number; rule: ConnectDockerRule | null; message: string };

export type Resolved = { state: 'found'; id: string; labels: Record<string, string> } | { state: 'missing' } | { state: 'error'; message: string };

export interface PolicyContext {
  /** The portal's id as the agent pinned it; null before it is known. */
  portalId(): string | null;
  images: ImageAllow;
  allowBinds: string[];
  /** Looks a container up by name or id (the proxy caches it for 2 s). */
  resolve(ref: string): Promise<Resolved>;
  execs: ExecIds;
}

export interface PolicyInput {
  method: string;
  target: Target;
  route: Route;
  /** The parsed JSON body of a route that has one; `undefined` when there was none. */
  body: unknown;
  upgrade: boolean;
}

const deny = (r: Refusal | { rule: ConnectDockerRule; message: string }): Decision => ({ allow: false, status: 403, rule: r.rule, message: r.message });
const denyWith = (rule: ConnectDockerRule, message: string): Decision => deny(refuse(rule, message));

const allow = (target: Target, method: string, path: string, pairs: [string, string][] = [], rest: Partial<Upstream> = {}): Decision => ({
  allow: true,
  upstream: { method, path: `${target.version ?? ''}${path}`, query: queryOf(pairs), body: { kind: 'none' }, upgrade: false, ...rest },
});

/** Whether the labels say this portal's workspace: the managed label, and the portal's id when the agent knows it. */
export function isManaged(labels: Record<string, string> | null | undefined, portalId: string | null): boolean {
  if (!labels || labels[LABEL.managed] !== 'true') return false;
  return portalId === null || labels[LABEL.portal] === portalId;
}

/** A container the policy may act on: resolved, managed, and named by its full id from here on. */
async function managed(ref: string, ctx: PolicyContext): Promise<{ id: string } | Decision> {
  const found = await ctx.resolve(ref);
  if (found.state === 'missing') return { allow: false, status: 404, rule: null, message: `No such container: ${ref}` };
  if (found.state === 'error') return { allow: false, status: 502, rule: null, message: 'The Docker daemon did not answer.' };
  if (!/^[0-9a-f]{64}$/.test(found.id) || !isManaged(found.labels, ctx.portalId())) return denyWith('unmanaged', 'That container is not one of this portal’s workspaces.');
  return { id: found.id };
}

const isDecision = (x: { id: string } | Decision): x is Decision => 'allow' in x;

const parseJsonObject = (text: string | null): Record<string, unknown> | null | undefined => {
  if (text === null) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const stringList = (v: unknown, max = 32): string[] | null => {
  if (Array.isArray(v)) return v.length <= max && v.every((x) => typeof x === 'string' && x.length <= 256 && !/[\0-\x1f]/.test(x)) ? (v as string[]) : null;
  // the older map form {"running": true}
  if (v && typeof v === 'object') return Object.keys(v).length <= max && Object.keys(v).every((k) => k.length <= 256) ? Object.keys(v) : null;
  return null;
};

/** The labels `list` and `events` are always filtered by. */
export const forcedLabels = (portalId: string | null): string[] => [`${LABEL.managed}=true`, ...(portalId ? [`${LABEL.portal}=${portalId}`] : [])];

export async function decide(input: PolicyInput, ctx: PolicyContext): Promise<Decision> {
  const { method, target, route } = input;
  const q = target.query;
  const bad = (rule: ConnectDockerRule, what: string) => denyWith(rule, what);

  if (input.upgrade && route.kind !== 'execStart') return bad('upgrade', 'Taking over the connection is only allowed to start an exec.');

  switch (route.kind) {
    case 'ping':
      return allow(target, method, '/_ping');
    case 'version':
      return allow(target, method, '/version');
    case 'info':
      return allow(target, method, '/info');

    case 'events': {
      const pairs: [string, string][] = [];
      for (const key of ['since', 'until'] as const) {
        const v = q.get(key);
        if (v === null) continue;
        if (!/^\d{1,12}(?:\.\d{1,9})?$/.test(v)) return bad('events.filter', `${key} is not a time.`);
        pairs.push([key, v]);
      }
      const given = parseJsonObject(q.get('filters'));
      if (given === null) return bad('events.filter', 'filters is not a JSON object.');
      const events = given?.event === undefined ? [] : stringList(given.event);
      if (!events || events.some((e) => !/^[a-z_]{2,24}$/.test(e))) return bad('events.filter', 'The event filter is not valid.');
      // Whatever the client asked, it only gets container events of this portal's workspaces.
      const filters = { type: ['container'], label: forcedLabels(ctx.portalId()), ...(events.length ? { event: events } : {}) };
      pairs.push(['filters', JSON.stringify(filters)]);
      return allow(target, method, '/events', pairs);
    }

    case 'list': {
      const pairs: [string, string][] = [];
      for (const key of ['all', 'size'] as const) {
        const v = q.get(key);
        if (v === null) continue;
        const f = flag(v);
        if (f === null) return bad('path', `${key} must be true or false.`);
        pairs.push([key, String(f)]);
      }
      const limit = q.get('limit');
      if (limit !== null) {
        const n = int(limit, 0, 100_000);
        if (n === null) return bad('path', 'limit is not a number.');
        pairs.push(['limit', String(n)]);
      }
      const given = parseJsonObject(q.get('filters'));
      if (given === null) return bad('path', 'filters is not a JSON object.');
      const filters: Record<string, string[]> = {};
      for (const key of ['name', 'status', 'id'] as const) {
        if (given?.[key] === undefined) continue;
        const list = stringList(given[key]);
        if (!list) return bad('path', `The ${key} filter is not valid.`);
        filters[key] = list;
      }
      // Other filter keys are dropped (the list is already only this portal's workspaces); the client's labels are kept and ANDed with ours.
      const labels = given?.label === undefined ? [] : stringList(given.label);
      if (!labels) return bad('path', 'The label filter is not valid.');
      filters.label = [...labels, ...forcedLabels(ctx.portalId())];
      pairs.push(['filters', JSON.stringify(filters)]);
      return allow(target, method, '/containers/json', pairs);
    }

    case 'create': {
      const name = q.get('name');
      if (!name || !CONTAINER_NAME.test(name)) return bad('create.name', 'The name must be claudepilot- and a plain name.');
      const platform = q.get('platform');
      if (platform !== null && !/^[a-z0-9]+(?:\/[a-z0-9._-]+){1,2}$/.test(platform)) return bad('create.field', 'platform is not valid.');
      const checked = validateCreate(input.body, { name, images: ctx.images, portalId: ctx.portalId(), allowBinds: ctx.allowBinds });
      if (!checked.ok) return deny(checked);
      // dockerode repeats every field of the body in the query string; the daemon reads `name` and `platform` only, so only those go on.
      const pairs: [string, string][] = [['name', name]];
      if (platform !== null) pairs.push(['platform', platform]);
      return allow(target, method, '/containers/create', pairs, { body: { kind: 'json', data: Buffer.from(JSON.stringify(checked.body)) } });
    }

    case 'inspect': {
      const size = q.get('size');
      if (size !== null && flag(size) === null) return bad('path', 'size must be true or false.');
      const c = await managed(route.ref!, ctx);
      if (isDecision(c)) return c;
      return allow(target, method, `/containers/${c.id}/json`, size === null ? [] : [['size', String(flag(size))]]);
    }

    case 'action': {
      const pairs: [string, string][] = [];
      const t = q.get('t');
      if (t !== null) {
        const n = int(t, 0, 3600);
        if (n === null) return bad('path', 't is not a number of seconds.');
        pairs.push(['t', String(n)]);
      }
      const signal = q.get('signal');
      if (signal !== null) {
        if (!SIGNALS.has(signal)) return bad('path', 'That signal is not allowed.');
        pairs.push(['signal', signal]);
      }
      const condition = q.get('condition');
      if (condition !== null) {
        if (!['not-running', 'next-exit', 'removed'].includes(condition)) return bad('path', 'That wait condition is not allowed.');
        pairs.push(['condition', condition]);
      }
      const c = await managed(route.ref!, ctx);
      if (isDecision(c)) return c;
      return allow(target, method, `/containers/${c.id}/${route.verb}`, pairs);
    }

    case 'kill': {
      const signal = q.get('signal');
      if (signal !== null && !SIGNALS.has(signal)) return bad('path', 'That signal is not allowed.');
      const c = await managed(route.ref!, ctx);
      if (isDecision(c)) return c;
      return allow(target, method, `/containers/${c.id}/kill`, signal === null ? [] : [['signal', signal]]);
    }

    case 'remove': {
      const pairs: [string, string][] = [];
      for (const key of ['force', 'v'] as const) {
        const v = q.get(key);
        if (v === null) continue;
        const f = flag(v);
        if (f === null) return bad('path', `${key} must be true or false.`);
        pairs.push([key, String(f)]);
      }
      const c = await managed(route.ref!, ctx);
      if (isDecision(c)) return c;
      return allow(target, method, `/containers/${c.id}`, pairs);
    }

    case 'execCreate': {
      const checked: Checked = validateExecCreate(input.body);
      if (!checked.ok) return deny(checked);
      const c = await managed(route.ref!, ctx);
      if (isDecision(c)) return c;
      return allow(target, method, `/containers/${c.id}/exec`, [], {
        body: { kind: 'json', data: Buffer.from(JSON.stringify(checked.body)) },
        learn: { kind: 'execCreate', container: c.id },
      });
    }

    case 'execStart': {
      if (!ctx.execs.get(route.ref!)) return bad('unmanaged', 'That exec was not made through this agent.');
      const checked = validateExecStart(input.body);
      if (!checked.ok) return deny(checked);
      return allow(target, method, `/exec/${route.ref}/start`, [], { body: { kind: 'json', data: Buffer.from(JSON.stringify(checked.body)) }, upgrade: input.upgrade });
    }

    case 'execResize': {
      if (!ctx.execs.get(route.ref!)) return bad('unmanaged', 'That exec was not made through this agent.');
      const pairs: [string, string][] = [];
      for (const key of ['h', 'w'] as const) {
        const v = q.get(key);
        if (v === null) continue;
        const n = int(v, 0, 10_000);
        if (n === null) return bad('path', `${key} is not a size.`);
        pairs.push([key, String(n)]);
      }
      return allow(target, method, `/exec/${route.ref}/resize`, pairs);
    }

    case 'execInspect':
      if (!ctx.execs.get(route.ref!)) return bad('unmanaged', 'That exec was not made through this agent.');
      return allow(target, method, `/exec/${route.ref}/json`);

    case 'stats':
    case 'logs': {
      const pairs: [string, string][] = [];
      const flags = route.kind === 'stats' ? ['stream', 'one-shot'] : ['follow', 'stdout', 'stderr', 'timestamps'];
      for (const key of flags) {
        const v = q.get(key);
        if (v === null) continue;
        const f = flag(v);
        if (f === null) return bad('path', `${key} must be true or false.`);
        pairs.push([key, String(f)]);
      }
      if (route.kind === 'logs') {
        for (const key of ['since', 'until'] as const) {
          const v = q.get(key);
          if (v === null) continue;
          if (!/^\d{1,12}(?:\.\d{1,9})?$/.test(v)) return bad('path', `${key} is not a time.`);
          pairs.push([key, v]);
        }
        const tail = q.get('tail');
        if (tail !== null) {
          if (tail !== 'all' && int(tail, 0, 1_000_000) === null) return bad('path', 'tail is not a number.');
          pairs.push(['tail', tail]);
        }
      }
      const c = await managed(route.ref!, ctx);
      if (isDecision(c)) return c;
      return allow(target, method, `/containers/${c.id}/${route.kind}`, pairs);
    }

    case 'archive': {
      const path = q.get('path');
      if (!path || path.length > 4096 || path.includes('\0')) return bad('path', 'The archive needs a path.');
      const pairs: [string, string][] = [['path', path]];
      for (const key of ['noOverwriteDirNonDir', 'copyUIDGID'] as const) {
        const v = q.get(key);
        if (v === null) continue;
        const f = flag(v);
        if (f === null) return bad('path', `${key} must be true or false.`);
        pairs.push([key, String(f)]);
      }
      const c = await managed(route.ref!, ctx);
      if (isDecision(c)) return c;
      return allow(target, method, `/containers/${c.id}/archive`, pairs, method === 'PUT' ? { body: { kind: 'stream' } } : {});
    }

    case 'volumeCreate': {
      const checked = validateVolumeCreate(input.body);
      if (!checked.ok) return deny(checked);
      return allow(target, method, '/volumes/create', [], { body: { kind: 'json', data: Buffer.from(JSON.stringify(checked.body)) } });
    }

    case 'volumeInspect':
    case 'volumeRemove': {
      if (!VOLUME_NAME.test(route.ref!)) return bad('volume.name', 'That volume name is not allowed.');
      const pairs: [string, string][] = [];
      const force = q.get('force');
      if (route.kind === 'volumeRemove' && force !== null) {
        const f = flag(force);
        if (f === null) return bad('path', 'force must be true or false.');
        pairs.push(['force', String(f)]);
      }
      return allow(target, method, `/volumes/${route.ref}`, pairs);
    }

    case 'imageInspect':
      if (!ctx.images.has(route.ref!)) return bad('image.ref', 'That image is not allowed on this host.');
      return allow(target, method, `/images/${route.ref}/json`);

    case 'imagePull': {
      for (const key of ['fromSrc', 'changes', 'message', 'repo']) {
        if (q.has(key)) return bad('image.ref', `${key} is not allowed.`);
      }
      const from = q.get('fromImage');
      const ref = from ? pullRef(from, q.get('tag')) : null;
      if (!from || !ref || !ctx.images.has(ref)) return bad('image.ref', 'That image is not allowed on this host.');
      const pairs: [string, string][] = [['fromImage', from]];
      const tag = q.get('tag');
      if (tag !== null) pairs.push(['tag', tag]);
      const platform = q.get('platform');
      if (platform !== null) {
        if (!/^[a-z0-9]+(?:\/[a-z0-9._-]+){1,2}$/.test(platform)) return bad('image.ref', 'platform is not valid.');
        pairs.push(['platform', platform]);
      }
      return allow(target, method, '/images/create', pairs);
    }
  }
}
