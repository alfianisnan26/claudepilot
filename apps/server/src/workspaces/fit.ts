// The node fit check (T-98; shared with a workspace create and T-97's browser container): will a pod with these requests be scheduled?
//
// THE RULE (the one `scripts/ws-resources.sh` used, so the portal and the coordinator's numbers agree): on a node, the requests of every
// OTHER pod that is Running or Pending (its `spec.containers`, not init containers; a pod on its way out does not count) plus the new
// requests must stay within the node's allocatable CPU and memory. A pod being replaced (a Recreate Deployment's own pod) is left out with
// `isSelf`: it is gone when the new one is scheduled.
//
// WHERE: on `node` when one is given (a running pod is recreated on its node); otherwise on every node the pod may go to (`nodeSelector`
// matched, not cordoned), fitting when one of them has room. `fit()` is pure; `checkFit()` reads the cluster and never throws: a cluster it
// cannot read (no right to list nodes or pods, say) answers `checked: false` with the reason, and the caller decides (it never guesses).
//
// The portal's right to read is the ClusterRole `claudepilot-portal-fit-check` (deploy/k3s/rbac.yaml): nodes get/list, pods list.

import type { CoreV1Api } from '@kubernetes/client-node';

/** A Kubernetes CPU quantity ("250m", "1", "0.5", "123456n") in cores. */
export function cores(q: string): number {
  const units: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3 };
  const unit = units[q.slice(-1)];
  return unit ? Number(q.slice(0, -1)) * unit : Number(q);
}

/** A Kubernetes memory quantity ("512Mi", "2Gi", "16318412Ki", "1G", "1048576") in bytes. */
export function bytes(q: string): number {
  const m = q.match(/^(\d+(?:\.\d+)?)([KMGTPE]i?|k)?$/);
  if (!m) return Number(q) || 0;
  const pow: Record<string, number> = { K: 1, k: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };
  const base = m[2]?.endsWith('i') ? 1024 : 1000;
  return Number(m[1]) * base ** (m[2] ? pow[m[2][0]!]! : 0);
}

const MIB = 1024 * 1024;

/** An amount of CPU (millicores) and memory (bytes): what a pod asks, what a node has free. */
export interface FitAmount {
  cpuMilli: number;
  memoryBytes: number;
}

/** A pod as the check needs it. */
export interface FitPod {
  namespace?: string;
  labels?: Record<string, string>;
  nodeName?: string;
  phase?: string;
  deleting?: boolean;
  requests: { cpu?: string; memory?: string }[];
}

/** A node as the check needs it. */
export interface FitNode {
  name: string;
  labels?: Record<string, string>;
  unschedulable?: boolean;
  allocatable: { cpu?: string; memory?: string };
}

/** One node's numbers: what it can allocate, what the other pods request, what is left, and whether the need fits in it. */
export interface FitNodeFree {
  node: string;
  allocatable: FitAmount;
  used: FitAmount;
  free: FitAmount;
  fits: boolean;
}

export interface FitResult {
  /** It fits on the node (or on one of the nodes). False also when the check could not be made (`checked: false`). */
  fits: boolean;
  /** False: the cluster could not be read; `reason` says why and `nodes` is empty. */
  checked: boolean;
  /** One line with the numbers, for a refusal text: the script's words. */
  reason: string;
  need: FitAmount;
  /** Every node looked at, the one that fits first (else the one with the most CPU left). */
  nodes: FitNodeFree[];
}

export interface FitQuestion {
  /** The pod's requests (all its containers together). */
  need: FitAmount;
  /** The node it will be on (a running pod's); null or absent: any node it may go to. */
  node?: string | null;
  nodeSelector?: Record<string, string>;
  /** A pod to leave out: the one being replaced. */
  isSelf?: (p: FitPod) => boolean;
}

const counts = (p: FitPod) => (p.phase === 'Running' || p.phase === 'Pending') && !p.deleting;
const mi = (b: number) => Math.floor(b / MIB);

function nodeFree(node: FitNode, pods: FitPod[], q: FitQuestion): FitNodeFree {
  let cpu = 0;
  let mem = 0;
  for (const p of pods) {
    if (p.nodeName !== node.name || !counts(p) || q.isSelf?.(p)) continue;
    for (const r of p.requests) {
      cpu += r.cpu ? cores(r.cpu) * 1000 : 0;
      mem += r.memory ? bytes(r.memory) : 0;
    }
  }
  const allocatable = { cpuMilli: Math.floor(cores(node.allocatable.cpu ?? '0') * 1000), memoryBytes: bytes(node.allocatable.memory ?? '0') };
  const used = { cpuMilli: Math.floor(cpu), memoryBytes: mem };
  const free = { cpuMilli: allocatable.cpuMilli - used.cpuMilli, memoryBytes: allocatable.memoryBytes - used.memoryBytes };
  return { node: node.name, allocatable, used, free, fits: q.need.cpuMilli <= free.cpuMilli && q.need.memoryBytes <= free.memoryBytes };
}

const numbers = (n: FitNodeFree, need: FitAmount) =>
  `the other pods request ${n.used.cpuMilli}m and ${mi(n.used.memoryBytes)}Mi, this one would ask ${Math.round(need.cpuMilli)}m and ${mi(need.memoryBytes)}Mi, the node can allocate ${n.allocatable.cpuMilli}m and ${mi(n.allocatable.memoryBytes)}Mi`;

/** Could not be checked: no numbers but the need, and why. */
export const unchecked = (need: FitAmount, why: string): FitResult => ({ fits: false, checked: false, reason: `The fit could not be checked: ${why}`, need, nodes: [] });

/** The decision, on what was read. */
export function fit(q: FitQuestion, cluster: { nodes: FitNode[]; pods: FitPod[] }): FitResult {
  let candidates: FitNode[];
  if (q.node) {
    const node = cluster.nodes.find((n) => n.name === q.node);
    if (!node) return unchecked(q.need, `the node ${q.node} could not be read.`);
    candidates = [node];
  } else {
    const selector = Object.entries(q.nodeSelector ?? {});
    candidates = cluster.nodes.filter((n) => !n.unschedulable && selector.every(([k, v]) => n.labels?.[k] === v));
    if (!candidates.length) return unchecked(q.need, 'no node the pod may run on was found.');
  }
  const nodes = candidates.map((n) => nodeFree(n, cluster.pods, q)).sort((a, b) => Number(b.fits) - Number(a.fits) || b.free.cpuMilli - a.free.cpuMilli);
  const best = nodes[0]!;
  return best.fits
    ? { fits: true, checked: true, reason: `It fits on ${best.node}: ${numbers(best, q.need)}.`, need: q.need, nodes }
    : { fits: false, checked: true, reason: `It does not fit on ${best.node} (the pod would stay Pending): ${numbers(best, q.need)}. Ask for less, or free requests on that node first.`, need: q.need, nodes };
}

/** Reads what the check needs (the node, or every node; the pods on it, or every pod) and decides. Never throws. */
export async function checkFit(core: CoreV1Api, q: FitQuestion): Promise<FitResult> {
  let cluster: { nodes: FitNode[]; pods: FitPod[] };
  try {
    const [nodeList, podList] = await Promise.all([
      q.node ? core.readNode({ name: q.node }).then((n) => [n]) : core.listNode().then((l) => l.items),
      core.listPodForAllNamespaces(q.node ? { fieldSelector: `spec.nodeName=${q.node}` } : {}),
    ]);
    cluster = {
      nodes: nodeList.map((n) => ({
        name: n.metadata?.name ?? '',
        labels: n.metadata?.labels,
        unschedulable: !!n.spec?.unschedulable,
        allocatable: { cpu: n.status?.allocatable?.cpu, memory: n.status?.allocatable?.memory },
      })),
      pods: podList.items.map((p) => ({
        namespace: p.metadata?.namespace,
        labels: p.metadata?.labels,
        nodeName: p.spec?.nodeName,
        phase: p.status?.phase,
        deleting: !!p.metadata?.deletionTimestamp,
        requests: (p.spec?.containers ?? []).map((c) => ({ cpu: c.resources?.requests?.cpu, memory: c.resources?.requests?.memory })),
      })),
    };
  } catch (e) {
    const code = (e as { code?: number }).code;
    return unchecked(q.need, code === 403 ? 'the portal may not read the cluster’s nodes and pods (ClusterRole claudepilot-portal-fit-check).' : `the cluster did not answer (${code ?? (e as Error).message}).`);
  }
  return fit(q, cluster);
}

/** A pod's requests from its containers' `resources.requests` (a request left out is its limit, as Kubernetes defaults it). */
export function needOf(containers: { resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }[]): FitAmount {
  let cpu = 0;
  let mem = 0;
  for (const c of containers) {
    const r = c.resources?.requests ?? {};
    const l = c.resources?.limits ?? {};
    const q = { cpu: r.cpu ?? l.cpu, memory: r.memory ?? l.memory };
    cpu += q.cpu ? cores(q.cpu) * 1000 : 0;
    mem += q.memory ? bytes(q.memory) : 0;
  }
  return { cpuMilli: Math.round(cpu), memoryBytes: mem };
}
