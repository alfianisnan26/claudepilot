import { Button, cn, Dialog, Menu, useMediaQuery, useToast, type MenuItem } from '@isnanme/ui';
import type { GraphLens, NoteView, VaultSummary } from '@portal/contracts';
import { Activity, ArrowLeft, CalendarDays, Download, FilePlus2, FileUp, Folder, HeartPulse, Library, Network, Plus, RefreshCw, Search, Settings, Tags } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { pinnedToViewport, useVisualViewport } from '@/lib/viewport';
import { ActivityPane } from './ActivityPane';
import { errorText, knowledgeApi } from './api';
import { DeleteVaultDialog, ImportDialog, NoteNameDialog, VaultSettingsDialog } from './dialogs';
import type { NoteEnv } from './env';
import { GraphPane, type GraphEnv } from './GraphPane';
import { HealthPane } from './HealthPane';
import { useLoad } from './hooks';
import { vaultHref } from './labels';
import { NotePane } from './NotePane';
import { NotesPane } from './NotesPane';
import { QuickSwitcher } from './QuickSwitcher';
import { SearchPane } from './SearchPane';
import { SidePanel } from './SidePanel';
import { TagsPane } from './TagsPane';

type Pane = 'notes' | 'search' | 'tags';
type Center = 'graph' | 'health' | 'activity';

const PANEL_KEY = 'claudepilot.knowledge-panel';
const savedPanel = () => {
  try {
    return localStorage.getItem(PANEL_KEY) !== '0';
  } catch {
    return true;
  }
};

/**
 * One vault, full screen. Phone: the list (notes, search, tags) or the open note, with a bottom bar. From 1024
 * px: the list beside the note; from 1280 px the note's links and outline too. What is open lives in the URL
 * (`?note=`, `?pane=`, `?view=`, `?edit=1`), so Back goes where a person expects.
 */
export function VaultPage() {
  const { vault: id = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const viewport = useVisualViewport({ keyboardOnFocus: true });
  const lg = useMediaQuery('(min-width: 1024px)');
  const xl = useMediaQuery('(min-width: 1280px)');

  const note = sp.get('note') ?? '';
  const pane = (['notes', 'search', 'tags'].includes(sp.get('pane') ?? '') ? sp.get('pane') : 'notes') as Pane;
  const center = (['graph', 'health', 'activity'].includes(sp.get('view') ?? '') ? sp.get('view') : null) as Center | null;
  const lens = (['docs', 'context', 'agentic'].includes(sp.get('lens') ?? '') ? sp.get('lens') : 'docs') as GraphLens;
  const around = sp.get('around');
  const folder = sp.get('folder') ?? '';
  const q = sp.get('q') ?? '';
  const edit = sp.get('edit') === '1';

  const vault = useLoad(`vault|${id}`, () => knowledgeApi.vault(id));
  const allVaults = useLoad('vaults', () => knowledgeApi.vaults(), center === 'graph');
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);
  const v = vault.data;

  // While the index is being built the counts and lists fill in; refresh them until it is done.
  const scanning = v?.indexState === 'scanning';
  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(() => void vault.reload().then(bump), 1500);
    return () => clearInterval(t);
  }, [scanning, vault, bump]);

  const [panelOpen, setPanelOpen] = useState(savedPanel);
  const [sheet, setSheet] = useState(false);
  const [loaded, setLoaded] = useState<NoteView | null>(null);
  const [scroll, setScroll] = useState<{ heading: string; n: number } | null>(null);
  const [quick, setQuick] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [settings, setSettings] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const update = useCallback(
    (changes: Record<string, string | null>, opts: { replace?: boolean } = {}) => {
      const next = new URLSearchParams(sp);
      for (const [k, val] of Object.entries(changes)) {
        if (val === null) next.delete(k);
        else next.set(k, val);
      }
      setSp(next, { replace: opts.replace });
    },
    [sp, setSp],
  );

  const open = useCallback(
    (path: string, anchor?: { heading?: string }) => {
      update({ note: path, edit: null, view: null, lens: null, around: null });
      if (anchor?.heading) setScroll({ heading: anchor.heading, n: Date.now() });
      setSheet(false);
    },
    [update],
  );

  // Ctrl or Cmd + K.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuick(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const newNote = async (path: string, startEditing = true) => {
    try {
      const r = await knowledgeApi.putNote(id, path, { content: '', create: true });
      bump();
      update({ note: r.path, edit: startEditing ? '1' : null, view: null });
    } catch (e) {
      toast(errorText(e, 'Could not create it.'), 'error');
    }
  };

  const today = async () => {
    try {
      const d = await knowledgeApi.daily(id);
      if (d.exists) open(d.path);
      else await newNote(d.path);
    } catch (e) {
      toast(errorText(e, 'Could not open it.'), 'error');
    }
  };

  const env = useMemo<Pick<NoteEnv, 'href' | 'open' | 'create' | 'tag' | 'entityHref'>>(
    () => ({
      href: (path, anchor) => vaultHref(id, { note: path, h: anchor?.heading }),
      open,
      create: (name) => void newNote(/\.md$/i.test(name) ? name : `${name}.md`),
      tag: (tag) => update({ pane: 'search', q: `tag:${tag}`, ...(lg ? {} : { note: null, view: null }) }),
      entityHref: (type, key) => (type === 'session' ? `/admin/sessions/${encodeURIComponent(key)}` : type === 'workspace' ? '/admin/workspaces' : null),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, open, update, lg],
  );

  // What a tap in the graph does: a note of this vault opens here, one of another vault opens there; the rest are pages of the portal.
  const graphEnv = useMemo<GraphEnv>(
    () => ({
      openNote: (vaultId, path) => (vaultId === id ? open(path) : navigate(vaultHref(vaultId, { note: path }))),
      openTag: (vaultId, tag) => (vaultId === id ? update({ pane: 'search', q: `tag:${tag}`, view: null, around: null, ...(lg ? {} : { note: null }) }) : navigate(vaultHref(vaultId, { pane: 'search', q: `tag:${tag}` }))),
      create: (vaultId, name) => (vaultId === id ? void newNote(/\.md$/i.test(name) ? name : `${name}.md`) : navigate(vaultHref(vaultId))),
      go: (href) => navigate(href),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, open, update, navigate, lg],
  );

  const onPanel = () => {
    if (xl) {
      const next = !panelOpen;
      setPanelOpen(next);
      try {
        localStorage.setItem(PANEL_KEY, next ? '1' : '0');
      } catch {
        // not remembered
      }
    } else setSheet((s) => !s);
  };

  if (vault.error && !v) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[15px] font-semibold">{vault.error.message}</p>
        <Link to="/admin/knowledge" className="text-[14px] font-semibold text-accent">
          Knowledge
        </Link>
      </div>
    );
  }
  if (!v) return <div className="min-h-dvh" aria-busy="true" />;

  const showList = !note && !center;
  const menu: MenuItem[] = [
    { label: 'Tags', icon: <Tags className="size-4" />, onSelect: () => update({ pane: 'tags', note: null, view: null }) },
    { label: 'Link health', icon: <HeartPulse className="size-4" />, onSelect: () => update({ view: 'health', note: null }) },
    { label: 'Activity', icon: <Activity className="size-4" />, onSelect: () => update({ view: 'activity', note: null }) },
    ...(v.kind === 'vault' ? [{ label: 'Import zip', icon: <FileUp className="size-4" />, onSelect: () => setImporting(true) }] : []),
    { label: 'Export zip', icon: <Download className="size-4" />, onSelect: () => (window.location.href = knowledgeApi.exportUrl(id)) },
    { label: 'Rescan', icon: <RefreshCw className="size-4" />, onSelect: () => void knowledgeApi.rescan(id).then((s) => (vault.set(s), bump())).catch((e) => toast(errorText(e, 'Could not rescan.'), 'error')) },
    { label: 'Settings', icon: <Settings className="size-4" />, onSelect: () => setSettings(true) },
  ];

  const iconBtn = 'press inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink';
  const panelNode =
    loaded && note ? (
      <SidePanel
        vault={v}
        note={loaded}
        onOpen={open}
        onCreate={(n) => void newNote(/\.md$/i.test(n) ? n : `${n}.md`)}
        onHeading={(h) => (update({ edit: null }), setScroll({ heading: h, n: Date.now() }), setSheet(false))}
        onGraph={() => (setSheet(false), update({ view: 'graph', lens: 'docs', around: `note:${v.id}:${loaded.path}`, note: null, edit: null }))}
      />
    ) : null;

  return (
    <div className="fixed inset-x-0 top-0 flex h-dvh flex-col overflow-hidden bg-bg text-ink" style={pinnedToViewport(viewport)}>
      <div className="flex min-h-0 flex-1 pt-[env(safe-area-inset-top)]">
        {/* The list: notes, search, tags. */}
        <section className={cn('min-h-0 w-full flex-col lg:flex lg:w-80 lg:shrink-0 lg:border-r lg:border-line', showList ? 'flex' : 'hidden')} aria-label="Vault">
          <header className="flex h-12 shrink-0 items-center gap-0.5 px-1.5 sm:px-2">
            <Link to="/admin/knowledge" aria-label="Knowledge" title="Knowledge" className={iconBtn}>
              <ArrowLeft className="size-[18px]" />
            </Link>
            <div className="min-w-0 flex-1 px-1">
              <h1 className="truncate text-[15.5px] font-semibold">{v.name}</h1>
              {(scanning || v.readOnly) && <p className="truncate text-[11.5px] leading-tight text-muted">{scanning ? 'Indexing…' : 'Read-only'}</p>}
            </div>
            {lg && (
              <button type="button" aria-label="Open note" title="Open note (Ctrl K)" onClick={() => setQuick(true)} className={iconBtn}>
                <Search className="size-[18px]" />
              </button>
            )}
            <button type="button" aria-label="Today" title="Today" onClick={() => void today()} className={iconBtn}>
              <CalendarDays className="size-[18px]" />
            </button>
            {!v.readOnly && (
              <button type="button" aria-label="New note" title="New note" onClick={() => setCreating(folder)} className={iconBtn}>
                <FilePlus2 className="size-[18px]" />
              </button>
            )}
            <Menu label="Vault actions" items={menu} align="right" />
          </header>
          {lg && (
            <div className="flex shrink-0 gap-0.5 px-2 pb-1">
              {(
                [
                  ['notes', Folder, 'Notes'],
                  ['search', Search, 'Search'],
                  ['tags', Tags, 'Tags'],
                ] as const
              ).map(([p, Icon, label]) => (
                <button
                  key={p}
                  type="button"
                  aria-label={label}
                  title={label}
                  aria-pressed={pane === p}
                  onClick={() => update({ pane: p })}
                  className={cn('press inline-flex h-8 flex-1 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink', pane === p && 'bg-surface-2 text-ink')}
                >
                  <Icon className="size-4" />
                </button>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1">
            {pane === 'notes' && <NotesPane vault={v} folder={folder} tick={tick} current={note} onFolder={(f) => update({ folder: f || null }, { replace: true })} onOpen={open} />}
            {pane === 'search' && <SearchPane vault={v} q={q} tick={tick} autoFocus={lg} onQuery={(text) => update({ q: text || null }, { replace: true })} onOpen={open} />}
            {pane === 'tags' && <TagsPane vaultId={v.id} tick={tick} onTag={(t) => update({ pane: 'search', q: `tag:${t}` })} />}
          </div>
        </section>

        {/* The open note, or the graph, link health or activity. */}
        <section className={cn('min-h-0 min-w-0 flex-1 flex-col lg:flex', showList ? 'hidden' : 'flex')} aria-label="Content">
          {note ? (
            <NotePane
              key={`${v.id}|${note}`}
              vault={v}
              path={note}
              edit={edit}
              tick={tick}
              scroll={scroll}
              env={env}
              onBack={lg ? null : () => update({ note: null, edit: null })}
              onEdit={(on) => update({ edit: on ? '1' : null }, { replace: true })}
              onPanel={onPanel}
              panelOpen={xl ? panelOpen : sheet}
              onLoaded={setLoaded}
              onChanged={bump}
              onRenamed={(p) => (bump(), update({ note: p, edit: null }, { replace: true }))}
              onDeleted={() => (bump(), update({ note: null, edit: null }, { replace: true }))}
            />
          ) : center ? (
            <>
              <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-1.5 sm:px-3">
                {!lg && (
                  <button type="button" aria-label="Back" onClick={() => update({ view: null })} className={iconBtn}>
                    <ArrowLeft className="size-[18px]" />
                  </button>
                )}
                <h2 className="min-w-0 flex-1 truncate px-1 text-[15.5px] font-semibold">{center === 'graph' ? 'Graph' : center === 'health' ? 'Link health' : 'Activity'}</h2>
              </header>
              {center === 'graph' ? (
                <div className="min-h-0 flex-1">
                  <GraphPane
                    vault={v}
                    vaults={allVaults.data ?? [v]}
                    lens={lens}
                    onLens={(l) => update({ lens: l === 'docs' ? null : l, around: null }, { replace: true })}
                    around={around}
                    onAround={(node) => update({ around: node }, { replace: true })}
                    env={graphEnv}
                    tick={tick}
                  />
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {center === 'health' && <HealthPane vaultId={v.id} tick={tick} onOpen={open} />}
                  {center === 'activity' && <ActivityPane vaultId={v.id} tick={tick} onOpen={open} />}
                </div>
              )}
            </>
          ) : (
            <Home vault={v} onToday={() => void today()} onNew={() => setCreating(folder)} onGraph={() => update({ view: 'graph' })} />
          )}
        </section>

        {xl && note && panelOpen && (
          <aside aria-label="Links and outline" className="w-80 shrink-0 border-l border-line">
            {panelNode}
          </aside>
        )}
      </div>

      {showList && !lg && <BottomBar pane={pane} onPane={(p) => update({ pane: p, view: null })} onGraph={() => update({ view: 'graph' })} onToday={() => void today()} />}
      {!lg && center && <BottomBar pane={null} graph={center === 'graph'} onPane={(p) => update({ pane: p, view: null })} onGraph={() => update({ view: 'graph' })} onToday={() => void today()} />}

      <Dialog open={!xl && sheet && !!panelNode} onClose={() => setSheet(false)} title="Links">
        <div className="-mx-2 h-[60dvh]">{panelNode}</div>
      </Dialog>
      <QuickSwitcher open={quick} vault={v} onClose={() => setQuick(false)} onOpen={open} />
      <NoteNameDialog
        open={creating !== null}
        title="New note"
        initial={creating ? `${creating}/` : ''}
        submitLabel="Create"
        onClose={() => setCreating(null)}
        onSubmit={async (path) => {
          await knowledgeApi.putNote(id, path, { content: '', create: true });
          setCreating(null);
          bump();
          update({ note: path, edit: '1', view: null });
        }}
      />
      <ImportDialog
        open={importing}
        into={v}
        onClose={() => setImporting(false)}
        onDone={() => {
          void vault.reload();
          bump();
        }}
      />
      <VaultSettingsDialog
        vault={settings ? v : null}
        onClose={() => setSettings(false)}
        onSaved={(s) => (vault.set(s), setSettings(false), toast('Saved'))}
        onDelete={() => (setSettings(false), setDeleting(true))}
      />
      <DeleteVaultDialog vault={deleting ? v : null} onClose={() => setDeleting(false)} onDeleted={() => navigate('/admin/knowledge', { replace: true })} />
    </div>
  );
}

/** The phone's tab bar: notes, search, graph, today. */
function BottomBar({ pane, graph, onPane, onGraph, onToday }: { pane: Pane | null; graph?: boolean; onPane: (p: Pane) => void; onGraph: () => void; onToday: () => void }) {
  const item = (label: string, Icon: typeof Folder, active: boolean, onClick: () => void) => (
    <button key={label} type="button" onClick={onClick} aria-current={active ? 'page' : undefined} className={cn('press flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold', active ? 'text-ink' : 'text-muted')}>
      <Icon className="size-5" strokeWidth={active ? 2.4 : 2} aria-hidden="true" />
      {label}
    </button>
  );
  return (
    <nav aria-label="Vault" className="flex shrink-0 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] lg:hidden">
      {item('Notes', Folder, pane === 'notes', () => onPane('notes'))}
      {item('Search', Search, pane === 'search', () => onPane('search'))}
      {item('Graph', Network, !!graph, onGraph)}
      {item('Today', CalendarDays, false, onToday)}
    </nav>
  );
}

/** Nothing open on a wide screen. */
function Home({ vault, onToday, onNew, onGraph }: { vault: VaultSummary; onToday: () => void; onNew: () => void; onGraph: () => void }) {
  return (
    <div className="hidden h-full flex-col items-center justify-center gap-4 px-6 text-center lg:flex">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <Library className="size-7" />
      </span>
      <div>
        <p className="text-[17px] font-semibold">{vault.name}</p>
        <p className="mt-0.5 text-[13.5px] text-muted">
          {vault.counts.notes.toLocaleString('en')} notes · {vault.counts.tags.toLocaleString('en')} tags
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="secondary" icon={<CalendarDays className="size-4" />} onClick={onToday}>
          Today
        </Button>
        {!vault.readOnly && (
          <Button variant="secondary" icon={<Plus className="size-4" />} onClick={onNew}>
            New
          </Button>
        )}
        <Button variant="secondary" icon={<Network className="size-4" />} onClick={onGraph}>
          Graph
        </Button>
      </div>
    </div>
  );
}
