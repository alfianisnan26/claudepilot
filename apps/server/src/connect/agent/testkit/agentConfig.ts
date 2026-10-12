// Test helper: a complete AgentConfig from the few fields a test cares about. `runAgent` takes a full config (`main.ts` builds one from the
// environment and agent.json); tests, the hub's and the runtimes' integration tests among them, use this to say only what differs.
import { MODE_SERVICES, type AgentConfig } from '../config.js';

export function agentConfig(over: Partial<AgentConfig> & Pick<AgentConfig, 'dataDir'>): AgentConfig {
  const mode = over.mode ?? 'host';
  return {
    mode,
    url: null,
    allowHttp: true,
    images: [],
    dockerSocket: '/nonexistent/docker.sock',
    docker: { allowImages: [], allowBinds: [] },
    kubeNamespace: null,
    nodeName: null,
    caFile: null,
    headers: {},
    logLevel: 'debug',
    enrollToken: null,
    identitySecret: null,
    home: null,
    services: MODE_SERVICES[mode],
    ...over,
  };
}
