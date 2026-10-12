// The RuntimeFactory Connect calls when an enrolled target becomes usable or changes (docs/prd/targets-connect.md §12.1.1): one Runtime
// per target, by kind. Docker and Swarm: the composite over their nodes; Kubernetes: the loopback runtime over its connector; Container
// and Host singles: the Host runtime. Connect's `bind` hands the result to the manager (add, replace, remove); the manager disposes the
// runtime it replaces.
import { ConnectError, type NodeLink, type RuntimeFactory } from '../../connect/seams.js';
import type { Runtime } from '../runtime.js';
import { ConnectDockerRuntime } from './dockerCluster.js';
import { HostRuntime } from './host.js';
import { ConnectKubeRuntime } from './kube.js';

/** A target with no node yet (enrolled, never connected): never connected, every open refused. */
const nowhere = (targetId: string): NodeLink => ({
  nodeId: '',
  targetId,
  connected: () => false,
  open: () => Promise.reject(new ConnectError('agent_offline', 'No node has connected yet.')),
  info: () => null,
  onChange: () => () => undefined,
  kubeToken: () => null,
});

export const createTunnelRuntime: RuntimeFactory = (target, nodes, deps): Runtime => {
  const first = nodes[0] ?? { record: { id: '', targetId: target.id, name: target.id, drained: false, keyFingerprint: '' }, link: nowhere(target.id) };
  switch (target.kind) {
    case 'docker':
    case 'swarm':
      return new ConnectDockerRuntime(target, nodes, deps);
    case 'kubernetes':
      return new ConnectKubeRuntime(target, first, deps);
    case 'container':
    case 'host':
      return new HostRuntime(target, first, deps);
  }
};

/** Stops what a tunnelled runtime follows (its links' changes, its loopback listener). Safe on any runtime. */
export const disposeRuntime = (r: Runtime | undefined) => (r as { dispose?: () => void } | undefined)?.dispose?.();
