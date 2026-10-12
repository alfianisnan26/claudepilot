// The agent bundle this portal serves: the generated file's constants (T2: `agent.generated.ts`, built by `npm run gen:connect-agent`). The build id is
// the first 12 hex of the bundle's sha256, which is also what a running agent reports as its `agentBuild`; a node whose build differs is "outdated".

import { CONNECT_AGENT_VERSION } from '@portal/contracts';
import { PILOT_AGENT, PILOT_AGENT_BUILD, PILOT_AGENT_SHA256 } from './agent.generated.js';

export interface AgentBundle {
  build: string;
  sha256: string;
  version: string;
  source: string;
}

export function agentBundle(): AgentBundle {
  return { build: PILOT_AGENT_BUILD, sha256: PILOT_AGENT_SHA256, version: CONNECT_AGENT_VERSION, source: PILOT_AGENT };
}
