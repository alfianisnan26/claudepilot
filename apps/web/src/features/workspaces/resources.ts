// The Resources row and dialog of a Kubernetes workspace (T-98): the four numbers as the person types them, checked with the same rule the
// server decides by (`workspaceResourcesProblem`), and the one-line summary the row shows.
import { workspaceResourcesProblem, type WorkspaceResourceValues } from '@portal/contracts';

export type ResourceKey = keyof WorkspaceResourceValues;
export const RESOURCE_KEYS: ResourceKey[] = ['cpus', 'memoryMb', 'cpuRequest', 'memoryRequestMb'];
export type ResourceDraft = Record<ResourceKey, string>;

/** The fields, filled from the wanted values when there are some, else from what the Deployment has (blank for what it does not set). */
export function draftOf(wanted: WorkspaceResourceValues | null, live: Partial<WorkspaceResourceValues>): ResourceDraft {
  const from = { ...live, ...(wanted ?? {}) };
  return Object.fromEntries(RESOURCE_KEYS.map((k) => [k, from[k] === undefined ? '' : String(from[k])])) as ResourceDraft;
}

/** The draft as numbers, or the problem of each field (a blank or a word is not a number; the bounds and limits are the server's rule). */
export function parseDraft(draft: ResourceDraft): { values: WorkspaceResourceValues; problems: null } | { values: null; problems: Partial<Record<ResourceKey, string>> } {
  const values = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, draft[k].trim() === '' ? NaN : Number(draft[k].trim().replace(',', '.'))])) as unknown as WorkspaceResourceValues;
  const problems = workspaceResourcesProblem(values);
  return problems ? { values: null, problems } : { values, problems: null };
}

const mib = (mb: number) => (mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GiB` : `${mb} MiB`);

/** "4 CPU · 8 GiB" (the limits); "–" for one it does not set. */
export function resourcesSummary(v: Partial<WorkspaceResourceValues>): string {
  return `${v.cpus === undefined ? '–' : `${v.cpus} CPU`} · ${v.memoryMb === undefined ? '–' : mib(v.memoryMb)}`;
}

/** "reserves 0.25 CPU · 1 GiB" (the requests), for the row's second line. */
export function requestsSummary(v: Partial<WorkspaceResourceValues>): string {
  return `reserves ${v.cpuRequest === undefined ? '–' : `${v.cpuRequest} CPU`} · ${v.memoryRequestMb === undefined ? '–' : mib(v.memoryRequestMb)}`;
}
