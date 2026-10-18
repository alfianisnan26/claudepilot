import { cn, Spinner, useToast } from '@isnanme/ui';
import type { AppPortItem } from '@portal/contracts';
import { ArrowLeft, ArrowRight, ExternalLink, ListTree, Plus, RotateCw, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { formatAppTarget, parseAppAddress, type AppTarget } from './appAddress';
import { runOpen } from './appOpen';
import { appProxy } from './appProxy';
import {
  beginLoad,
  canGoForward,
  closeTab,
  currentTarget,
  emptyTabs,
  nativeHistory,
  navigate,
  openTab,
  seqOf,
  setError,
  setSrc,
  step,
  switchTab,
  type AppTab,
  type AppTabs,
} from './appTabs';

/** An icon button at 44 px on touch screens (`tap:`), 36 px elsewhere. */
const iconBtn =
  'flex size-9 shrink-0 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-35 disabled:hover:bg-transparent tap:size-11';

/**
 * App mode (T-948): a browser in the browser. The address bar takes a port inside the workspace; the portal's "open" route returns a
 * one-time URL on the app's own origin, and a frame shows it. Several apps are tabs; all stay mounted so a switch keeps their state.
 */
export function AppView({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [tabs, setTabs] = useState<AppTabs>(emptyTabs);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [off, setOff] = useState(false);
  const [ports, setPorts] = useState<AppPortItem[] | null>(null);
  const [portsOpen, setPortsOpen] = useState(false);
  const [bar, setBar] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const frames = useRef(new Map<number, HTMLIFrameElement | null>());
  const active = tabs.tabs.find((t) => t.id === tabs.active) ?? null;

  const loadPorts = async () => {
    try {
      const list = await appProxy.ports(workspaceId);
      if (list === null) setOff(true);
      else setPorts(list);
    } catch {
      setPorts([]);
    }
  };
  useEffect(() => {
    void loadPorts();
  }, [workspaceId]);

  // The address bar shows the front tab's address.
  useEffect(() => {
    if (active) setText(formatAppTarget(currentTarget(active)));
    else setText('');
    setProblem(null);
  }, [active?.id, active?.index, active?.entries.length]);

  /** Opens a tab's current address through the route and points its frame at the one-time URL. */
  // State changes go through the ref at once, so a second call in the same tick starts from the first one's result.
  const apply = (f: (s: AppTabs) => AppTabs): AppTabs => {
    const next = f(tabsRef.current);
    tabsRef.current = next;
    setTabs(next);
    return next;
  };

  /**
   * Opens a tab's address through the route and points its frame at the one-time URL. The tab's sequence moves on first: when two
   * opens overlap (two quick reloads), only the latest answer is applied and the stale one is dropped.
   */
  const load = async (id: number, target: AppTarget) => {
    const seq = seqOf(
      apply((s) => beginLoad(s, id)),
      id,
    );
    if (seq === null) return;
    const out = await runOpen(() => appProxy.open(workspaceId, target));
    if (out.kind === 'off') return setOff(true);
    if (out.kind === 'url') return void apply((s) => setSrc(s, id, seq, out.url));
    apply((s) =>
      setError(
        s,
        id,
        seq,
        out.kind === 'unsafe' ? 'The portal gave an address that isn’t https.' : errorText(out.error, 'Couldn’t open it.'),
      ),
    );
  };

  const go = (raw: string) => {
    const r = parseAppAddress(raw);
    if (!r.ok) return setProblem(r.reason);
    setProblem(null);
    setBar(false);
    if (active) {
      apply((s) => navigate(s, active.id, r.target));
      void load(active.id, r.target);
    } else newTab(r.target);
  };

  const newTab = (target: AppTarget) => {
    const next = apply((s) => openTab(s, target));
    void load(next.active!, target);
  };

  const pick = (p: AppPortItem) => {
    setPortsOpen(false);
    setBar(false);
    newTab({ port: p.port, path: '/' });
  };

  const stepOwn = (dir: 'back' | 'forward') => {
    if (!active) return;
    const next = apply((s) => step(s, active.id, dir));
    const tab = next.tabs.find((t) => t.id === active.id)!;
    if (tab.index === active.index) return;
    void load(active.id, currentTarget(tab));
  };
  // The frame's own history when its page allows it; a frame on another origin throws, and the typed history takes over.
  const move = (dir: 'back' | 'forward') => {
    if (!active) return;
    let win: Window | null = null;
    try {
      win = frames.current.get(active.id)?.contentWindow ?? null;
    } catch {
      win = null;
    }
    if (!nativeHistory(win, dir)) stepOwn(dir);
  };

  const doReload = () => {
    if (!active) return;
    void load(active.id, currentTarget(active));
  };

  const openOutside = async () => {
    if (!active) return;
    // Opened at once (a phone refuses a window that is opened after a wait), then pointed at the one-time URL.
    const w = window.open('about:blank', '_blank');
    if (w) w.opener = null;
    const target = currentTarget(active);
    const out = await runOpen(() => appProxy.open(workspaceId, target));
    if (out.kind === 'url') {
      if (w) w.location.href = out.url;
      else window.location.assign(out.url);
      return;
    }
    w?.close();
    // The feature is off: the state, not a toast.
    if (out.kind === 'off') return setOff(true);
    toast(out.kind === 'unsafe' ? 'The portal gave an address that isn’t https.' : errorText(out.error, 'Couldn’t open it.'), 'error');
  };

  const close = (id: number) => {
    frames.current.delete(id);
    setTabs((s) => closeTab(s, id));
  };

  if (off)
    return (
      <div className="absolute inset-0 flex items-center justify-center gap-1 px-6 text-center text-sm text-white/70">
        <p>App mode is off</p>
        <InfoTip label="About App mode">
          App mode is off on this portal. The portal’s administrator turns it on with PORT_PROXY_HOST_SUFFIX.
        </InfoTip>
      </div>
    );

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-white/10 bg-[#141416] px-1">
        <button type="button" aria-label="Back" disabled={!active} onClick={() => move('back')} className={iconBtn}>
          <ArrowLeft className="size-[18px]" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          disabled={!active || !canGoForward(active)}
          onClick={() => move('forward')}
          className={cn(iconBtn, 'hidden sm:flex')}
        >
          <ArrowRight className="size-[18px]" />
        </button>
        <button type="button" aria-label="Reload" disabled={!active} onClick={doReload} className={iconBtn}>
          <RotateCw className="size-[18px]" />
        </button>
        <form
          className={cn('min-w-0 flex-1 items-center', bar ? 'flex' : 'hidden sm:flex')}
          onSubmit={(e) => {
            e.preventDefault();
            go(text);
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Address"
            aria-invalid={!!problem}
            placeholder="localhost:8765"
            inputMode="url"
            enterKeyHint="go"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={cn(
              'h-9 min-w-0 flex-1 rounded-lg border bg-white/5 px-3 font-mono text-[16px] text-white outline-hidden focus:border-white/40 sm:text-sm tap:h-11',
              problem ? 'border-red-400/70' : 'border-white/15',
            )}
          />
        </form>
        <button
          type="button"
          aria-label="Address"
          aria-pressed={bar}
          onClick={() => setBar((b) => !b)}
          className={cn(iconBtn, 'sm:hidden', bar && 'bg-white/10 text-white')}
        >
          <Search className="size-[18px]" />
        </button>
        <div className="relative">
          <button
            type="button"
            aria-label="Ports"
            aria-expanded={portsOpen}
            onClick={() => {
              setPortsOpen((o) => !o);
              if (!portsOpen) void loadPorts();
            }}
            className={cn(iconBtn, portsOpen && 'bg-white/10 text-white')}
          >
            <ListTree className="size-[18px]" />
          </button>
          {portsOpen && (
            <>
              <button
                type="button"
                tabIndex={-1}
                aria-label="Close ports"
                className="fixed inset-0 z-20 cursor-default"
                onClick={() => setPortsOpen(false)}
              />
              <div
                role="menu"
                className="absolute top-full right-0 z-30 mt-1 w-64 max-w-[calc(100vw-1rem)] rounded-xl border border-white/10 bg-[#1b1b1e] p-1 shadow-xl"
              >
                {ports === null && (
                  <div className="flex justify-center p-3">
                    <Spinner className="size-4" />
                  </div>
                )}
                {ports?.length === 0 && <p className="px-3 py-2.5 text-sm text-white/60">No ports.</p>}
                {ports?.map((p) => (
                  <button
                    key={p.port}
                    type="button"
                    role="menuitem"
                    disabled={!p.openable}
                    onClick={() => pick(p)}
                    className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-white hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <span className="font-mono">{p.port}</span>
                    {p.process && <span className="min-w-0 flex-1 truncate text-white/50 [overflow-wrap:anywhere]">{p.process}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button type="button" aria-label="Open in new tab" disabled={!active} onClick={() => void openOutside()} className={iconBtn}>
          <ExternalLink className="size-[18px]" />
        </button>
      </div>

      {problem && (
        <p
          role="alert"
          className="shrink-0 border-b border-red-400/30 bg-red-400/10 px-3 py-1.5 text-[13px] text-red-300 [overflow-wrap:anywhere]"
        >
          {problem}
        </p>
      )}

      {tabs.tabs.length > 0 && (
        <div
          role="tablist"
          aria-label="Apps"
          className="flex shrink-0 items-stretch overflow-x-auto border-b border-white/10 bg-[#101012] [scrollbar-width:none]"
        >
          {tabs.tabs.map((t) => (
            <TabChip
              key={t.id}
              tab={t}
              active={t.id === tabs.active}
              onSwitch={() => setTabs((s) => switchTab(s, t.id))}
              onClose={() => close(t.id)}
            />
          ))}
          <button
            type="button"
            aria-label="New app"
            onClick={() => (setPortsOpen(true), void loadPorts())}
            className={cn(iconBtn, 'rounded-none')}
          >
            <Plus className="size-4" />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-white">
        {tabs.tabs.map((t) => (
          <div key={t.id} className={cn('absolute inset-0', t.id !== tabs.active && 'hidden')}>
            {t.src && (
              <iframe
                key={`${t.id}-${t.nonce}`}
                ref={(el) => void frames.current.set(t.id, el)}
                title={formatAppTarget(currentTarget(t))}
                src={t.src}
                referrerPolicy="no-referrer"
                allow="clipboard-read; clipboard-write; fullscreen; autoplay; microphone 'none'; camera 'none'; geolocation 'none'; payment 'none'"
                className="size-full border-0"
              />
            )}
            {t.state !== 'ready' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b0b0c]/85 px-6 text-center text-sm text-white/80">
                {t.state === 'loading' ? (
                  <Spinner className="size-5" />
                ) : (
                  <>
                    <p className="max-w-xs [overflow-wrap:anywhere]">{t.error}</p>
                    <button
                      type="button"
                      onClick={() => void load(t.id, currentTarget(t))}
                      className="flex min-h-11 items-center gap-2 rounded-lg bg-white/10 px-4 text-white"
                    >
                      <RotateCw className="size-4" /> Retry
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {tabs.tabs.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#0b0b0c] px-6 text-center text-sm text-white/70">
            <p className="flex items-center gap-1">
              Pick a port
              <InfoTip label="About App mode">
                Type localhost:&lt;port&gt; or pick a listening port. The app opens here, on its own address, apart from the portal. Back,
                forward and reload work on what you typed.
              </InfoTip>
            </p>
            <div className="flex max-w-full flex-wrap justify-center gap-2">
              {ports
                ?.filter((p) => p.openable)
                .slice(0, 6)
                .map((p) => (
                  <button
                    key={p.port}
                    type="button"
                    onClick={() => pick(p)}
                    className="min-h-11 rounded-lg bg-white/10 px-4 font-mono text-white hover:bg-white/15"
                  >
                    {p.port}
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TabChip({ tab, active, onSwitch, onClose }: { tab: AppTab; active: boolean; onSwitch: () => void; onClose: () => void }) {
  const label = String(currentTarget(tab).port);
  return (
    <div
      role="presentation"
      className={cn('flex shrink-0 items-center border-r border-white/10', active ? 'bg-white/10 text-white' : 'text-white/60')}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSwitch}
        className="flex h-9 min-w-16 items-center px-3 font-mono text-sm tap:h-11"
      >
        {label}
      </button>
      <button
        type="button"
        aria-label={`Close ${label}`}
        onClick={onClose}
        className="flex size-9 items-center justify-center text-white/50 hover:text-white tap:size-11"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
