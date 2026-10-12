// What an agent says about itself is untrusted text (docs/prd/targets-connect.md §17.3): hostnames, versions, error messages, a Docker engine's
// words. Everything that arrives in `auth`, `POST enroll` and `control` passes through these functions before it is stored, shown or logged:
// only the known fields survive, every string is cleaned (escapes and control characters out), clipped and run through the secret redactors,
// every number is checked and every list is capped. Nothing here throws on junk: it returns what is usable, or null.

import {
  CONNECT_DOCKER_RULES,
  CONNECT_KINDS,
  type ConnectAgentHello,
  type ConnectDockerInfo,
  type ConnectHostUsage,
  type ConnectKind,
  type ConnectLogMessage,
  type ConnectServiceStatus,
  type ConnectStatusMessage,
} from '@portal/contracts';
import { cleanText } from '../portalmcp/sanitize.js';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A short single-line text: cleaned, redacted, clipped. */
export function text(v: unknown, max: number): string {
  return typeof v === 'string' ? cleanText(v, max).replace(/\s+/g, ' ').trim() : '';
}

function int(v: unknown, min: number, max: number, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback;
}

function num(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null;
}

function iso(v: unknown, fallback: Date): string {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback.toISOString();
}

function services(v: unknown): ConnectServiceStatus[] {
  if (!Array.isArray(v)) return [];
  const out: ConnectServiceStatus[] = [];
  for (const s of v.slice(0, 3)) {
    if (!isObject(s) || (s.name !== 'docker' && s.name !== 'kube' && s.name !== 'host')) continue;
    const item: ConnectServiceStatus = { name: s.name, ok: s.ok === true };
    const error = text(s.error, 200);
    const version = text(s.version, 60);
    if (error) item.error = error;
    if (version) item.version = version;
    out.push(item);
  }
  return out;
}

const SWARM_ROLES = ['manager', 'worker'] as const;
function swarm(v: unknown): { nodeId: string; role: 'manager' | 'worker' } | undefined {
  if (!isObject(v)) return undefined;
  const role = (SWARM_ROLES as readonly unknown[]).includes(v.role) ? (v.role as 'manager' | 'worker') : null;
  const nodeId = text(v.nodeId, 64);
  return role && nodeId ? { nodeId, role } : undefined;
}

/** The hello of `auth` and `POST enroll`; null when it is not an object or its `mode` is not a kind (nothing can be said about such an agent). */
export function cleanHello(v: unknown, now: Date = new Date()): ConnectAgentHello | null {
  if (!isObject(v)) return null;
  if (!(CONNECT_KINDS as readonly unknown[]).includes(v.mode)) return null;
  const hello: ConnectAgentHello = {
    agentVersion: text(v.agentVersion, 40),
    agentBuild: text(v.agentBuild, 24),
    protocol: int(v.protocol, 0, 1_000),
    os: text(v.os, 32),
    arch: text(v.arch, 32),
    hostname: text(v.hostname, 80),
    mode: v.mode as ConnectKind,
    runtime: v.runtime === 'container' || v.runtime === 'pod' ? v.runtime : 'host',
    services: services(v.services),
    clock: iso(v.clock, now),
    startedAt: iso(v.startedAt, now),
  };
  const portalId = text(v.portalId, 64);
  if (portalId) hello.portalId = portalId;
  const sw = swarm(v.swarm);
  if (sw) hello.swarm = sw;
  return hello;
}

function usage(v: unknown): ConnectHostUsage | undefined {
  if (!isObject(v)) return undefined;
  return {
    cpuPercent: num(v.cpuPercent, 0, 100_000),
    memoryBytes: num(v.memoryBytes, 0, 2 ** 50),
    cores: num(v.cores, 0, 100_000),
    memoryTotalBytes: num(v.memoryTotalBytes, 0, 2 ** 50),
  };
}

function dockerInfo(v: unknown): ConnectDockerInfo | undefined {
  if (!isObject(v)) return undefined;
  const images = Array.isArray(v.images) ? v.images.slice(0, 20).map((i) => text(i, 200)).filter(Boolean) : [];
  return {
    engine: text(v.engine, 40),
    apiVersion: text(v.apiVersion, 20),
    os: text(v.os, 32),
    arch: text(v.arch, 32),
    ncpu: int(v.ncpu, 0, 4_096),
    memTotal: int(v.memTotal, 0, 2 ** 50),
    containers: int(v.containers, 0, 1_000_000),
    running: int(v.running, 0, 1_000_000),
    desktop: v.desktop === true,
    images,
  };
}

const RULES = new Set<string>(CONNECT_DOCKER_RULES);

/** A `status` of the control stream; null when it is not an object. */
export function cleanStatus(v: unknown, now: Date = new Date()): ConnectStatusMessage | null {
  if (!isObject(v)) return null;
  const status: ConnectStatusMessage = { t: 'status', at: iso(v.at, now), services: services(v.services) };
  const u = usage(v.usage);
  if (u) status.usage = u;
  const d = dockerInfo(v.docker);
  if (d) status.docker = d;
  const sw = swarm(v.swarm);
  if (sw) status.swarm = sw;
  if (Array.isArray(v.denied)) {
    status.denied = v.denied
      .slice(0, 40)
      .filter(isObject)
      .map((x) => ({ rule: text(x.rule, 40), count: int(x.count, 0, 1_000_000_000) }))
      .filter((x) => /^[a-z][a-z.]*$/.test(x.rule) && x.count > 0);
  }
  if (isObject(v.streams)) status.streams = { docker: int(v.streams.docker, 0, 1_000), kube: int(v.streams.kube, 0, 1_000), host: int(v.streams.host, 0, 1_000) };
  return status;
}

/** Whether a rule id is one the contract names (others are still counted, under their cleaned name). */
export const isKnownRule = (rule: string): boolean => RULES.has(rule);

/** A `log` line: the level and a short cleaned message. */
export function cleanLog(v: unknown, now: Date = new Date()): ConnectLogMessage | null {
  if (!isObject(v)) return null;
  const message = text(v.message, 300);
  if (!message) return null;
  return { t: 'log', level: v.level === 'error' || v.level === 'warn' ? v.level : 'info', message, at: iso(v.at, now) };
}

/** A node name from what an agent offered (a hostname, a swarm node name): letters, digits, dot, dash and underscore, at most 63. */
export function nodeNameOf(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const clean = cleanText(c, 200)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 63)
      .replace(/[^A-Za-z0-9]+$/, '');
    if (clean) return clean;
  }
  return 'node';
}
