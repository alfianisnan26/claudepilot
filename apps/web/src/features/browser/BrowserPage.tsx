import { Button, cn, ConfirmDialog, Menu, Spinner, useToast } from '@isnanme/ui';
import type { BrowserHandoff, BrowserStatus } from '@portal/contracts';
import { ArrowLeft, Eye, EyeOff, Globe, Hand, Keyboard, Monitor, Moon, RotateCw, Send } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { KeyBar, type KeyDef, type Modifier, type ModState } from '@/components/KeyBar';
import { BRAND_NAME } from '@/components/Logo';
import { errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { pinnedToViewport, useVisualViewport } from '@/lib/viewport';
import { browserApi } from './api';
import { deviceId, deviceName } from './device';
import { STATE } from './labels';
import { useBrowserStatus } from './useBrowserStatus';
import { PreviewView, type PreviewHandle } from './PreviewView';
import { ControlFrame, type ViewPhase } from './shared';
import type { VncHandle } from './VncView';

// noVNC is the larger half of this page and a phone watches the preview by default: it loads when the screen is shown.
const VncView = lazy(() => import('./VncView').then((m) => ({ default: m.VncView })));

const NO_MODS: Record<Modifier, ModState> = { ctrl: 'off', alt: 'off' };
const NEXT_MOD: Record<ModState, ModState> = { off: 'once', once: 'locked', locked: 'off' };

/** The keys a phone lacks, as the live view sends them: `key:<name>` or `ctrl:<letter>` (the KeyBar passes the string back). */
const KEYS: KeyDef[] = [
  { label: 'Esc', send: 'key:Escape' },
  { label: 'Tab', send: 'key:Tab' },
  { label: 'Ctrl', modifier: 'ctrl' },
  { label: 'Alt', modifier: 'alt' },
  { label: '⌫', name: 'Backspace', send: 'key:Backspace', repeat: true },
  { label: '⏎', name: 'Enter', send: 'key:Enter' },
  { label: '←', name: 'Left', send: 'key:Left', repeat: true },
  { label: '↑', name: 'Up', send: 'key:Up', repeat: true },
  { label: '↓', name: 'Down', send: 'key:Down', repeat: true },
  { label: '→', name: 'Right', send: 'key:Right', repeat: true },
  { label: 'Home', send: 'key:Home' },
  { label: 'End', send: 'key:End' },
  { label: 'PgUp', name: 'Page up', send: 'key:PageUp' },
  { label: 'PgDn', name: 'Page down', send: 'key:PageDown' },
  { label: '^L', name: 'Address bar (Ctrl+L)', send: 'ctrl:l' },
  { label: '^W', name: 'Close tab (Ctrl+W)', send: 'ctrl:w' },
];

/** The preview has no browser chrome to reach with Ctrl+L or Ctrl+W (it has its own address bar and tabs): select-all and delete instead. */
const PREVIEW_KEYS: KeyDef[] = [...KEYS.filter((k) => k.send !== 'ctrl:l' && k.send !== 'ctrl:w'), { label: '^A', name: 'Select all (Ctrl+A)', send: 'ctrl:a' }, { label: 'Del', name: 'Delete', send: 'key:Delete' }];

type ViewKind = 'screen' | 'preview';
const VIEW_KEY = 'pilot.browser.view';
const readView = (): ViewKind | null => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'screen' || v === 'preview' ? v : null;
  } catch {
    return null;
  }
};

const host = (url: string | undefined) => {
  try {
    return url ? new URL(url).host || url : '';
  } catch {
    return '';
  }
};

/**
 * One workspace's browser, full screen (browser PRD §15): its screen over VNC, or the preview the portal draws itself
 * (§22), watched by default, with control taken on purpose and handed back. Everything the page says is a word or
 * two; the rest is behind icons and tooltips.
 */
export function BrowserPage() {
  const { target = '', name = '' } = useParams();
  const workspaceId = `${target}/${name}`;
  const toast = useToast();
  const device = useMemo(deviceId, []);
  const { status, error, reload } = useBrowserStatus(workspaceId, device);
  const viewport = useVisualViewport();
  const vnc = useRef<VncHandle>(null);
  const preview = useRef<PreviewHandle>(null);
  const [phase, setPhase] = useState<ViewPhase>({ kind: 'connecting' });
  const [pref, setPref] = useState<ViewKind | null>(readView);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | 'take' | 'over'>(null);
  const [typing, setTyping] = useState(false);
  const [mods, setMods] = useState(NO_MODS);
  const modsRef = useRef(NO_MODS);
  modsRef.current = mods;

  useEffect(() => {
    document.title = `${name} · browser`;
    return () => void (document.title = BRAND_NAME);
  }, [name]);

  const running = !!status && status.pool !== null && status.container === 'running';
  const mine = !!status?.control?.mine;
  const held = !!status?.control?.held;
  const waiting = status?.handoffs.find((h) => h.state === 'waiting');
  const priv = !!status?.control?.private && !mine;

  // Opening the live view wakes a sleeping browser (PRD §14.2), once.
  const woke = useRef(false);
  useEffect(() => {
    if (running && status?.chrome === 'asleep' && !woke.current) {
      woke.current = true;
      void browserApi.action(workspaceId, 'wake').catch(() => undefined);
    }
  }, [running, status?.chrome, workspaceId]);

  // The cover comes off when control stops being private: connect again.
  const wasPrivate = useRef(false);
  useEffect(() => {
    if (wasPrivate.current && !priv) setAttempt((n) => n + 1);
    wasPrivate.current = priv;
  }, [priv]);

  const act = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      toast(errorText(e, failure), 'error');
    } finally {
      setBusy(false);
    }
  };
  const take = (handoff?: BrowserHandoff, takeOver = false) =>
    act(() => browserApi.control(workspaceId, { on: true, deviceId: device, label: deviceName(), takeOver, ...(handoff ? { handoffId: handoff.id } : {}) }), 'Couldn’t take control.');
  const handBack = () =>
    act(
      () => (waiting || status?.handoffs.some((h) => h.state === 'in_control') ? browserApi.answerHandoff(workspaceId, (status!.handoffs.find((h) => h.state === 'in_control') ?? waiting)!.id, { state: 'handed_back', deviceId: device }) : browserApi.control(workspaceId, { on: false, deviceId: device })),
      'Couldn’t hand back.',
    );
  const decline = (h: BrowserHandoff) => act(() => browserApi.answerHandoff(workspaceId, h.id, { state: 'declined', deviceId: device }), 'Couldn’t decline.');

  const askTake = () => {
    if (!status) return;
    // The agent is working, or another device has it: a deliberate second tap (PRD §15.4).
    if (status.state === 'working') return setConfirm('take');
    if (held && !mine) return setConfirm('over');
    void take();
  };

  const views = { screen: !!status?.views.vnc, preview: !!status?.views.proxy };
  // Both offered: the person's last choice, else the preview on a touch screen (it is lighter and made for one) and the screen elsewhere.
  const view: ViewKind | null = !status ? null : views.screen && views.preview ? (pref ?? (matchMedia('(pointer: coarse)').matches ? 'preview' : 'screen')) : views.preview ? 'preview' : views.screen ? 'screen' : null;
  const choose = (v: ViewKind) => {
    setPref(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // not remembered
    }
  };
  const handle = () => (view === 'preview' ? preview.current : vnc.current);

  const sendKey = (token: string) => {
    const m = modsRef.current;
    const [kind, arg] = token.split(':') as ['key' | 'ctrl', string];
    if (kind === 'ctrl') handle()?.sendCtrl(arg);
    else handle()?.sendKey(arg as never, { ctrl: m.ctrl !== 'off', alt: m.alt !== 'off' });
    setMods({ ctrl: m.ctrl === 'once' ? 'off' : m.ctrl, alt: m.alt === 'once' ? 'off' : m.alt });
  };

  const state = status ? STATE[status.state] : null;
  const front = host(status?.tabs[0]?.url);
  const showView = running && view !== null;

  return (
    <div
      className="fixed inset-x-0 top-0 flex h-dvh flex-col bg-[#0b0b0c] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-[#e6e6e6]"
      style={pinnedToViewport(viewport)}
    >
      <header className="z-10 flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-white/10 px-2 pt-[env(safe-area-inset-top)] sm:px-3">
        <Link to="/admin/workspaces" aria-label="Back" className="flex size-9 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white">
          <ArrowLeft className="size-[18px]" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm font-semibold">{name}</p>
          <p className="truncate text-[11px] text-white/50">{front || 'browser'}</p>
        </div>
        {views.screen && views.preview && (
          <div role="group" aria-label="View" className="flex shrink-0 rounded-lg bg-white/5 p-0.5">
            {(
              [
                ['screen', 'Screen: the browser’s display', <Monitor key="s" className="size-4" />],
                ['preview', 'Preview: the page, drawn here', <Globe key="p" className="size-4" />],
              ] as const
            ).map(([kind, title, icon]) => (
              <button
                key={kind}
                type="button"
                title={title}
                aria-label={title}
                aria-pressed={view === kind}
                onClick={() => choose(kind)}
                className={cn('flex size-7 items-center justify-center rounded-md', view === kind ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white')}
              >
                {icon}
              </button>
            ))}
          </div>
        )}
        {state && (
          <span className="flex items-center gap-1.5 text-xs text-white/70" title={status?.detail ?? undefined}>
            <span className={cn('size-2 rounded-full', status!.state === 'error' ? 'bg-red-400' : status!.state === 'needs_input' || status!.state === 'in_control' ? 'bg-amber-400' : status!.state === 'working' || status!.state === 'ready' ? 'bg-emerald-400' : 'bg-white/40', status!.state === 'working' && 'animate-pulse')} />
            <span className="hidden sm:inline">{state.label}</span>
            <span className="sr-only sm:hidden">{state.label}</span>
          </span>
        )}
        {status?.sandbox === 'off' && (
          <span title="Chrome runs without its sandbox" className="rounded-md bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-300">
            No sandbox
          </span>
        )}
        <span className="[&>div>button]:text-white/70 [&>div>button:hover]:bg-white/10 [&>div>button:hover]:text-white [&>div>button[aria-expanded=true]]:bg-white/10">
          <Menu
            label="Browser options"
            items={[
              { label: 'Restart browser', icon: <RotateCw className="size-4" />, onSelect: () => void act(() => browserApi.action(workspaceId, 'restart'), 'Couldn’t restart it.'), disabled: !running },
              { label: 'Sleep browser', icon: <Moon className="size-4" />, onSelect: () => void act(() => browserApi.action(workspaceId, 'stop'), 'Couldn’t stop it.'), disabled: !running || held },
            ]}
          />
        </span>
      </header>

      <div className="relative min-h-0 flex-1">
        {showView && view === 'screen' && (
          <Suspense fallback={null}>
            <VncView ref={vnc} key="screen" workspaceId={workspaceId} device={device} controller={mine} paused={priv} attempt={attempt} onPhase={setPhase} className="absolute inset-0" />
          </Suspense>
        )}
        {showView && view === 'preview' && (
          <PreviewView ref={preview} key="preview" workspaceId={workspaceId} device={device} controller={mine} paused={priv} attempt={attempt} onPhase={setPhase} className="absolute inset-0" />
        )}
        {showView && mine && <ControlFrame />}
        <Cover status={status} error={error} phase={phase} priv={priv} running={running} view={view} showView={showView} onRetry={() => setAttempt((n) => n + 1)} />
      </div>

      <Dock
        status={status}
        mine={mine}
        held={held}
        waiting={waiting}
        busy={busy}
        typing={typing}
        onTyping={() => setTyping((t) => !t)}
        onTake={askTake}
        onHandBack={() => void handBack()}
        onDecline={(h) => void decline(h)}
        onTakeHandoff={(h) => void take(h)}
        onText={(t, enter) => handle()?.sendText(t, enter)}
      />
      {mine && typing && (
        <KeyBar
          keys={view === 'preview' ? PREVIEW_KEYS : KEYS}
          mods={mods}
          onKey={sendKey}
          onModifier={(m) => setMods({ ...modsRef.current, [m]: NEXT_MOD[modsRef.current[m]] })}
          className="pb-[max(0.375rem,env(safe-area-inset-bottom))]"
        />
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'over' ? `Take over from ${status?.control?.label ?? 'another device'}?` : 'Take control?'}
        description={confirm === 'over' ? 'It stops being in control.' : 'The agent’s browser calls wait until you hand back.'}
        confirmLabel="Take control"
        loading={busy}
        onConfirm={() => {
          const over = confirm === 'over';
          setConfirm(null);
          void take(undefined, over);
        }}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

/** What stands over the screen when there isn't one to show: a word, and the way forward. */
function Cover({ status, error, phase, priv, running, view, showView, onRetry }: { status: BrowserStatus | null; error: string | null; phase: ViewPhase; priv: boolean; running: boolean; view: ViewKind | null; showView: boolean; onRetry: () => void }) {
  let text: string | null = null;
  let busy = false;
  let retry = false;
  if (error && !status) text = error;
  else if (!status) busy = true;
  else if (status.pool === null) text = 'No browser here.';
  else if (status.state === 'workspace_stopped') text = 'Stopped.';
  else if (status.state === 'restart_needed') text = status.detail ?? 'Restart the workspace.';
  else if (!running) busy = true;
  else if (status.state === 'error') text = status.detail ?? 'Something went wrong.';
  else if (view === null) text = 'No live view.';
  else if (priv) text = `Private · ${status.control?.label ?? 'someone'} is signing in`;
  else if (showView && view === 'screen' && phase.kind === 'connecting') busy = true;
  else if (showView && phase.kind === 'closed') {
    text = phase.reason;
    retry = true;
  }
  if (!text && !busy) return null;
  return (
    <div className={cn('absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm', priv ? 'bg-[#0b0b0c]' : 'bg-[#0b0b0c]/80')}>
      {busy ? <Spinner className="size-5" /> : <p className="max-w-xs text-white/80">{text}</p>}
      {retry && (
        <Button size="sm" variant="secondary" icon={<RotateCw className="size-4" />} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

function Dock({
  status,
  mine,
  held,
  waiting,
  busy,
  typing,
  onTyping,
  onTake,
  onHandBack,
  onDecline,
  onTakeHandoff,
  onText,
}: {
  status: BrowserStatus | null;
  mine: boolean;
  held: boolean;
  waiting: BrowserHandoff | undefined;
  busy: boolean;
  typing: boolean;
  onTyping: () => void;
  onTake: () => void;
  onHandBack: () => void;
  onDecline: (h: BrowserHandoff) => void;
  onTakeHandoff: (h: BrowserHandoff) => void;
  onText: (text: string, enter: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [hidden, setHidden] = useState(false);
  if (!status || status.pool === null || status.container !== 'running' || status.state === 'error') return null;
  const blocked = status.canTakeOver ? undefined : (status.takeOverBlocked ?? undefined);
  const send = (enter: boolean) => {
    if (!text) return;
    onText(text, enter);
    setText('');
  };

  const bar = 'flex shrink-0 items-center gap-2 border-t border-white/10 bg-[#141416] px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]';

  if (waiting && !mine)
    return (
      <div className={cn(bar, 'flex-col items-stretch gap-2')}>
        <p className="truncate text-sm font-semibold">Sign-in needed{waiting.origin ? ` on ${host(waiting.origin) || waiting.origin}` : ''}</p>
        {waiting.reason && <p className="line-clamp-2 text-[13px] text-white/60">“{waiting.reason}”</p>}
        <div className="flex gap-2">
          <Button className="flex-1" disabled={!status.canTakeOver || busy} title={blocked} icon={<Hand className="size-4" />} onClick={() => onTakeHandoff(waiting)}>
            Take control
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => onDecline(waiting)}>
            Decline
          </Button>
        </div>
        {blocked && <p className="text-xs text-white/50">{blocked}</p>}
      </div>
    );

  if (mine)
    return (
      <div className={cn(bar, 'flex-col items-stretch')}>
        {typing && (
          <div className="flex items-center gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), send(true))}
              type={hidden ? 'password' : 'text'}
              aria-label="Text to type"
              placeholder="Type here"
              enterKeyHint="go"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="h-10 min-w-0 flex-1 rounded-lg border border-white/15 bg-white/5 px-3 text-sm text-white outline-hidden focus:border-white/40"
            />
            <button type="button" aria-label={hidden ? 'Show text' : 'Hide text'} onClick={() => setHidden((h) => !h)} className="flex size-10 items-center justify-center rounded-lg text-white/70 hover:bg-white/10">
              {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
            <button type="button" aria-label="Send" onClick={() => send(false)} disabled={!text} className="flex size-10 items-center justify-center rounded-lg bg-white/10 text-white disabled:opacity-40">
              <Send className="size-4" />
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm text-emerald-300">You have control</p>
          <button type="button" aria-label="Keyboard" aria-pressed={typing} onClick={onTyping} className={cn('flex size-10 items-center justify-center rounded-lg', typing ? 'bg-white text-black' : 'text-white/70 hover:bg-white/10')}>
            <Keyboard className="size-[18px]" />
          </button>
          <Button variant="secondary" disabled={busy} onClick={onHandBack}>
            Hand back
          </Button>
        </div>
      </div>
    );

  const tool = status.lastTool && Date.now() - Date.parse(status.lastTool.at) < 90_000 ? status.lastTool : null;
  return (
    <div className={bar}>
      <p className="min-w-0 flex-1 truncate text-sm text-white/60">
        {held ? `${status.control?.label ?? 'Someone'} has control` : tool ? `Agent · ${tool.name.replace(/^browser_/, '')} · ${timeAgo(tool.at)}` : status.state === 'asleep' ? 'Asleep' : 'Watching'}
      </p>
      <Button variant={status.state === 'working' || held ? 'secondary' : 'primary'} disabled={!status.canTakeOver || busy} title={blocked} icon={<Hand className="size-4" />} onClick={onTake}>
        {held ? 'Take over' : 'Take control'}
      </Button>
    </div>
  );
}
