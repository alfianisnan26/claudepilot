// A scripted stand-in for api.anthropic.com, for tests of the real Claude Code CLI behaving as a subscription account.
// Claude Code's usage, profile and connector calls go to a hard-coded https://api.anthropic.com, which ANTHROPIC_BASE_URL does
// not move. So the stand-in is two small servers: an HTTPS one with a throwaway certificate for api.anthropic.com, and an
// HTTP CONNECT proxy that lets that one host through to it and refuses every other. The child process gets `HTTPS_PROXY` and
// `NODE_EXTRA_CA_CERTS` in its own environment (`childEnv()`); nothing leaves the machine and nothing is installed on it.
//
// What it answers is a script you set before the child runs (`set`), re-read per request:
//   usage     GET /api/oauth/usage…   the plan's windows, as claude.ai's usage endpoint sends them
//   messages  POST /v1/messages       a streamed reply, or an error such as a 429, with any response headers
//   routes    any other path prefix   first match wins, for example `/v1/mcp_servers` for the claude.ai connectors
// Everything else answers `{}` with 200. Requests are logged by method, path and header NAMES only, never values.

import { createServer as httpServer, type ServerResponse } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { makeTestPki, type TestPki } from './pki.js';

export interface Answer {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface StandInScript {
  usage?: Answer;
  /** `text` is what a successful, streamed reply says. */
  messages?: Answer & { text?: string };
  routes?: (Answer & { prefix: string })[];
}

export interface StandInRequest {
  method: string;
  path: string;
  /** Header names only. */
  headers: string[];
}

export interface StandIn {
  /** `http://<host>:<port>` of the CONNECT proxy. */
  proxyUrl: string;
  caFile: string;
  script: StandInScript;
  requests: StandInRequest[];
  /** Replaces the script (what the next request gets). */
  set(script: StandInScript): void;
  /** What a child process needs to reach this stand-in, and nothing else. */
  childEnv(): Record<string, string>;
  close(): Promise<void>;
}

export interface StandInOptions {
  /** Where the servers listen; `0.0.0.0` lets a container reach them. */
  host?: string;
  /** The host name the child uses to reach the proxy (default: `host`). */
  advertiseHost?: string;
}

const json = (res: ServerResponse, status: number, headers: Record<string, string> | undefined, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', ...(headers ?? {}) });
  res.end(JSON.stringify(body ?? {}));
};

function messagesReply(res: ServerResponse, body: string, m: NonNullable<StandInScript['messages']>) {
  const status = m.status ?? 200;
  if (status !== 200) return json(res, status, m.headers, m.body ?? { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } });
  let wantsStream = true;
  try {
    wantsStream = (JSON.parse(body) as { stream?: boolean }).stream !== false;
  } catch {
    // not JSON: stream anyway
  }
  const text = m.text ?? 'ok';
  const message = { id: 'msg_standin', type: 'message', role: 'assistant', model: 'mock', content: [] as unknown[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  if (!wantsStream) return json(res, 200, m.headers, { ...message, content: [{ type: 'text', text }], stop_reason: 'end_turn' });
  res.writeHead(200, { 'content-type': 'text/event-stream', ...(m.headers ?? {}) });
  const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  send('message_stop', {});
  res.end();
}

export async function startStandIn(opts: StandInOptions = {}): Promise<StandIn> {
  const host = opts.host ?? '127.0.0.1';
  const pki: TestPki = makeTestPki();
  const state: { script: StandInScript } = { script: {} };
  const requests: StandInRequest[] = [];

  const api = httpsServer({ key: pki.key, cert: pki.cert }, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url ?? '';
      requests.push({ method: req.method ?? '', path, headers: Object.keys(req.headers) });
      const { usage, messages, routes } = state.script;
      const route = (routes ?? []).find((r) => path.startsWith(r.prefix));
      if (route) return json(res, route.status ?? 200, route.headers, route.body);
      if (req.method === 'GET' && path.startsWith('/api/oauth/usage')) return usage ? json(res, usage.status ?? 200, usage.headers, usage.body) : json(res, 404, undefined, { error: 'not scripted' });
      if (req.method === 'POST' && path.startsWith('/v1/messages') && !path.includes('count_tokens')) return messagesReply(res, body, messages ?? {});
      if (path.includes('count_tokens')) return json(res, 200, undefined, { input_tokens: 1 });
      json(res, 200, undefined, {});
    });
  });
  await new Promise<void>((resolve) => api.listen(0, host, resolve));
  const apiPort = (api.address() as AddressInfo).port;

  const proxy = httpServer((_req, res) => {
    res.writeHead(502);
    res.end();
  });
  proxy.on('connect', (req, socket, head) => {
    if (String(req.url).split(':')[0] !== 'api.anthropic.com') {
      requests.push({ method: 'CONNECT-REFUSED', path: String(req.url), headers: [] });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connect(apiPort, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, host, resolve));
  const proxyUrl = `http://${opts.advertiseHost ?? host}:${(proxy.address() as AddressInfo).port}`;

  const standIn: StandIn = {
    proxyUrl,
    caFile: pki.caFile,
    get script() {
      return state.script;
    },
    requests,
    set(script) {
      state.script = script;
    },
    childEnv: () => ({ HTTPS_PROXY: proxyUrl, NODE_EXTRA_CA_CERTS: pki.caFile }),
    close: async () => {
      proxy.closeAllConnections?.();
      api.closeAllConnections?.();
      await Promise.all([new Promise((r) => proxy.close(r)), new Promise((r) => api.close(r))]);
      pki.remove();
    },
  };
  return standIn;
}
