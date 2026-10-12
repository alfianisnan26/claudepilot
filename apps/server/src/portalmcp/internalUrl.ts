import type { Workspaces } from '../workspaces/manager.js';

// How a workspace reaches the portal (portal-mcp PRD §11): the `/mcp` URL an agent's MCP config points at. The operator
// can say it (`PORTAL_INTERNAL_URL`, always for Kubernetes); otherwise it is worked out per target. A Docker workspace
// reaches the machine the portal runs on at its default gateway, which needs the portal to listen beyond loopback
// (`PORTAL_HOST`, 0.0.0.0 by default); the portal's own machine reaches itself on 127.0.0.1.

const CACHE_MS = 10 * 60_000;

/** Prints the container's default gateway as a dotted address. Reads /proc, so it needs no `ip` in the image. */
const GATEWAY = String.raw`node -e 'const r=require("fs").readFileSync("/proc/net/route","utf8").split("\n").slice(1).map((l)=>l.split(/\s+/)).find((c)=>c[1]==="00000000");if(r){const g=parseInt(r[2],16);console.log([g&255,(g>>8)&255,(g>>16)&255,(g>>>24)&255].join("."))}'`;

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export interface InternalUrlOptions {
  workspaces: Pick<Workspaces, 'runtimeFor'>;
  /** The port the portal listens on. */
  port: number;
  /** `PORTAL_INTERNAL_URL`, when the operator set it. */
  configured: string | null;
}

/** A resolver from a workspace id to the portal's `/mcp` URL as that workspace reaches it, or null when it can't be told. */
export type InternalUrlResolver = ((workspaceId: string) => Promise<string | null>) & {
  /** What is already known without asking the workspace: the configured URL, or the last one worked out (even if stale). */
  known(workspaceId: string): string | null;
};

export function internalUrlResolver(o: InternalUrlOptions): InternalUrlResolver {
  const cache = new Map<string, { at: number; url: string | null }>();
  const configured = o.configured ? `${o.configured.replace(/\/+$/, '')}/mcp` : null;
  const resolve = async (workspaceId: string) => {
    // An enrolled target's workspaces reach the portal at that target's own portal address (targets-connect PRD §12.9), before
    // PORTAL_INTERNAL_URL: that one is an address on the portal's own network, which a remote host can't use.
    const remote = remoteUrl(o, workspaceId);
    if (remote) return remote;
    if (configured) return configured;
    const hit = cache.get(workspaceId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.url;
    const url = await derive(o, workspaceId).catch(() => null);
    // A failure isn't remembered for long: the workspace may just be starting.
    cache.set(workspaceId, { at: url ? Date.now() : Date.now() - CACHE_MS + 30_000, url });
    return url;
  };
  return Object.assign(resolve, { known: (workspaceId: string) => remoteUrl(o, workspaceId) ?? configured ?? cache.get(workspaceId)?.url ?? null });
}

function remoteUrl(o: InternalUrlOptions, workspaceId: string): string | null {
  const portalUrl = o.workspaces.runtimeFor(workspaceId.slice(0, workspaceId.indexOf('/')))?.portalUrl;
  return portalUrl ? `${portalUrl.replace(/\/+$/, '')}/mcp` : null;
}

async function derive(o: InternalUrlOptions, workspaceId: string): Promise<string | null> {
  const slash = workspaceId.indexOf('/');
  const runtime = o.workspaces.runtimeFor(workspaceId.slice(0, slash));
  if (!runtime) return null;
  switch (runtime.target.kind) {
    case 'local':
      return `http://127.0.0.1:${o.port}/mcp`;
    case 'docker': {
      const r = await runtime.delivery?.run(workspaceId.slice(slash + 1), GATEWAY, { user: 'node', timeoutMs: 8_000 });
      const gateway = r?.stdout.trim().split('\n').at(-1)?.trim() ?? '';
      return r?.code === 0 && IPV4.test(gateway) ? `http://${gateway}:${o.port}/mcp` : null;
    }
    default:
      return null; // Kubernetes: the operator says (PORTAL_INTERNAL_URL)
  }
}
