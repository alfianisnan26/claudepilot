// What an agent says about itself in `auth` and in `POST enroll` (ConnectAgentHello): informational and untrusted on the portal's side.
import { hostname as osHostname } from 'node:os';
import { CONNECT_PROTOCOL, type ConnectAgentHello, type ConnectServiceStatus } from '@portal/contracts';
import type { AgentConfig } from './config.js';

export function buildHello(
  config: AgentConfig,
  extra: { build: string; version: string; startedAt: string; services?: ConnectServiceStatus[]; portalId?: string | null; hostname?: string; swarm?: ConnectAgentHello['swarm'] },
): ConnectAgentHello {
  return {
    agentVersion: extra.version,
    agentBuild: extra.build,
    protocol: CONNECT_PROTOCOL,
    os: process.platform,
    arch: process.arch,
    hostname: extra.hostname ?? osHostname(),
    mode: config.mode,
    runtime: config.mode === 'host' ? 'host' : config.mode === 'kubernetes' ? 'pod' : 'container',
    services: extra.services ?? [],
    clock: new Date().toISOString(),
    startedAt: extra.startedAt,
    portalId: extra.portalId ?? null,
    ...(extra.swarm ? { swarm: extra.swarm } : {}),
  };
}
