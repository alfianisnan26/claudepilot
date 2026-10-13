// CPU and memory of a Kubernetes workspace (T-98, docs/prd/targets-connect.md §25): Kubernetes quantities both ways, and the fit check's
// answer (fit.ts, the one shared module) in the contract's words.

import type { WorkspaceResourceValues, WorkspaceResourcesFit } from '@portal/contracts';
import { bytes, cores, type FitResult } from './fit.js';

const MIB = 1024 * 1024;

/** Cores as the quantity a Deployment carries: whole cores plainly ("4"), anything else in millicores ("250m"). */
export const cpuQuantity = (c: number): string => (Number.isInteger(c) ? String(c) : `${Math.round(c * 1000)}m`);
export const memoryQuantity = (mb: number): string => `${mb}Mi`;

/** What a container's `resources` say, in the portal's units (cores, MiB); a value it does not set is absent, a request it leaves out is its limit. */
export function valuesOf(resources: { limits?: Record<string, string>; requests?: Record<string, string> } | undefined): Partial<WorkspaceResourceValues> {
  const out: Partial<WorkspaceResourceValues> = {};
  const l = resources?.limits ?? {};
  const r = resources?.requests ?? {};
  const c = (q?: string) => (q === undefined ? undefined : Math.round(cores(String(q)) * 1000) / 1000);
  const m = (q?: string) => (q === undefined ? undefined : Math.round(bytes(String(q)) / MIB));
  if (l.cpu !== undefined) out.cpus = c(l.cpu);
  if (l.memory !== undefined) out.memoryMb = m(l.memory);
  // A request left out is the limit (what Kubernetes itself defaults it to).
  if ((r.cpu ?? l.cpu) !== undefined) out.cpuRequest = c(r.cpu ?? l.cpu);
  if ((r.memory ?? l.memory) !== undefined) out.memoryRequestMb = m(r.memory ?? l.memory);
  return out;
}

/** Values in one line, for an audit row and a preview: "4 CPU (request 0.25), 8192 MiB (request 1024)". */
export function describeValues(v: Partial<WorkspaceResourceValues>): string {
  const n = (x: number | undefined) => (x === undefined ? 'none' : String(x));
  return `${n(v.cpus)} CPU (request ${n(v.cpuRequest)}), ${n(v.memoryMb)} MiB (request ${n(v.memoryRequestMb)})`;
}

const mi = (b: number) => Math.floor(b / MIB);

/** The fit check's answer (fit.ts) as the API and the MCP tool show it: the node it was decided on, its numbers, and the reason. */
export function fitView(r: FitResult): WorkspaceResourcesFit {
  const n = r.nodes[0];
  return {
    state: !r.checked ? 'unavailable' : r.fits ? 'fits' : 'does_not_fit',
    node: n?.node ?? null,
    otherCpuMilli: n ? n.used.cpuMilli : null,
    otherMemoryMb: n ? mi(n.used.memoryBytes) : null,
    wantCpuMilli: Math.round(r.need.cpuMilli),
    wantMemoryMb: mi(r.need.memoryBytes),
    allocatableCpuMilli: n ? n.allocatable.cpuMilli : null,
    allocatableMemoryMb: n ? mi(n.allocatable.memoryBytes) : null,
    message: r.reason,
  };
}

/** The requests of these values as the fit check's need. */
export const needOfValues = (v: Pick<WorkspaceResourceValues, 'cpuRequest' | 'memoryRequestMb'>) => ({ cpuMilli: Math.round(v.cpuRequest * 1000), memoryBytes: v.memoryRequestMb * MIB });
