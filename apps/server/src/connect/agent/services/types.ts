// What the agent's services have in common (docs/prd/targets-connect.md §9.5, §11). Each `services/<name>/index.ts` exports
// `createService(deps): AgentService`; the tunnel client reads the open request, counts the stream against the service's cap, answers
// `ok` and only then hands the stream over, so a service never speaks the open protocol.
import type { ConnectHostOpen, ConnectServiceStatus, ConnectStatusMessage, ConnectStreamError } from '@portal/contracts';
import type { TunnelStream } from '../../seams.js';

export type ServiceName = 'docker' | 'kube' | 'host';

/** Why a service won't take a stream: the typed code the portal sees in the open answer. */
export interface StreamRefusal {
  code: ConnectStreamError;
  message: string;
}

export interface AgentService {
  readonly name: ServiceName;
  /** Asked before the open answer is written: a refusal is sent as the answer and the stream never reaches `handle`. */
  accept?(args?: ConnectHostOpen): Promise<StreamRefusal | null> | StreamRefusal | null;
  /** Serves one accepted stream. `args` is the open request's, for `host` only. Never throws: failures end the stream. */
  handle(stream: TunnelStream, trace: string, args?: ConnectHostOpen): void;
  /** The last known health, synchronous and cheap. */
  status(): ConnectServiceStatus;
  /** Checks now and updates what `status()` says (called before the hello and with every status message). */
  refresh?(): Promise<void>;
  /** What the service adds to the next `status` message. `denied` is what was refused since the previous call. */
  report?(): Pick<ConnectStatusMessage, 'usage' | 'docker' | 'swarm' | 'denied'>;
  /** The agent registers a function the service calls when something the status message shows changed (a denial, the upstream going away). */
  onChange?(fn: () => void): void;
  /** Stops accepting and ends what is open. */
  close(): void;
}
