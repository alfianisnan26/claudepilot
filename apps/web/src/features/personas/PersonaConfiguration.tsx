import type { Workspace, WorkspacePersona, WorkspacePoolAssignment } from '@portal/contracts';
import { useCallback, useEffect, useState } from 'react';
import { useLive } from '@/lib/live';
import { personasApi } from './api';
import { workspacePartsLine } from './labels';

/**
 * The Persona row's detail in a workspace's Configuration (Persona PRD §15): what the persona sets, and
 * the contexts the workspace gets through it. The row itself names the persona and its revision.
 */
export function PersonaConfiguration({ workspace, assignments }: { workspace: Workspace; assignments: WorkspacePoolAssignment[] }) {
  const [data, setData] = useState<WorkspacePersona | null>(null);
  const id = workspace.id;
  const load = useCallback(async () => {
    try {
      setData(await personasApi.workspace(id));
    } catch {
      setData(null);
    }
  }, [id]);
  useEffect(() => void load(), [load, assignments.length]);
  useLive('pools', () => void load());

  if (!data?.persona || !assignments.some((a) => a.state === 'assigned')) return null;
  const line = [workspacePartsLine(data.parts), ...data.contexts.filter((c) => c.via === 'persona').map((c) => c.name)].filter(Boolean).join(' · ');
  return line ? <p className="text-[13px] text-muted">{line}</p> : null;
}
