import { Segmented } from '@isnanme/ui';
import type { GraphNode, NoteView, VaultSummary } from '@portal/contracts';
import { Maximize2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { knowledgeApi } from './api';
import { GraphView, useStableGraph } from './GraphView';
import { useLoad, useRefresh } from './hooks';
import { queryKey } from './graphModel';

/** The notes around the open one, small enough for the side panel; tap one to open it, the corner button for the whole graph. */
export function LocalGraph({ vault, note, onOpen, onExpand }: { vault: VaultSummary; note: NoteView; onOpen: (path: string) => void; onExpand: () => void }) {
  const [depth, setDepth] = useState(1);
  const q = useMemo(() => ({ lens: 'docs' as const, vault: vault.id, around: `note:${vault.id}:${note.path}`, depth, cap: 150 }), [vault.id, note.path, depth]);
  const key = queryKey(q);
  const data = useLoad(`local|${key}`, () => knowledgeApi.graph(q));
  useRefresh(() => void data.reload(), 30_000);
  // A note's own save can change its links: look again once it settles.
  const graph = useStableGraph(data.data);
  const tap = (n: GraphNode) => {
    if (n.kind === 'note' && n.path && n.path !== note.path) onOpen(n.path);
  };
  return (
    <div className="px-1">
      <div className="mb-2 flex items-center gap-2 px-1">
        <div className="w-28">
          <Segmented label="Steps" value={String(depth)} options={['1', '2', '3'].map((d) => ({ value: d, label: d }))} onChange={(d) => setDepth(Number(d))} />
        </div>
        <span className="flex-1" />
        <button type="button" aria-label="Whole graph" title="Whole graph" onClick={onExpand} className="press inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink">
          <Maximize2 className="size-4" />
        </button>
      </div>
      <div className="h-72 overflow-hidden rounded-2xl border border-line bg-surface">
        {graph && graph.nodes.length > 1 ? (
          <GraphView graph={graph} cacheKey={key} selected={null} onTap={tap} onHold={tap} onBlank={() => undefined} compact label={`Notes around ${note.name}: ${graph.nodes.length} nodes`} />
        ) : (
          <p className="flex h-full items-center justify-center px-4 text-center text-[13px] text-muted">{graph ? 'No links' : '…'}</p>
        )}
      </div>
    </div>
  );
}
