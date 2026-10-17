// T-436: the "Workspaces" field of a vault's settings: which workspaces' agents may reach the vault. Pure helpers, tested without a browser.
import { WORKSPACE_KEY } from '@portal/contracts';
import type { PortalAgentWorkspace, UpdateVaultRequest } from '@portal/contracts';

/** The listed keys the server would refuse (not `<target>/<name>`), so the field can name them before Save. */
export function invalidWorkspaceKeys(selected: readonly string[]): string[] {
  return [...new Set(selected.filter((w) => !WORKSPACE_KEY.test(w)))];
}

/** One row of the field: a workspace key (`<target>/<name>`), its name, and whether the vault lists it. A listed key the portal no longer shows stays a row (so a save never drops it silently). */
export interface WorkspaceChoice {
  workspaceId: string;
  name: string;
  checked: boolean;
  /** The portal does not list this workspace any more. */
  gone: boolean;
  /** The key is not `<target>/<name>`: Save would be refused until it is cleared. */
  invalid: boolean;
}

/** Every known workspace, then the listed ones that are not known, sorted by key. */
export function workspaceChoices(known: readonly PortalAgentWorkspace[], selected: readonly string[]): WorkspaceChoice[] {
  const on = new Set(selected);
  const rows = new Map<string, WorkspaceChoice>();
  for (const w of known)
    rows.set(w.workspaceId, { workspaceId: w.workspaceId, name: w.name, checked: on.has(w.workspaceId), gone: false, invalid: false });
  for (const id of on)
    if (!rows.has(id)) rows.set(id, { workspaceId: id, name: id, checked: true, gone: true, invalid: !WORKSPACE_KEY.test(id) });
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
export function settingsPayload(form: {
  rewrite: boolean;
  labels: 'filename' | 'heading';
  agentWorkspaces: readonly string[];
}): NonNullable<UpdateVaultRequest['settings']> {
  return { rewriteLinksOnRename: form.rewrite, labels: form.labels, agentWorkspaces: [...form.agentWorkspaces].sort() };
}

/** The warning a save came back with (the list was saved but live agents could not be rebound), or null when there is none. */
export function saveWarning(saved: { warning?: string | null }): string | null {
  const w = typeof saved.warning === 'string' ? saved.warning.trim() : '';
  return w ? w : null;
}

/** Shows a save's warning as an error toast (what the settings dialog does after `onSaved`); nothing for a clean save. Returns whether it showed one. */
export function toastSaveWarning(saved: { warning?: string | null }, toast: (text: string, tone?: 'error') => void): boolean {
  const warning = saveWarning(saved);
  if (!warning) return false;
  toast(warning, 'error');
  return true;
}
