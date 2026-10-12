import type { GraphLens } from '@portal/contracts';
import { ArrowLeft } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { pinnedToViewport, useVisualViewport } from '@/lib/viewport';
import { knowledgeApi } from './api';
import { GraphPane, type GraphEnv } from './GraphPane';
import { useLoad } from './hooks';
import { vaultHref } from './labels';

/** The portal-wide graphs, full screen: which sessions and tickets used which notes, and the portal's agents. */
export function GraphPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const viewport = useVisualViewport({ keyboardOnFocus: false });
  const vaults = useLoad('vaults', () => knowledgeApi.vaults());
  const lens = (sp.get('lens') === 'agentic' ? 'agentic' : 'context') as GraphLens;
  const around = sp.get('around');
  const env = useMemo<GraphEnv>(
    () => ({
      openNote: (vaultId, path) => navigate(vaultHref(vaultId, { note: path })),
      openTag: (vaultId, tag) => navigate(vaultHref(vaultId, { pane: 'search', q: `tag:${tag}` })),
      create: (vaultId) => navigate(vaultHref(vaultId)),
      go: (href) => navigate(href),
    }),
    [navigate],
  );
  return (
    <div className="fixed inset-x-0 top-0 flex h-dvh flex-col overflow-hidden bg-bg text-ink" style={pinnedToViewport(viewport)}>
      <header className="flex h-12 shrink-0 items-center gap-1 px-1.5 pt-[env(safe-area-inset-top)] sm:px-3">
        <Link to="/admin/knowledge" aria-label="Knowledge" title="Knowledge" className="press inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink">
          <ArrowLeft className="size-[18px]" />
        </Link>
        <h1 className="min-w-0 flex-1 truncate px-1 text-[15.5px] font-semibold">Graph</h1>
      </header>
      <div className="min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]">
        <GraphPane
          vault={null}
          vaults={vaults.data ?? []}
          lens={lens}
          onLens={(l) => setSp(l === 'context' ? {} : { lens: l }, { replace: true })}
          around={around}
          onAround={(node) => setSp((p) => (node ? { ...Object.fromEntries(p), around: node } : Object.fromEntries([...p].filter(([k]) => k !== 'around'))), { replace: true })}
          env={env}
          tick={0}
        />
      </div>
    </div>
  );
}
