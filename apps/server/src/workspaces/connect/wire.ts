// How the tunnelled runtimes plug into the rest of the portal (docs/prd/targets-connect.md §12.1, §12.5): one call in index.ts once
// Connect exists. The factory makes the runtimes, `bind` adds, replaces and removes them on the manager (which wires their watchers);
// the manager asks Connect before a create (quota, drain) and waits for it after a restart (FR38); chat readers wait out an outage and
// re-follow on a node's return; delivery follows the runtimes' start events and re-checks a target that came back.
import type { ConnectModuleApi } from '../../connect/seams.js';
import type { Workspaces } from '../manager.js';
import { createTunnelRuntime } from './factory.js';

export interface ConnectWiring {
  connect: Pick<ConnectModuleApi, 'useRuntimeFactory' | 'bind' | 'settled' | 'canCreate' | 'onReturned'> & Partial<Pick<ConnectModuleApi, 'onLost'>>;
  workspaces: Workspaces;
  chat?: { targetState?: (workspaceId: string) => 'up' | 'down'; targetReturned(targetId: string): void };
  reconciler?: { runtimeChanged(targetId: string, runtime: Parameters<Parameters<Workspaces['onRuntimeChange']>[0]>[1]): void; requestTarget(targetId: string, why: string): void };
}

/** Call BEFORE `workspaces.resume()`: resume reads `hooks.settled` when it starts. Returns an undo for tests. */
export function wireConnect(w: ConnectWiring): () => void {
  const { connect, workspaces } = w;
  connect.useRuntimeFactory(createTunnelRuntime);
  workspaces.hooks.beforeCreate = (target, node) => connect.canCreate(target, node);
  workspaces.hooks.settled = (ms) => connect.settled(ms);
  if (w.chat) w.chat.targetState = (id) => workspaces.targetState(id);
  const offRuntime = workspaces.onRuntimeChange((target, runtime) => w.reconciler?.runtimeChanged(target, runtime));
  // The manager keeps each target's check for a few seconds; a tunnel that dropped or came back is checked at once, so the list does not
  // keep saying Running for a node that left, or Unreachable for one that is back.
  const offReturned = connect.onReturned((target) => {
    void workspaces.recheck(target);
    w.chat?.targetReturned(target);
    w.reconciler?.requestTarget(target, 'target returned');
  });
  const offLost = connect.onLost?.((target) => void workspaces.recheck(target));
  connect.bind(workspaces);
  return () => {
    offRuntime();
    offReturned();
    offLost?.();
  };
}
