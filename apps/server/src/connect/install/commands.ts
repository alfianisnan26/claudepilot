// The commands the wizard shows (docs/prd/targets-connect.md §13.2) and the plan preview of the target's detail. The token appears only
// in `install` and `verified`, as the PILOT_TOKEN variable (never in a URL or as an argument of the script); the rest need none.
import {
  CONNECT_PUBLIC,
  type ConnectCommands,
  type ConnectInstallOptions,
  type ConnectKind,
  type ConnectPlatform,
} from '@portal/contracts';
import { parsePlan } from './plan.js';

export interface CommandsInput {
  portalUrl: string;
  token: string;
  kind: ConnectKind;
  platform: ConnectPlatform;
  targetId: string;
  options?: ConnectInstallOptions;
  /** The portal's CA certificate (public), for the "Private CA" variant; used only when `options.privateCa`. */
  caPem?: string | null;
  /** The sha256 of each script as served now (`installerDigests()`). */
  sha256: { sh: string; ps1: string };
}

const loopback = (u: URL) => {
  const h = u.hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
};

/** Single-quoted for sh. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Single-quoted for PowerShell. */
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function buildCommands(input: CommandsInput): ConnectCommands {
  const portal = input.portalUrl.replace(/\/+$/, '');
  const url = new URL(portal);
  const options = input.options ?? {};
  const kubernetes = input.kind === 'kubernetes';
  // A plain-http lab portal (PORTAL_CONNECT_ALLOW_HTTP): the script refuses http to anything but loopback unless told.
  const allowHttp = url.protocol === 'http:' && !loopback(url);
  const ca = options.privateCa && input.caPem ? input.caPem.trim() : null;
  const sudo = !!options.sudo && input.platform === 'linux' && input.kind !== 'host' && !kubernetes;

  if (input.platform === 'windows') {
    const script = `${portal}${CONNECT_PUBLIC.installPs1}`;
    const vars = (extra: [string, string][]) =>
      [['PILOT_URL', portal] as [string, string], ...(allowHttp ? [['PILOT_ALLOW_HTTP', '1'] as [string, string]] : []), ...extra]
        .map(([k, v]) => `$env:${k}=${psq(v)}`)
        .join('; ');
    const caLines = ca ? `Set-Content -Path pilot-ca.pem -Value @'\n${ca}\n'@\n$env:PILOT_CA="$PWD\\pilot-ca.pem"; ` : '';
    const tokenVars = vars([['PILOT_TOKEN', input.token]]);
    const scoped = (cmd: string) => `${caLines}${vars(targetVars(input.targetId, kubernetes))}; & ([scriptblock]::Create((irm ${script}))) ${cmd}`;
    return {
      install: `${caLines}${tokenVars}; irm ${script} | iex`,
      verified:
        `${caLines}irm ${script} -OutFile pilot-install.ps1; ` +
        `if ((Get-FileHash pilot-install.ps1 -Algorithm SHA256).Hash -ne ${psq(input.sha256.ps1.toUpperCase())}) { throw 'Checksum mismatch' }; ` +
        `${tokenVars}; & ([scriptblock]::Create((Get-Content -Raw pilot-install.ps1)))`,
      upgrade: scoped('upgrade'),
      uninstall: scoped('uninstall'),
      doctor: scoped('doctor'),
      scriptUrl: script,
      scriptSha256: input.sha256.ps1,
    };
  }

  const script = `${portal}${CONNECT_PUBLIC.installSh}`;
  const caPrefix = ca ? `cat > pilot-ca.pem <<'PILOT_CA_EOF'\n${ca}\nPILOT_CA_EOF\n` : '';
  const curlCa = ca ? '--cacert pilot-ca.pem ' : '';
  const env = (extra: [string, string][]) =>
    [
      ['PILOT_URL', portal] as [string, string],
      ...(allowHttp ? [['PILOT_ALLOW_HTTP', '1'] as [string, string]] : []),
      ...(ca ? [['PILOT_CA', '"$PWD/pilot-ca.pem"'] as [string, string]] : []),
      ...extra,
    ]
      .map(([k, v]) => `${k}=${v.startsWith('"$PWD') ? v : /^[A-Za-z0-9._:/@,+=-]+$/.test(v) ? v : shq(v)}`)
      .join(' ');
  const runner = (extra: [string, string][]) => (sudo ? `sudo env ${env(extra)} sh` : `${env(extra)} sh`);
  const token: [string, string][] = [['PILOT_TOKEN', input.token]];
  const check = input.platform === 'macos' ? 'shasum -a 256 -c -' : 'sha256sum -c -';
  const scoped = (cmd: string) => `${caPrefix}curl ${curlCa}-fsSL ${script} | ${runner(targetVars(input.targetId, kubernetes))} -s -- ${cmd}`;
  return {
    install: `${caPrefix}curl ${curlCa}-fsSL ${script} | ${runner(token)}`,
    verified:
      `${caPrefix}curl ${curlCa}-fsSL ${script} -o pilot-install.sh && echo "${input.sha256.sh}  pilot-install.sh" | ${check} && ` +
      `${sudo ? `sudo env ${env(token)}` : env(token)} sh pilot-install.sh`,
    upgrade: scoped('upgrade'),
    uninstall: scoped('uninstall'),
    doctor: scoped('doctor'),
    scriptUrl: script,
    scriptSha256: input.sha256.sh,
  };
}

/** Which install a token-less command acts on when a machine has several. Kubernetes is never looked for unless asked (it means a context). */
const targetVars = (targetId: string, kubernetes: boolean): [string, string][] => [
  ['PILOT_TARGET', targetId],
  ...(kubernetes ? [['PILOT_KIND', 'kubernetes'] as [string, string]] : []),
];

/**
 * What the installer will do, in at most six plain lines (`ConnectPlanPreview.steps`), from the plan text itself so the preview can't
 * drift from what the script reads.
 */
export function previewSteps(planText: string): string[] {
  const parsed = parsePlan(planText);
  if (!parsed.ok) return [];
  const v = parsed.values;
  const id = v.PILOT_TARGET ?? '?';
  const image = v.PILOT_WORKSPACE_IMAGE ?? '';
  const wait = 'Wait until the portal shows it connected';
  switch (v.PILOT_KIND) {
    case 'docker':
      return [
        `Pull ${v.PILOT_NODE_IMAGE} and ${image}`,
        'Fetch the agent and check its sha256',
        `Enroll into volume claudepilot-agent-${id}`,
        `Run container claudepilot-agent-${id} with the Docker socket (filtered)`,
        wait,
      ];
    case 'swarm':
      return [
        'Check this is a swarm manager',
        `Create global service claudepilot-agent-${id} with the Docker socket (filtered)`,
        `Each node pulls ${v.PILOT_NODE_IMAGE}, checks the agent and enrolls`,
        'Remove the token from the service',
        wait,
      ];
    case 'kubernetes':
      return [
        'Show the kubectl context and ask before applying',
        `Check RBAC rights in namespace ${v.PILOT_NAMESPACE}`,
        `Apply namespace ${v.PILOT_NAMESPACE}, a Role and Deployment claudepilot-agent`,
        'Wait for the rollout',
        wait,
      ];
    case 'container':
      return [
        `Pull or build ${image}`,
        'Fetch the agent and the pty package and check them',
        `Enroll into volume claudepilot-${id}-state`,
        `Run workspace container claudepilot-${id} (no Docker socket)`,
        wait,
      ];
    case 'host':
      return [
        'Ask on the host: a shell as this user, no isolation',
        `Use Node 22.13+ or download Node ${v.PILOT_NODE_VERSION} (sha256 pinned)`,
        'Fetch the agent and the pty package into ~/.claudepilot/agent',
        'Start a systemd user unit (or a start script)',
        wait,
      ];
    default:
      return [];
  }
}
