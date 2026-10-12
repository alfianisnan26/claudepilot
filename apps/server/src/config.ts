import { fileURLToPath } from 'node:url';

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
  session: {
    cookie: 'portal_session',
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
  /** Claude usage (claude-usage PRD FR10): how often a Claude's plan limits are read; `PORTAL_CLAUDE_USAGE_PROBES=off` stops the probes. */
  claudeUsage: {
    probes: env('PORTAL_CLAUDE_USAGE_PROBES') !== 'off',
    /** Seconds, as given (claudeusage/service.ts clamps them). */
    intervalS: Number(env('PORTAL_CLAUDE_USAGE_INTERVAL_S') ?? 600),
    fastS: Number(env('PORTAL_CLAUDE_USAGE_FAST_S') ?? 120),
    /** Probe only workspaces whose name starts with one of these (comma-separated); unset means all. */
    only: (env('PORTAL_CLAUDE_USAGE_ONLY') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  /** The browser & desktop pool's container (browser PRD §14.1): a bare tag is built from images/browser on first use. */
  browser: {
    image: env('PORTAL_BROWSER_IMAGE') ?? 'claudepilot-browser:latest',
    imageContext: `${root}images/browser`,
  },
  workspaces: {
    /** Docker daemons; a target shows up when its socket exists. */
    docker: [
      { id: 'docker', label: 'Docker', socket: env('PORTAL_DOCKER_SOCKET') ?? '/var/run/docker.sock' },
      { id: 'docker-host', label: 'Docker (host)', socket: env('PORTAL_DOCKER_HOST_SOCKET') ?? '/var/run/docker-host.sock' },
    ],
    /** Image for Docker targets; built from images/workspace when it's this tag and missing. */
    dockerImage: env('PORTAL_WORKSPACE_IMAGE') ?? 'claudepilot-workspace:latest',
    imageContext: `${root}images/workspace`,
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
    },
  },
  /** Local git and CI/CD (docs/prd/local-git-ci.md §11.5): how many runs a workspace carries at once. */
  ci: {
    /** Off with PORTAL_CI_ENABLED=false: nothing polls workspaces for pushes. */
    enabled: env('PORTAL_CI_ENABLED') !== 'false',
    maxRunsPerWorkspace: Math.max(1, Number(env('PORTAL_CI_MAX_RUNS') ?? 2) || 2),
    maxJobsParallel: Math.max(1, Math.min(8, Number(env('PORTAL_CI_MAX_JOBS') ?? 2) || 2)),
  },
};
