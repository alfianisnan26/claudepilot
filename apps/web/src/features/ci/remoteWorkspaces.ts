import type { Workspace, WorkspaceTarget } from '@portal/contracts';

/**
 * The workspaces the New remote dialog offers: running ones not on a Kubernetes target. By the target's KIND, never its id: since
 * PORTAL_K8S_TARGETS a Kubernetes target is `kubernetes` or an org's (`isnan`, `konfersi`, ...). A target the list does not know is left in.
 */
export function remoteWorkspaces(all: readonly Workspace[], targets: readonly Pick<WorkspaceTarget, 'id' | 'kind'>[]): Workspace[] {
  const kube = new Set(targets.filter((t) => t.kind === 'kubernetes').map((t) => t.id));
  return all.filter((w) => w.status === 'running' && !kube.has(w.target));
}
