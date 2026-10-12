// The agent's configuration (docs/prd/targets-connect.md §10.3, §11.3): `agent.json` in the data folder (written by the installer, no
// secret in it) and the environment (`CONNECT_AGENT_ENV`). The environment wins, key by key. `docker.allowImages` and `docker.allowBinds`
// are the host operator's local widening of the Docker policy (appendix A): they come from `agent.json` only, never from the portal.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONNECT_AGENT_ENV, CONNECT_KINDS, connectOriginProblem, type ConnectKind } from '@portal/contracts';
import { isLogLevel, type LogLevel } from './log.js';
import { parseHeaders } from './net.js';
import type { ServiceName } from './services/types.js';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface AgentConfig {
  mode: ConnectKind;
  /** Where the agent keeps its identity and `agent.json`. */
  dataDir: string;
  /** The portal's origin, or null before it is known (`enroll` needs it). */
  url: string | null;
  allowHttp: boolean;
  /** Image references the Docker policy lets containers be created from. */
  images: string[];
  dockerSocket: string;
  /** The host operator's local widening of the Docker policy. */
  docker: { allowImages: string[]; allowBinds: string[] };
  kubeNamespace: string | null;
  nodeName: string | null;
  /** Path of a PEM file: the CA that signs the portal's certificate. */
  caFile: string | null;
  headers: Record<string, string>;
  logLevel: LogLevel;
  /** Kubernetes and Swarm: enroll at first start with this token. Forgotten once there is an identity. */
  enrollToken: string | null;
  /** Kubernetes: the Secret the identity lives in. */
  identitySecret: string | null;
  /** `host` mode: what `/home/node` maps to. */
  home: string | null;
  services: ServiceName[];
}

/** The services each mode offers (PRD §11.2). */
export const MODE_SERVICES: Record<ConnectKind, ServiceName[]> = {
  docker: ['docker'],
  swarm: ['docker'],
  kubernetes: ['kube'],
  container: ['host'],
  host: ['host'],
};

export const defaultDataDir = (mode: ConnectKind, env: NodeJS.ProcessEnv = process.env): string =>
  mode === 'host' ? join(env.HOME ?? homedir(), '.claudepilot', 'agent') : '/var/lib/claudepilot-agent';

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
const list = (text: string | undefined): string[] => (text ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Reads `<dir>/agent.json`; a missing file is `{}`, a damaged one is an error (the installer wrote it, so it should be fixed, not skipped). */
export function readAgentFile(dir: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ConfigError('agent.json is not valid JSON.');
  }
}

/** The text of a file, or null when it isn't there (the installer's `headers` file, which keeps an Access service token out of `docker inspect`). */
function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, file?: (dir: string) => Record<string, unknown>, readText: (path: string) => string | null = readTextOrNull): AgentConfig {
  const E = CONNECT_AGENT_ENV;
  const modeFromEnv = env[E.mode];
  // The mode picks the default data folder, so look at the environment first, then at agent.json in the folder the environment names.
  const dirGuess = env[E.dataDir] ?? defaultDataDir((CONNECT_KINDS as readonly string[]).includes(modeFromEnv ?? '') ? (modeFromEnv as ConnectKind) : 'container', env);
  const read = file ?? readAgentFile;
  const f = read(dirGuess);
  const mode = modeFromEnv ?? (typeof f.mode === 'string' ? f.mode : undefined);
  if (!mode || !(CONNECT_KINDS as readonly string[]).includes(mode)) throw new ConfigError(`${E.mode} must be one of ${CONNECT_KINDS.join(', ')}.`);
  const kind = mode as ConnectKind;
  const dataDir = env[E.dataDir] ?? (typeof f.dataDir === 'string' ? f.dataDir : defaultDataDir(kind, env));

  const allowHttp = env[E.allowHttp] === '1' || f.allowHttp === true;
  const urlRaw = env[E.url] ?? (typeof f.url === 'string' ? f.url : null);
  const url = urlRaw ? urlRaw.replace(/\/+$/, '') : null;
  if (url) {
    const problem = connectOriginProblem(url, allowHttp);
    if (problem) throw new ConfigError(`${E.url}: ${problem}`);
  }

  const dockerFile = (f.docker && typeof f.docker === 'object' ? f.docker : {}) as Record<string, unknown>;
  const logLevel = env[E.logLevel];
  // PILOT_HEADERS, or the installer's `<dataDir>/headers` (mode 0600, `Name: value` lines) when the variable is not set.
  const headersText = env[E.headers] ?? readText(join(dataDir, 'headers')) ?? undefined;
  const services = strings(f.services).filter((s): s is ServiceName => s === 'docker' || s === 'kube' || s === 'host');
  const offered = MODE_SERVICES[kind];

  return {
    mode: kind,
    dataDir,
    url,
    allowHttp,
    images: [...new Set([...list(env[E.images]), ...strings(f.images)])],
    dockerSocket: env[E.dockerSocket] ?? (typeof f.dockerSocket === 'string' ? f.dockerSocket : '/var/run/docker.sock'),
    docker: { allowImages: strings(dockerFile.allowImages), allowBinds: strings(dockerFile.allowBinds) },
    kubeNamespace: env[E.kubeNamespace] ?? (typeof f.namespace === 'string' ? f.namespace : null),
    nodeName: env[E.nodeName] ?? (typeof f.nodeName === 'string' ? f.nodeName : null),
    caFile: env[E.ca] ?? (typeof f.ca === 'string' ? f.ca : null),
    headers: headersText ? parseHeaders(headersText) : {},
    logLevel: isLogLevel(logLevel) ? logLevel : 'info',
    enrollToken: env[E.enrollToken] || null,
    identitySecret: env[E.identitySecret] ?? null,
    home: env[E.home] ?? (typeof f.home === 'string' ? f.home : null),
    // agent.json may switch a service off; it can't add one the mode doesn't offer.
    services: services.length ? offered.filter((s) => services.includes(s)) : offered,
  };
}
