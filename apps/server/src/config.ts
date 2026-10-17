import { fileURLToPath } from 'node:url';
import { CLAUDE_IMAGE_REPO, claudeImageRef, DEFAULT_CLAUDE_CODE_VERSION } from '@portal/contracts';
import { parseNodeSelector } from './workspaces/nodeSelector.js';
import { parseRequests } from './workspaces/requests.js';

const env = (name: string) => process.env[name]?.trim() || undefined;

const root = fileURLToPath(new URL('../../../', import.meta.url));

export const config = {
  dev: process.env.NODE_ENV !== 'production',
  host: env('PORTAL_HOST') ?? '0.0.0.0',
  port: Number(env('PORTAL_PORT') ?? 3000),
  /**
   * Behind a reverse proxy (Caddy in deploy/): the client address is the last X-Forwarded-For entry.
   * Only for a portal no one can reach except through the proxy, or the header can be forged.
   */
  trustProxy: env('PORTAL_TRUST_PROXY') === 'true',
  /** Fixed server code; when unset one is generated at startup. */
  serverCode: env('PORTAL_SERVER_CODE'),
  /** Encrypts stored secrets: 32 random bytes in base64url, given directly or as a file. */
  secretKey: { value: env('PORTAL_SECRET_KEY'), file: env('PORTAL_SECRET_KEY_FILE') },
  /** Repo root, web app source and its build output, and where the portal keeps its own files. */
  paths: {
    root,
    web: `${root}apps/web`,
    webDist: `${root}apps/web/dist`,
    data: env('PORTAL_DATA_DIR') ?? `${root}.data`,
  },
  /** The session's lifetime; its cookie's name and attributes are in sessionCookie.ts (T-976). */
  session: {
    ttlMs: 12 * 60 * 60 * 1000,
  },
  /** Failed sign-ins allowed per client address in each window. */
  loginLimit: { attempts: 10, windowMs: 10 * 60 * 1000 },
  /** Portal MCP (portal-mcp PRD): the `/mcp` endpoint, its access tokens, and how agents inside workspaces reach it. */
  portalMcp: {
    /** The `/mcp` URL shown in Access → MCP when it can't be worked out from the request (behind a proxy). */
    url: env('PORTAL_MCP_URL'),
    /** How workspaces reach this portal, e.g. `http://172.17.0.1:3000`; `/mcp` is added. Unset: workspaces get no portal tools. */
    internalUrl: env('PORTAL_INTERNAL_URL'),
    /** Where links into the admin UI point (PRD FR11); default this portal on its own port. */
    uiUrl: env('PORTAL_UI_URL'),
    /** `Origin` values `/mcp` accepts besides its own and https://claude.ai (comma-separated). */
    origins: (env('PORTAL_MCP_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  /** Notifications (PWA PRD §11.4): the VAPID `sub` contact push services see (mailto: or https:); the setting `notify.contact` wins. */
  notify: {
    pushContact: env('PORTAL_PUSH_CONTACT'),
  },
  /** Claude usage (claude-usage PRD FR10): how often a Claude's plan limits are read; `PORTAL_CLAUDE_USAGE_PROBES=off` stops the probes. */
  claudeUsage: {
    probes: env('PORTAL_CLAUDE_USAGE_PROBES') !== 'off',
    /** Seconds, as given (claudeusage/service.ts clamps them). */
    intervalS: Number(env('PORTAL_CLAUDE_USAGE_INTERVAL_S') ?? 600),
    fastS: Number(env('PORTAL_CLAUDE_USAGE_FAST_S') ?? 120),
    /** Probe only workspaces whose name starts with one of these (comma-separated); unset means all. */
    only: (env('PORTAL_CLAUDE_USAGE_ONLY') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  /** Workspace git (workspace-git PRD §8): scans of each running workspace's repositories. `PORTAL_REPOS_AUTO=off` stops the timer (scans on request still work). */
  repos: {
    auto: env('PORTAL_REPOS_AUTO') !== 'off',
    /** Seconds between automatic scans of one workspace, as given (repos/service.ts keeps it sane). */
    intervalS: Number(env('PORTAL_REPOS_INTERVAL_S') ?? 300),
    /** Folders scanned unless a workspace names its own (comma-separated, `~` is the home folder). */
    roots: (env('PORTAL_REPOS_ROOTS') ?? '~').split(',').map((s) => s.trim()).filter(Boolean),
    depth: Number(env('PORTAL_REPOS_DEPTH') ?? 6),
    maxRepos: Number(env('PORTAL_REPOS_MAX') ?? 300),
  },
  /** The browser & desktop pool's container (browser PRD §14.1): a bare tag is built from images/browser on first use. */
  browser: {
    image: env('PORTAL_BROWSER_IMAGE') ?? 'claudepilot-browser:latest',
    imageContext: `${root}images/browser`,
    /**
     * The browser image on Kubernetes targets (browser PRD §10.2), pulled by the nodes, so a registry reference: unset, Kubernetes
     * workspaces get no browser.
     */
    kubeImage: env('PORTAL_K8S_BROWSER_IMAGE'),
    /**
     * The per-pod egress policy of a Kubernetes workspace with a browser (PRD §13 Network, Q12): `isolate` (the default) denies private,
     * link-local and cluster ranges but DNS, the portal and `PORTAL_K8S_BROWSER_EGRESS_ALLOW` (CIDRs or addresses, `:port` optional,
     * comma-separated); `off` is the admin's opt-out, audited per workspace. It covers the whole pod, Claude Code included.
     */
    kubeEgress: env('PORTAL_K8S_BROWSER_EGRESS') === 'off' ? ('off' as const) : ('isolate' as const),
    kubeEgressAllow: env('PORTAL_K8S_BROWSER_EGRESS_ALLOW'),
  },
  workspaces: {
    /** Docker daemons; a target shows up when its socket exists. */
    docker: [
      { id: 'docker', label: 'Docker', socket: env('PORTAL_DOCKER_SOCKET') ?? '/var/run/docker.sock' },
      { id: 'docker-host', label: 'Docker (host)', socket: env('PORTAL_DOCKER_HOST_SOCKET') ?? '/var/run/docker-host.sock' },
    ],
    /**
     * Image for Docker targets, built from images/workspace when it is missing. `PORTAL_WORKSPACE_IMAGE` names it whole; otherwise it is the
     * repository (`PORTAL_WORKSPACE_IMAGE_REPO`, default claudepilot-workspace) at the tag of the default Claude Code pin, `cc-<x.y.z>`
     * (docs/prd/claude-version-pinning.md). Kubernetes keeps PORTAL_K8S_IMAGE as it was.
     */
    dockerImage: env('PORTAL_WORKSPACE_IMAGE') ?? claudeImageRef(DEFAULT_CLAUDE_CODE_VERSION, env('PORTAL_WORKSPACE_IMAGE_REPO') ?? CLAUDE_IMAGE_REPO),
    /** Whether `PORTAL_WORKSPACE_IMAGE` fixed the image whole: then the default pin and "upgrade" pick tags in its repository only when asked. */
    dockerImageFixed: !!env('PORTAL_WORKSPACE_IMAGE'),
    imageContext: `${root}images/workspace`,
    /** Claude Code version pinning: the canary's container names start with this, and an optional moving tag follows the default pin's image. */
    claude: { canaryPrefix: env('PORTAL_CANARY_PREFIX'), imageAlias: env('PORTAL_WORKSPACE_IMAGE_ALIAS'), canaryTarget: env('PORTAL_CANARY_TARGET') },
    /**
     * The machine the portal runs on, as one workspace. Off unless asked for: anyone with the
     * server code gets a shell as the portal's user.
     */
    local: {
      enabled: env('PORTAL_LOCAL_ENABLED') === 'true',
      name: env('PORTAL_LOCAL_NAME') ?? 'local',
    },
    kubernetes: {
      /** Off when there's no kubeconfig and we're not in a cluster. */
      enabled:
        env('PORTAL_K8S_ENABLED') !== 'false' &&
        !!(env('KUBECONFIG') || env('KUBERNETES_SERVICE_HOST') || env('PORTAL_K8S_ENABLED')),
      namespace: env('PORTAL_K8S_NAMESPACE') ?? 'claudepilot-workspaces',
      image: env('PORTAL_K8S_IMAGE') ?? 'ghcr.io/alfianisnan26/claudepilot-workspace:latest',
      imagePullSecret: env('PORTAL_K8S_IMAGE_PULL_SECRET'),
      storageClass: env('PORTAL_K8S_STORAGE_CLASS'),
      storage: env('PORTAL_K8S_STORAGE') ?? '10Gi',
      /** `key=value[,key=value]`: which nodes workspace pods may run on (for example `kubernetes.io/hostname=k3s-node2`). */
      nodeSelector: parseNodeSelector(env('PORTAL_K8S_NODE_SELECTOR')),
      /** What a workspace pod asks the scheduler to reserve, at most its limits (for example `250m` and `1Gi`); unset: the limits. */
      requests: parseRequests(env('PORTAL_K8S_CPU_REQUEST'), env('PORTAL_K8S_MEMORY_REQUEST')),
    },
  },
  /** Local git and CI/CD (docs/prd/local-git-ci.md §11.5): how many runs a workspace carries at once. */
  ci: {
    /** Off with PORTAL_CI_ENABLED=false: nothing polls workspaces for pushes. */
    enabled: env('PORTAL_CI_ENABLED') !== 'false',
    maxRunsPerWorkspace: Math.max(1, Number(env('PORTAL_CI_MAX_RUNS') ?? 2) || 2),
    maxJobsParallel: Math.max(1, Math.min(8, Number(env('PORTAL_CI_MAX_JOBS') ?? 2) || 2)),
  },
  /** Connect (docs/prd/targets-connect.md §15): targets enrolled from the web, agents that dial out. `PORTAL_CONNECT_ENABLED=false` is the kill switch. */
  connect: {
    enabled: env('PORTAL_CONNECT_ENABLED') !== 'false',
    /** The address targets use to reach the portal; wins over the setting and the browser's address. */
    url: env('PORTAL_CONNECT_URL'),
    /** Plain http to a non-loopback address (lab use). */
    allowHttp: env('PORTAL_CONNECT_ALLOW_HTTP') === 'true',
    /** The portal's root certificate (PEM) for the wizard's "Private CA" option. */
    caFile: env('PORTAL_CONNECT_CA_FILE'),
    baseImage: env('PORTAL_CONNECT_BASE_IMAGE') ?? 'node:22-bookworm-slim',
    workspaceImage: env('PORTAL_CONNECT_WORKSPACE_IMAGE') ?? 'ghcr.io/alfianisnan26/claudepilot-workspace:latest',
    tokenTtlMin: Math.min(1440, Math.max(1, Number(env('PORTAL_CONNECT_TOKEN_TTL_MIN') ?? 15) || 15)),
  },
};
