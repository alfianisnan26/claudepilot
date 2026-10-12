// T-MUX on the agent's side (docs/prd/targets-connect.md §19.3): the tunnel library's conformance suite, run over the sessions the agent's own client
// makes, that is `dialTunnel` (the handshake and the mux the agent uses, with its limits and its close error) against a portal end on a real WebSocket.
// The portal's side has the same suite over a memory pair and a ws pair (tunnel/mux.test.ts); a behaviour added to the mux is held to here as well.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { CONNECT_SUBPROTOCOL, connectTunnelUrl } from '@portal/contracts';
import { generateNodeKeyPair } from '../tunnel/auth.js';
import { runMuxConformance, type MakeSessionPair } from '../tunnel/conformance.js';
import { dialTunnel, MuxSession, TUNNEL_WS_OPTIONS, WsMuxSocket } from '../tunnel/index.js';
import { buildHello } from './hello.js';
import { agentConfig } from './testkit/agentConfig.js';

const keys = generateNodeKeyPair();

const makeAgentPair: MakeSessionPair = async (handlers, options) => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, ...TUNNEL_WS_OPTIONS, handleProtocols: (p) => (p.has(CONNECT_SUBPROTOCOL) ? CONNECT_SUBPROTOCOL : false) });
  let resolveServer!: (s: MuxSession) => void;
  const serverSide = new Promise<MuxSession>((r) => (resolveServer = r));
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ t: 'challenge', v: 1, connId: 'c0ffee00-0000-4000-8000-000000000001', nonce: Buffer.alloc(32, 5).toString('base64url'), serverTime: new Date().toISOString(), protocol: { min: 1, max: 1 } }));
    ws.once('message', () => {
      ws.send(JSON.stringify({ t: 'welcome', v: 1, node: 'nd_0123456789ab', target: 'lab', portalId: null, portalVersion: '0.0.0', agentBuild: 'abcabcabcabc', protocol: 1, heartbeat: { pingEveryMs: 15_000, deadAfterMs: 45_000 } }));
      resolveServer(new MuxSession({ role: 'server', socket: new WsMuxSocket(ws), onStream: handlers.onServerStream, limits: options?.server, closeError: options?.closeError }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const config = agentConfig({ dataDir: '/nonexistent', url: origin });
  const dialled = await dialTunnel({
    url: connectTunnelUrl(origin),
    nodeId: 'nd_0123456789ab',
    privateKey: keys.privateKey,
    hello: () => buildHello(config, { build: 'abcabcabcabc', version: '0.1.0', startedAt: new Date().toISOString() }),
    onStream: handlers.onClientStream,
    limits: options?.client,
    closeError: options?.closeError,
  });
  const server = await serverSide;
  return {
    client: dialled.session,
    server,
    close: async () => {
      dialled.session.destroy('test over');
      server.destroy('test over');
      for (const c of wss.clients) c.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
};

runMuxConformance('the agent’s client (dialTunnel) over a real ws pair', makeAgentPair, { echoBudgetMs: 250 });
