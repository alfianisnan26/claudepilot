// What the Kubernetes proxy lets a workspace's objects contain (docs/prd/targets-connect.md §11.5, H7). The rule table itself is shared with
// the Cloudflare Worker, which checks a create before its stream opens (`kubeSpecProblem` in packages/contracts/src/connect.ts §11,
// PILOT-1187): this maps the proxy's routes onto it and turns a problem into the proxy's `spec` refusal. The image allow list
// (PILOT_IMAGES) is the agent's own and is checked here only.
import { kubeSpecProblem, type KubeSpecTarget } from '@portal/contracts';
import { ImageAllow } from '../docker/rules.js';
import { refuseKube, type KubeRefusal } from './status.js';
import type { KubeRoute } from './rules.js';

function targetOf(kind: KubeRoute['kind']): KubeSpecTarget | null {
  switch (kind) {
    case 'deploymentList':
    case 'deployment':
    case 'replicaSet':
      return 'workload';
    case 'resize':
      return 'resize';
    case 'pvcList':
    case 'pvc':
      return 'claim';
    case 'secretCreate':
    case 'secret':
      return 'secret';
    default:
      return null;
  }
}

/**
 * Checks the body of a write against what a workspace's object may contain. `doc` is the parsed JSON (for a patch, the patch document). Returns
 * a refusal, or null. Names and namespaces are checked by the proxy before this.
 */
export function checkKubeBody(route: KubeRoute, method: string, doc: unknown, images: ImageAllow | null): KubeRefusal | null {
  void method;
  const target = targetOf(route.kind);
  const problem = target ? kubeSpecProblem(target, doc, images) : null;
  return problem ? refuseKube('spec', problem) : null;
}
