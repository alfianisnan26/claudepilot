// What a workspace pod asks the scheduler to reserve. When only limits are set, Kubernetes reserves the whole limit, so a few 2-CPU,
// 4 GiB workspaces fill a node's requests long before it is busy (a pod then stays Pending: "Insufficient cpu"). Workspaces are bursty
// boxes: `PORTAL_K8S_CPU_REQUEST` and `PORTAL_K8S_MEMORY_REQUEST` (for example `250m` and `1Gi`) cap what is reserved; the limits stay.
// Unset (or `limit`): requests follow the limits, as before.

const CPU = /^(\d+(?:\.\d+)?)(m?)$/;
const MEMORY = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|K|M|G|T)?$/;
const UNIT: Record<string, number> = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };

export function cpuMilli(q: string): number | null {
  const m = CPU.exec(q.trim());
  return m ? (m[2] ? Number(m[1]) : Number(m[1]) * 1000) : null;
}

export function memoryBytes(q: string): number | null {
  const m = MEMORY.exec(q.trim());
  return m ? Number(m[1]) * UNIT[m[2] ?? '']! : null;
}

export interface RequestOptions {
  cpu?: string;
  memory?: string;
}

/** Reads the two environment values; a value that is not a Kubernetes quantity stops the portal at start. */
export function parseRequests(cpu: string | undefined, memory: string | undefined): RequestOptions | undefined {
  const out: RequestOptions = {};
  const take = (name: string, raw: string | undefined, valid: (q: string) => number | null, key: keyof RequestOptions) => {
    const v = raw?.trim();
    if (!v || v === 'limit') return;
    if (valid(v) === null) throw new Error(`${name} is not usable: "${v.slice(0, 30)}" is not a Kubernetes quantity (for example 250m or 1Gi), or "limit".`);
    out[key] = v;
  };
  take('PORTAL_K8S_CPU_REQUEST', cpu, cpuMilli, 'cpu');
  take('PORTAL_K8S_MEMORY_REQUEST', memory, memoryBytes, 'memory');
  return out.cpu || out.memory ? out : undefined;
}

/** The requests for a pod with these limits: the smaller of each limit and the wanted request; nothing for a resource without a limit. */
export function requestsFor(limits: Record<string, string>, want: RequestOptions | undefined): Record<string, string> | undefined {
  if (!want) return undefined;
  const out: Record<string, string> = {};
  if (want.cpu && limits.cpu) {
    const l = cpuMilli(limits.cpu);
    const w = cpuMilli(want.cpu);
    out.cpu = l !== null && w !== null && w < l ? want.cpu : limits.cpu;
  }
  if (want.memory && limits.memory) {
    const l = memoryBytes(limits.memory);
    const w = memoryBytes(want.memory);
    out.memory = l !== null && w !== null && w < l ? want.memory : limits.memory;
  }
  return Object.keys(out).length ? out : undefined;
}
