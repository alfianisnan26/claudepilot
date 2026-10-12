// What the operator sets for Connect (docs/prd/targets-connect.md §15, "Configuration"): the shape of `config.connect` in ../config.ts, so the module
// can be built with another one in tests.

export interface ConnectConfig {
  /** `PORTAL_CONNECT_ENABLED=false` is the kill switch (FR61): the agent-facing routes answer 404, tunnels are refused, no enrolled runtime is registered. */
  enabled: boolean;
  /** `PORTAL_CONNECT_URL`: the address targets use to reach the portal; wins over the setting and the browser's. */
  url: string | undefined;
  /** `PORTAL_CONNECT_ALLOW_HTTP=true`: plain http to a non-loopback address is accepted (lab use; not a wizard checkbox). */
  allowHttp: boolean;
  /** `PORTAL_CONNECT_CA_FILE`: the portal's root certificate (PEM), for the wizard's "Private CA" option. */
  caFile: string | undefined;
  /** `PORTAL_CONNECT_BASE_IMAGE`: the public image the agent container runs in. */
  baseImage: string;
  /** `PORTAL_CONNECT_WORKSPACE_IMAGE`: the workspace image enrolled Docker targets and Single containers use. */
  workspaceImage: string;
  /** `PORTAL_CONNECT_TOKEN_TTL_MIN`: how long an enrollment token lives unless the wizard says otherwise. */
  tokenTtlMin: number;
}

/** The image the Kubernetes target already pulls (PORTAL_K8S_IMAGE's default). */
export const DEFAULT_WORKSPACE_IMAGE = 'ghcr.io/alfianisnan26/claudepilot-workspace:latest';
export const DEFAULT_BASE_IMAGE = 'node:22-bookworm-slim';
