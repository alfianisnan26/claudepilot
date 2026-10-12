// Test helpers for Portal MCP (not used by the portal itself): a fresh store, a module with its own tool
// registry, tokens of each kind, and clients that speak to the endpoint in-process with a real MCP client
// (both protocol eras) or with raw JSON-RPC.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { PortalScope } from '@portal/contracts';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { PortalMcpModule } from './module.js';
import { PortalLimits } from './limits.js';
import { ToolRegistry } from './registry.js';

export const URL_ = 'http://portal.test/mcp';

export interface HarnessOptions {
  registry?: ToolRegistry;
  limits?: PortalLimits;
  /** Leave MCP switched off (the default is on). */
  off?: boolean;
  extraOrigins?: string[];
  now?: () => Date;
}

/** One JSON-RPC answer: the SDK answers legacy-era requests as an event stream and modern ones as JSON. */
export async function readRpc(res: Response): Promise<{ status: number; headers: Headers; body: any }> {
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  let body: unknown = text;
  if (type.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    body = data.length ? JSON.parse(data[data.length - 1]!) : null;
  } else if (type.includes('json') && text) body = JSON.parse(text);
  return { status: res.status, headers: res.headers, body };
}

export async function portalMcpHarness(opts: HarnessOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-pmcp-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const registry = opts.registry ?? new ToolRegistry();
  /** Chat sessions that are running, for the agents' tokens (the portal asks the chat controller). */
  const alive = new Set<string>();
  const module = new PortalMcpModule(store, {
    registry,
    extraOrigins: opts.extraOrigins,
    limits: opts.limits,
    now: opts.now,
    agentHost: { alive: (id) => alive.has(id), url: () => 'http://172.18.0.1:3105/mcp' },
  });
  if (!opts.off) module.settings.update({ enabled: true });

  const ip = { value: '10.0.0.9' };
  /** A fetch that goes straight into the endpoint, as a client's would over HTTP. */
  const fetcher: typeof fetch = async (input, init) => module.mcp.handle(new Request(input as string, init), { ip: ip.value });

  /** An admin's token of the given scope; returns its secret and id. */
  const token = (scope: PortalScope, label = `${scope}-test`) => {
    const { token: t, secret } = module.createToken({ label, scope }, URL_);
    return { id: t.id, secret };
  };

  /**
   * An agent's per-session token (interface I8): opts the workspace in, marks the session as running, and mints through
   * the same function the chat launch calls. Returns its secret and the grant (env and MCP config).
   */
  const agentToken = async (workspaceId: string, sessionId: string, o: { optIn?: boolean; running?: boolean } = {}) => {
    if (o.optIn !== false) module.agents.setEnabled(workspaceId, true);
    if (o.running !== false) alive.add(sessionId);
    const grant = await module.agents.mint({ workspaceId, sessionId });
    return { grant, id: grant?.tokenId ?? '', secret: grant?.env.PILOT_MCP_TOKEN ?? '' };
  };

  /** A raw JSON-RPC POST (legacy era). */
  const rpc = async (secret: string | null, method: string, params?: unknown, extra: { headers?: Record<string, string>; id?: number } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra.headers };
    if (secret) headers.authorization = `Bearer ${secret}`;
    return readRpc(await fetcher(URL_, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: extra.id ?? 1, method, params }) }));
  };

  /** A tool call as raw JSON-RPC; returns the tool result (or the JSON-RPC error). */
  const call = async (secret: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc(secret, 'tools/call', { name, arguments: args });
    return { status: r.status, result: r.body?.result as { isError?: boolean; content?: { type: string; text: string }[]; structuredContent?: any } | undefined, error: r.body?.error as { code: number; message: string } | undefined, raw: r.body };
  };

  /** A real MCP client over the same in-process fetch. `era` picks the protocol revision it speaks. */
  const client = async (secret: string, era: 'legacy' | 'modern' = 'modern') => {
    const c = new Client({ name: 'pmcp-test', version: '1.0.0' }, { versionNegotiation: { mode: era === 'legacy' ? 'legacy' : 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(URL_), { fetch: fetcher, requestInit: { headers: { Authorization: `Bearer ${secret}` } } });
    await c.connect(transport);
    return { client: c, close: () => c.close().catch(() => undefined) };
  };

  const done = () => {
    void module.mcp.close().catch(() => undefined);
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, module, registry, token, agentToken, alive, rpc, call, client, ip, done, dataDir };
}
