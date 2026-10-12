// The plan (docs/prd/targets-connect.md §13.1, §13.9, FR46): what `GET /connect/v1/plan` answers for a token, as `KEY=value` lines.
// Everything that varies between installs comes from here; the two scripts are the same bytes for everyone and read these lines through
// a fixed allowlist with a strict value pattern, never `eval`. `parsePlan` is the reference reader: install.sh and install.ps1 follow the
// same rules (plan.test.ts runs all three on the same inputs).
import { createHash } from 'node:crypto';
import {
  CONNECT_PLAN_KEYS,
  CONNECT_PROTOCOL,
  CONNECT_PUBLIC,
  CONNECT_ROLE,
  connectTunnelUrl,
  type ConnectEnrollment,
  type ConnectInstallOptions,
  type ConnectPlanKey,
} from '@portal/contracts';
import nodeManifest from '../node-manifest.json' with { type: 'json' };
import type { ConnectTargetRecord, InstallDeps } from '../seams.js';

/** One plan value: what both scripts accept. Anything else in a value rejects the whole plan. */
export const PLAN_VALUE = /^[A-Za-z0-9._:/@,+=-]*$/;
/** One plan line. */
export const PLAN_LINE = /^([A-Z][A-Z0-9_]*)=([A-Za-z0-9._:/@,+=-]*)$/;
/** Where a Kubernetes target's connector and workspaces live unless the wizard said otherwise (what KubernetesRuntime uses today). */
export const DEFAULT_NAMESPACE = 'claudepilot-workspaces';

export interface NodeManifest {
  node: { version: string; sha256: Record<'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64', string> };
  pty: { name: string; version: string; integrity: Record<'main' | 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64', string> };
}
export const NODE_MANIFEST: NodeManifest = nodeManifest;

export interface PlanInput {
  enrollment: ConnectEnrollment;
  target: ConnectTargetRecord;
  options: ConnectInstallOptions;
  bundle: InstallDeps['bundle'];
  config: InstallDeps['config'];
  /** Defaults to the generated node-manifest.json. */
  node?: NodeManifest;
}

/** The workspace image a target uses: its setting, else the wizard's option, else the portal's. */
export const workspaceImageOf = (input: Pick<PlanInput, 'target' | 'options' | 'config'>): string =>
  input.target.settings.workspaceImage || input.options.workspaceImage || input.config.workspaceImage;

export const namespaceOf = (input: Pick<PlanInput, 'target' | 'options'>): string =>
  input.target.settings.namespace || input.options.namespace || DEFAULT_NAMESPACE;

/** The plan's values in order, for a kind; keys that don't apply are left out. Throws on a value the scripts would refuse. */
export function planEntries(input: PlanInput): [ConnectPlanKey, string][] {
  const { enrollment, target, options, bundle, config } = input;
  const node = input.node ?? NODE_MANIFEST;
  const kind = target.kind;
  const portal = target.portalUrl.replace(/\/+$/, '');
  const out: [ConnectPlanKey, string][] = [];
  const put = (k: ConnectPlanKey, v: string | number | null | undefined) => {
    if (v === undefined || v === null || v === '') return;
    out.push([k, String(v)]);
  };
  put('PILOT_PLAN', 1);
  put('PILOT_KIND', kind);
  put('PILOT_ROLE', CONNECT_ROLE[kind]);
  put('PILOT_TARGET', target.id);
  // A single's one node is named after the target; a cluster's nodes default to the host name (the script fills it in).
  put('PILOT_NAME', options.nodeName || (CONNECT_ROLE[kind] === 'single' ? target.id : ''));
  put('PILOT_PLATFORM', enrollment.platform);
  put('PILOT_PORTAL', portal);
  put('PILOT_TUNNEL', connectTunnelUrl(portal));
  put('PILOT_PROTOCOL', CONNECT_PROTOCOL);
  put('PILOT_AGENT_BUILD', bundle.build);
  put('PILOT_AGENT_URL', `${portal}${CONNECT_PUBLIC.bundle(bundle.build)}`);
  put('PILOT_AGENT_SHA256', bundle.sha256);
  if (kind !== 'host') put('PILOT_NODE_IMAGE', config.baseImage);
  if (kind === 'host') {
    put('PILOT_NODE_VERSION', node.node.version);
    put('PILOT_NODE_SHA256_LINUX_X64', node.node.sha256['linux-x64']);
    put('PILOT_NODE_SHA256_LINUX_ARM64', node.node.sha256['linux-arm64']);
    put('PILOT_NODE_SHA256_DARWIN_X64', node.node.sha256['darwin-x64']);
    put('PILOT_NODE_SHA256_DARWIN_ARM64', node.node.sha256['darwin-arm64']);
  }
  if (kind === 'docker' || kind === 'swarm' || kind === 'container') {
    const image = workspaceImageOf(input);
    put('PILOT_WORKSPACE_IMAGE', image);
    if (kind !== 'container') put('PILOT_IMAGES', image);
  }
  if (kind === 'host' || kind === 'container') {
    put('PILOT_PTY_PACKAGE', `${node.pty.name}@${node.pty.version}`);
    put('PILOT_PTY_INTEGRITY', node.pty.integrity.main);
    put('PILOT_PTY_INTEGRITY_LINUX_X64', node.pty.integrity['linux-x64']);
    put('PILOT_PTY_INTEGRITY_LINUX_ARM64', node.pty.integrity['linux-arm64']);
    if (kind === 'host') {
      put('PILOT_PTY_INTEGRITY_DARWIN_X64', node.pty.integrity['darwin-x64']);
      put('PILOT_PTY_INTEGRITY_DARWIN_ARM64', node.pty.integrity['darwin-arm64']);
    }
  }
  if (kind === 'kubernetes') {
    put('PILOT_NAMESPACE', namespaceOf(input));
    put('PILOT_STORAGE_CLASS', target.settings.storageClass || options.storageClass);
    put('PILOT_STORAGE', target.settings.storage || options.storage);
  }
  put('PILOT_MAX_USES', enrollment.maxUses);
  put('PILOT_EXPIRES', enrollment.expiresAt);
  if (kind === 'host' && options.hostAccess) put('PILOT_HOST_ACK', 1);
  if (options.privateCa && config.caPem) put('PILOT_CA_SHA256', createHash('sha256').update(config.caPem).digest('hex'));
  // The registry only holds an http address when it was allowed (loopback, or PORTAL_CONNECT_ALLOW_HTTP): the agent must be told.
  if (/^http:/i.test(portal)) put('PILOT_ALLOW_HTTP', 1);
  for (const [k, v] of out) if (!PLAN_VALUE.test(v)) throw new Error(`plan value for ${k} has characters the installers refuse`);
  return out;
}

/** The plan text: one `KEY=value` per line, `\n` endings, `PILOT_PLAN=1` first. */
export const buildPlan = (input: PlanInput): string => `${planEntries(input).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;

export type ParsedPlan = { ok: true; values: Partial<Record<ConnectPlanKey, string>> } | { ok: false; problem: string };

const ALLOWED = new Set<string>(CONNECT_PLAN_KEYS);

/**
 * The reference reader, with the scripts' rules: `\r` is dropped; empty lines are skipped; the first line is `PILOT_PLAN=1`; every
 * other line is `KEY=value` with the value pattern, or the whole plan is refused; keys not on the allowlist are ignored; the first
 * occurrence of a key wins.
 */
export function parsePlan(text: string): ParsedPlan {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l !== '');
  if (lines[0] !== 'PILOT_PLAN=1') return { ok: false, problem: 'not a plan' };
  const values: Partial<Record<ConnectPlanKey, string>> = {};
  for (const line of lines) {
    const m = PLAN_LINE.exec(line);
    if (!m) return { ok: false, problem: 'bad line' };
    const [, key, value] = m as unknown as [string, ConnectPlanKey, string];
    if (ALLOWED.has(key) && !(key in values)) values[key] = value;
  }
  return { ok: true, values };
}
