import { fileURLToPath } from 'node:url';

const env = (name: string) => process.env[name]?.trim() || undefined;

const root = fileURLToPath(new URL('../../../', import.meta.url));

export const config = {
  dev: process.env.NODE_ENV !== 'production',
  host: env('PORTAL_HOST') ?? '0.0.0.0',
  port: Number(env('PORTAL_PORT') ?? 3000),
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
  workspaces: {
    /** Docker daemons; a target shows up when its socket exists. */
    docker: [
      { id: 'docker', label: 'Docker', socket: env('PORTAL_DOCKER_SOCKET') ?? '/var/run/docker.sock' },
      { id: 'docker-host', label: 'Docker (host)', socket: env('PORTAL_DOCKER_HOST_SOCKET') ?? '/var/run/docker-host.sock' },
    ],
    /** Image for Docker targets; built from images/workspace when it's this tag and missing. */
    dockerImage: env('PORTAL_WORKSPACE_IMAGE') ?? 'claudepilot-workspace:latest',
    imageContext: `${root}images/workspace`,
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
};
