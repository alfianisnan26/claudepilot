// T-436: the "Workspaces" field of a vault's settings: which workspaces' agents may reach the vault. Pure helpers, tested without a browser.
import type { PortalAgentWorkspace, UpdateVaultRequest } from '@portal/contracts';

/** One row of the field: a workspace key (`<target>/<name>`), its name, and whether the vault lists it. A listed key the portal no longer shows stays a row (so a save never drops it silently). */
export interface WorkspaceChoice {
  workspaceId: string;
  name: string;
  checked: boolean;
  /** The portal does not list this workspace any more. */
  gone: boolean;
}

/** Every known workspace, then the listed ones that are not known, sorted by key. */
export function workspaceChoices(known: readonly PortalAgentWorkspace[], selected: readonly string[]): WorkspaceChoice[] {
  const on = new Set(selected);
  const rows = new Map<string, WorkspaceChoice>();
  for (const w of known) rows.set(w.workspaceId, { workspaceId: w.workspaceId, name: w.name, checked: on.has(w.workspaceId), gone: false });
  for (const id of on) if (!rows.has(id)) rows.set(id, { workspaceId: id, name: id, checked: true, gone: true });
  return [...rows.values()].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
}

/** The list after one box is ticked or cleared: no duplicates, sorted. */
export function toggleWorkspace(selected: readonly string[], workspaceId: string, on: boolean): string[] {
  const next = new Set(selected);
  if (on) next.add(workspaceId);
  else next.delete(workspaceId);
  return [...next].sort();
}

/** What Save sends for the vault's settings (the server keeps the settings it is not sent). */
export function settingsPayload(form: { rewrite: boolean; labels: 'filename' | 'heading'; agentWorkspaces: readonly string[] }): NonNullable<UpdateVaultRequest['settings']> {
  return { rewriteLinksOnRename: form.rewrite, labels: form.labels, agentWorkspaces: [...form.agentWorkspaces].sort() };
}
