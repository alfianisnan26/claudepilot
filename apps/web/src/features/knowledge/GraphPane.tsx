import { Button, ChipGroup, cn, Dialog, LoadError, Segmented, Select, SwitchRow, useMediaQuery, useTheme } from '@isnanme/ui';
import type { GraphLens, GraphNode, GraphResponse, VaultSummary } from '@portal/contracts';
import { ListTree, Maximize2, Minus, Network, Plus, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { knowledgeApi } from './api';
import { GraphView, useStableGraph, type GraphViewHandle } from './GraphView';
import {
  activeFilters,
  AGENT_KINDS,
  colorOf,
  DEFAULT_FILTERS,
  graphQueryOf,
  KIND_LABEL,
  LENS_HELP,
  LENS_LABEL,
  listNodes,
  loadFilters,
  queryKey,
  saveFilters,
  shapeOf,
  type GraphFilters,
} from './graphModel';
import { useLoad, useRefresh } from './hooks';

/** What opening a node does is the page's call: a note opens in the vault, anything else is a page of the portal. */
export interface GraphEnv {
  openNote(vaultId: string, path: string): void;
  openTag(vaultId: string, tag: string): void;
  create(vaultId: string, name: string): void;
  go(href: string): void;
}

const VIEW_KEY = 'claudepilot.kg-graph-view';

function savedView(): 'graph' | 'list' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'graph';
  } catch {
    return 'graph';
  }
}

const nodeVault = (n: GraphNode): string => n.vault ?? n.id.split(':')[1] ?? '';

/**
 * The graph of a vault, or of the portal's sessions and tickets: three lenses over one model, as a canvas to pan and zoom, or as a
 * list. Everything it needs is in the query it sends; the answer says what it left out.
 */
export function GraphPane({
  vault,
  vaults,
  lens,
  onLens,
  around,
  onAround,
  env,
  tick,
}: {
  /** The vault the page is about; null on the portal-wide page, which has no docs lens. */
  vault: VaultSummary | null;
  vaults: VaultSummary[];
  lens: GraphLens;
  onLens: (l: GraphLens) => void;
  around: string | null;
  onAround: (id: string | null) => void;
  env: GraphEnv;
  tick: number;
}) {
  const wide = useMediaQuery('(min-width: 640px)');
  const dark = useTheme().resolvedTheme === 'dark';
  const scopeKey = vault?.id ?? 'all';
  const [filters, setFilters] = useState<GraphFilters>(() => loadFilters(scopeKey));
  const [view, setView] = useState<'graph' | 'list'>(savedView);
  const [depth, setDepth] = useState(1);
  const [picked, setPicked] = useState<GraphNode | null>(null);
  const [sheet, setSheet] = useState(false);
  const [text, setText] = useState('');
  const handle = useRef<GraphViewHandle>(null);

  useEffect(() => saveFilters(scopeKey, filters), [scopeKey, filters]);
  const set = (change: Partial<GraphFilters>) => setFilters((f) => ({ ...f, ...change }));
  const setViewKind = (v: 'graph' | 'list') => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // not remembered
    }
  };

  const q = useMemo(() => graphQueryOf(lens, vault?.id ?? null, filters, { around: around ?? undefined, depth, cap: wide ? undefined : 800 }), [lens, vault?.id, filters, around, depth, wide]);
  const key = queryKey(q);
  const data = useLoad(`graph|${key}|${tick}`, () => knowledgeApi.graph(q));
  useRefresh(() => void data.reload(), 30_000, lens !== 'docs');
  const graph = useStableGraph(data.data);
  useEffect(() => setPicked(null), [key]);

  const centerNode = graph?.center ? graph.nodes.find((n) => n.id === graph.center) : null;

  const tap = (n: GraphNode) => {
    setPicked(null);
    if (n.kind === 'note' && n.path) return env.openNote(nodeVault(n), n.path);
    if (n.kind === 'tag') return env.openTag(nodeVault(n), n.label.replace(/^#/, ''));
    if (n.kind === 'attachment' && n.path) return void window.open(knowledgeApi.fileUrl(nodeVault(n), n.path), '_blank', 'noopener');
    if (n.kind === 'unresolved') return env.create(nodeVault(n), n.label.endsWith('…') ? (n.id.split(':').slice(2).join(':') || n.label) : n.label);
    if (n.kind === 'cluster') {
      // A folder's group opens up as the folder; any other group is only a count.
      if (lens === 'docs' && n.group && !(n.group in KIND_LABEL)) return set({ folder: n.group });
      return setPicked(n);
    }
    if (n.href) return env.go(n.href);
    setPicked(n);
  };
  const hold = (n: GraphNode) => {
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8);
    setPicked(n);
  };

  const lenses: GraphLens[] = vault ? ['docs', 'context', 'agentic'] : ['context', 'agentic'];
  const active = activeFilters(lens, filters);
  const iconBtn = 'press inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-2 pt-2 pb-1.5 sm:px-3">
        <div className="min-w-0 flex-1 sm:max-w-sm">
          <Segmented label="Graph" value={lens} options={lenses.map((l) => ({ value: l, label: LENS_LABEL[l] }))} onChange={(l) => (onAround(null), onLens(l))} />
        </div>
        <InfoTip label="About this graph">
          <span className="block">{LENS_HELP[lens]}</span>
          {graph && <Legend nodes={graph.nodes} dark={dark} />}
        </InfoTip>
        <span className="hidden flex-1 sm:block" />
        <button type="button" aria-label={view === 'graph' ? 'List' : 'Graph'} title={view === 'graph' ? 'List' : 'Graph'} onClick={() => setViewKind(view === 'graph' ? 'list' : 'graph')} className={iconBtn}>
          {view === 'graph' ? <ListTree className="size-[18px]" /> : <Network className="size-[18px]" />}
        </button>
        <button type="button" aria-label="Filters" title="Filters" onClick={() => setSheet(true)} className={cn(iconBtn, 'relative')}>
          <SlidersHorizontal className="size-[18px]" />
          {active > 0 && <span className="absolute top-1 right-1 size-2 rounded-full bg-accent" aria-hidden="true" />}
        </button>
      </div>

      {around && (
        <div className="flex shrink-0 items-center gap-1.5 px-2 pb-1.5 sm:px-3">
          <span className="inline-flex min-w-0 max-w-[60%] items-center gap-1 rounded-full bg-accent-soft py-0.5 pr-1 pl-2.5 text-[12.5px] font-semibold text-accent">
            <span className="truncate">{centerNode?.label ?? 'Around'}</span>
            <button type="button" aria-label="Whole graph" title="Whole graph" onClick={() => onAround(null)} className="inline-flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-accent/15">
              <X className="size-3.5" />
            </button>
          </span>
          <div className="w-28">
            <Segmented label="Steps" value={String(depth)} options={['1', '2', '3'].map((d) => ({ value: d, label: d }))} onChange={(d) => setDepth(Number(d))} />
          </div>
        </div>
      )}

      <div className="relative min-h-0 flex-1 border-t border-line">
        {data.error && !graph ? (
          <LoadError onRetry={data.reload} />
        ) : !graph ? (
          <div className="flex h-full items-center justify-center text-[13px] text-muted" aria-busy="true">
            …
          </div>
        ) : graph.nodes.length === 0 ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-[14px] text-muted">{lens === 'context' ? 'No activity yet' : lens === 'agentic' ? 'Nothing yet' : 'No notes'}</p>
        ) : view === 'list' ? (
          <GraphList nodes={graph.nodes} text={text} onText={setText} onTap={tap} dark={dark} />
        ) : (
          <>
            <GraphView
              ref={handle}
              graph={graph}
              cacheKey={key}
              selected={picked?.id ?? null}
              onTap={tap}
              onHold={hold}
              onBlank={() => setPicked(null)}
              label={`${LENS_LABEL[lens]} graph: ${graph.nodes.length} nodes, ${graph.edges.length} links. The list view has the same nodes.`}
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2">
              {graph.message ? <p className="pointer-events-auto max-w-[75%] rounded-lg bg-bg/80 px-2 py-1 text-[12px] leading-snug text-muted backdrop-blur-sm">{graph.message}</p> : <span />}
            </div>
            <div className="absolute right-2 bottom-2 flex flex-col gap-1.5">
              {wide && (
                <>
                  <button type="button" aria-label="Zoom in" onClick={() => handle.current?.zoomBy(1.4)} className={cn(iconBtn, 'border border-line bg-bg/90 shadow-sm')}>
                    <Plus className="size-4" />
                  </button>
                  <button type="button" aria-label="Zoom out" onClick={() => handle.current?.zoomBy(1 / 1.4)} className={cn(iconBtn, 'border border-line bg-bg/90 shadow-sm')}>
                    <Minus className="size-4" />
                  </button>
                </>
              )}
              <button type="button" aria-label="Fit" title="Fit" onClick={() => handle.current?.fit()} className={cn(iconBtn, 'border border-line bg-bg/90 shadow-sm')}>
                <Maximize2 className="size-4" />
              </button>
            </div>
          </>
        )}
        {graph && view === 'list' && graph.message && <p className="absolute inset-x-0 bottom-0 bg-bg/90 px-3 py-1.5 text-[12px] text-muted">{graph.message}</p>}
        {picked && graph && (
          <PickedCard
            node={picked}
            lens={lens}
            onClose={() => setPicked(null)}
            onOpen={() => tap(picked)}
            onAround={picked.kind === 'cluster' ? null : () => (onAround(picked.id), setPicked(null))}
            dark={dark}
          />
        )}
      </div>

      <FiltersSheet open={sheet} onClose={() => setSheet(false)} lens={lens} vault={vault} vaults={vaults} filters={filters} onChange={set} onReset={() => setFilters(DEFAULT_FILTERS)} />
    </div>
  );
}

/** The kinds in the graph, each with its colour. */
function Legend({ nodes, dark }: { nodes: GraphNode[]; dark: boolean }) {
  const kinds = [...new Set(nodes.filter((n) => n.kind !== 'cluster').map((n) => n.kind))].slice(0, 12);
  if (kinds.length < 2) return null;
  return (
    <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
      {kinds.map((k) => {
        const sample = nodes.find((n) => n.kind === k)!;
        return (
          <span key={k} className="inline-flex items-center gap-1">
            <Dot kind={k} color={colorOf(sample, dark)} />
            {KIND_LABEL[k]}
          </span>
        );
      })}
    </span>
  );
}

function Dot({ kind, color }: { kind: GraphNode['kind']; color: string }) {
  const shape = shapeOf(kind);
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2.5 shrink-0', shape === 'circle' && 'rounded-full', shape === 'square' && 'rounded-[3px]', shape === 'diamond' && 'rotate-45 rounded-[2px]', shape === 'ring' && 'rounded-full border-2 border-dashed')}
      style={shape === 'ring' ? { borderColor: color } : { backgroundColor: color }}
    />
  );
}

function PickedCard({ node, lens, onClose, onOpen, onAround, dark }: { node: GraphNode; lens: GraphLens; onClose: () => void; onOpen: () => void; onAround: (() => void) | null; dark: boolean }) {
  void lens;
  const detail = node.kind === 'cluster' ? `${(node.count ?? 0).toLocaleString('en')} more` : [KIND_LABEL[node.kind], node.degree > 0 ? `${node.degree} ${node.degree === 1 ? 'link' : 'links'}` : '', node.state && node.state !== 'gone' ? node.state.replace(/_/g, ' ') : ''].filter(Boolean).join(' · ');
  return (
    <div className="absolute inset-x-2 bottom-2 z-10 flex items-center gap-2 rounded-2xl border border-line bg-surface p-2.5 pl-3 shadow-lg sm:right-auto sm:w-96">
      <Dot kind={node.kind} color={colorOf(node, dark)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold">{node.label}</span>
        <span className="block truncate text-[12px] text-muted">{detail}</span>
      </span>
      {onAround && (
        <Button size="sm" variant="secondary" onClick={onAround}>
          Around
        </Button>
      )}
      {(node.kind !== 'cluster' || node.group) && (
        <Button size="sm" onClick={onOpen}>
          {node.kind === 'cluster' ? 'Zoom' : 'Open'}
        </Button>
      )}
      <button type="button" aria-label="Close" onClick={onClose} className="press inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2">
        <X className="size-4" />
      </button>
    </div>
  );
}

/** The same nodes as a list: most linked first, narrowed by what is typed. */
function GraphList({ nodes, text, onText, onTap, dark }: { nodes: GraphNode[]; text: string; onText: (t: string) => void; onTap: (n: GraphNode) => void; dark: boolean }) {
  const [shown, setShown] = useState(100);
  const items = useMemo(() => listNodes(nodes, text), [nodes, text]);
  useEffect(() => setShown(100), [text, nodes]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 py-2">
        <input
          type="search"
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder="Filter"
          aria-label="Filter"
          className="h-9 w-full rounded-xl border border-line bg-surface px-3 text-[14px] outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-6 [scrollbar-width:thin]">
        {items.slice(0, shown).map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => onTap(n)} className="press flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[14px] hover:bg-surface-2/70">
              <Dot kind={n.kind} color={colorOf(n, dark)} />
              <span className="min-w-0 flex-1 truncate">{n.kind === 'cluster' ? `${n.label} · ${(n.count ?? 0).toLocaleString('en')} more` : n.label}</span>
              {n.kind !== 'note' && n.kind !== 'cluster' && <span className="shrink-0 text-[12px] text-muted">{KIND_LABEL[n.kind]}</span>}
              <span className="w-8 shrink-0 text-right text-[12px] text-muted tabular-nums">{n.degree}</span>
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">None</li>}
        {items.length > shown && (
          <li className="flex justify-center py-2">
            <Button size="sm" variant="secondary" onClick={() => setShown((s) => s + 200)}>
              More
            </Button>
          </li>
        )}
      </ul>
    </div>
  );
}

/** The filters of the lens being shown; a change applies at once. */
function FiltersSheet({
  open,
  onClose,
  lens,
  vault,
  vaults,
  filters: f,
  onChange,
  onReset,
}: {
  open: boolean;
  onClose: () => void;
  lens: GraphLens;
  vault: VaultSummary | null;
  vaults: VaultSummary[];
  filters: GraphFilters;
  onChange: (c: Partial<GraphFilters>) => void;
  onReset: () => void;
}) {
  const tree = useLoad(`graph-folders|${vault?.id}`, () => knowledgeApi.tree(vault!.id, ''), open && lens === 'docs' && !!vault);
  const tags = useLoad(`graph-tags|${vault?.id}`, () => knowledgeApi.tags(vault!.id), open && lens === 'docs' && !!vault);
  const folders = (tree.data?.entries ?? []).filter((e) => e.kind === 'folder').map((e) => e.path);
  const sinceOptions = lens === 'context' ? (['24h', '7d', '30d'] as const) : (['7d', '30d', '90d'] as const);
  return (
    <Dialog open={open} onClose={onClose} title="Filters" footer={<Button variant="secondary" onClick={onReset}>Reset</Button>}>
      <div className="flex flex-col gap-3.5">
        {lens === 'docs' && (
          <>
            <Select label="Folder" value={f.folder} onChange={(v) => onChange({ folder: v })} options={[{ value: '', label: 'All folders' }, ...[...new Set([...(f.folder ? [f.folder] : []), ...folders])].map((p) => ({ value: p, label: p }))]} />
            <Select label="Tag" value={f.tag} onChange={(v) => onChange({ tag: v })} options={[{ value: '', label: 'All tags' }, ...[...new Set([...(f.tag ? [f.tag] : []), ...(tags.data ?? []).slice(0, 200).map((t) => t.tag)])].map((t) => ({ value: t, label: `#${t}` }))]} />
            <div className="-mx-1">
              <SwitchRow label="Tags" checked={f.tags} onChange={(v) => onChange({ tags: v })} />
              <SwitchRow label="Files" checked={f.attachments} onChange={(v) => onChange({ attachments: v })} />
              <SwitchRow label="Missing notes" checked={f.unresolved} onChange={(v) => onChange({ unresolved: v })} />
              <SwitchRow label="Hide unlinked" checked={f.hideOrphans} onChange={(v) => onChange({ hideOrphans: v })} />
            </div>
          </>
        )}
        {lens !== 'docs' && (
          <>
            <Segmented label="Since" value={f.since} options={sinceOptions.map((s) => ({ value: s, label: s }))} onChange={(v) => onChange({ since: v })} />
            {lens === 'context' && (
              <Segmented
                label="Access"
                value={f.access || 'all'}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'read', label: 'Read' },
                  { value: 'write', label: 'Write' },
                ]}
                onChange={(v) => onChange({ access: v === 'all' ? '' : v })}
              />
            )}
            {lens === 'agentic' && (
              <ChipGroup
                multiple
                label="Show"
                options={AGENT_KINDS.map((k) => ({ value: k.value, label: k.label }))}
                value={f.kinds.length ? f.kinds : AGENT_KINDS.map((k) => k.value)}
                onChange={(v) => onChange({ kinds: v.length === AGENT_KINDS.length ? [] : v })}
              />
            )}
            {vault && vaults.length > 1 && <SwitchRow label="All vaults" checked={f.allVaults} onChange={(v) => onChange({ allVaults: v })} />}
          </>
        )}
      </div>
    </Dialog>
  );
}
