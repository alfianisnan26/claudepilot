import { BUMP_REFUSAL_LABEL, type BumpTarget, type ChatSessionState } from '@portal/contracts';

// The pure part of the shared Bump picker (components/BumpDialog.tsx): which session is picked first and how each row reads. Tickets use
// it today, a CI run's Bump next.

export const BUMP_STATE_LABEL: Record<ChatSessionState, string> = {
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  waiting: 'Needs input',
  interrupted: 'Interrupted',
  ended: 'Ended',
};

/** The session picked when the dialog opens: the preferred one when it can take the bump, else the first that can, else none. */
export function firstPick(targets: readonly BumpTarget[]): string {
  return (targets.find((t) => t.preferred && !t.refusal) ?? targets.find((t) => !t.refusal))?.id ?? '';
}

/** A row's second line: the state, or why it can't take the bump; the workspace only when the list spans several. */
export function targetLine(t: BumpTarget, manyWorkspaces: boolean): string {
  const what = t.refusal ? BUMP_REFUSAL_LABEL[t.refusal] : BUMP_STATE_LABEL[t.state];
  return manyWorkspaces || t.refusal === 'other_workspace' ? `${what} · ${t.workspaceId}` : what;
}

export const spansWorkspaces = (targets: readonly BumpTarget[]): boolean => new Set(targets.map((t) => t.workspaceId)).size > 1;
