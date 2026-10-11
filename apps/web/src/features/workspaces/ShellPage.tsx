import { Button, cn, ConfirmDialog, useToast } from '@isnanme/ui';
import type { ShellClientMessage, ShellServerMessage, WorkspaceTerminal } from '@portal/contracts';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { ArrowLeft, Bot, Plus, RotateCw, SquareTerminal, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { BRAND_NAME } from '@/components/Logo';
import { api, errorText } from '@/lib/api';
import { NewTerminalDialog } from './NewTerminalDialog';

type Phase = { kind: 'connecting' } | { kind: 'open' } | { kind: 'closed'; reason: string };

/** Always dark, whatever the app theme: terminal programs assume a dark background. */
const THEME = {
  background: '#0b0b0c',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  selectionBackground: '#3a3d41',
};

/**
 * A workspace's terminal, full screen, over `/api/workspaces/<target>/<name>/shell`. Tabs on top switch
 * between a plain shell (gone with the page) and the workspace's terminals (`?term=claude-1`: tmux
 * sessions that keep running without a browser), and open or close those.
 */
export function ShellPage() {
  const { target = '', name = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const term = params.get('term');
  const workspaceId = `${target}/${name}`;
  const toast = useToast();
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const [terminals, setTerminals] = useState<WorkspaceTerminal[]>([]);
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadTerminals = useCallback(
    () => api.workspaces.terminals(workspaceId).then(setTerminals, () => undefined),
    [workspaceId],
  );
  useEffect(() => void loadTerminals(), [loadTerminals, term]);

  const switchTo = (id: string | null) => setParams(id ? { term: id } : {}, { replace: true });

  const close = async () => {
    if (!closing) return;
    setBusy(true);
    try {
      await api.workspaces.closeTerminal(workspaceId, closing);
      toast(`${closing} closed`);
      if (term === closing) switchTo(null);
      setClosing(null);
      await loadTerminals();
    } catch (e) {
      toast(errorText(e, 'Couldn’t close it.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    document.title = `${name} · ${term ?? 'shell'}`;
    return () => void (document.title = BRAND_NAME);
  }, [name, term]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const terminal = term;
    setPhase({ kind: 'connecting' });

    const xterm = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(el);
    fit.fit();
    xterm.focus();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/workspaces/${target}/${name}/shell?cols=${xterm.cols}&rows=${xterm.rows}${terminal ? `&term=${terminal}` : ''}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const encoder = new TextEncoder();
    let ended = false;
    const control = (msg: ShellClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) return xterm.write(new Uint8Array(e.data));
      const msg = JSON.parse(String(e.data)) as ShellServerMessage;
      if (msg.type === 'ready') {
        setPhase({ kind: 'open' });
        control({ type: 'resize', cols: xterm.cols, rows: xterm.rows });
      } else if (msg.type === 'exit') {
        ended = true;
        setPhase({ kind: 'closed', reason: terminal ? 'Detached. The terminal keeps running.' : msg.code ? `Shell exited with code ${msg.code}.` : 'Shell exited.' });
      } else if (msg.type === 'error') {
        ended = true;
        setPhase({ kind: 'closed', reason: msg.message });
      }
    };
    ws.onclose = (e) => {
      if (ended) return;
      setPhase({
        kind: 'closed',
        reason: e.code === 1006 ? 'Could not connect. Is the workspace running, and are you signed in?' : 'Disconnected.',
      });
    };

    const input = xterm.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(encoder.encode(d)));
    const resized = xterm.onResize(({ cols, rows }) => control({ type: 'resize', cols, rows }));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);

    return () => {
      observer.disconnect();
      input.dispose();
      resized.dispose();
      ws.onclose = null;
      ws.close();
      xterm.dispose();
    };
  }, [target, name, attempt, term]);

  return (
    <div className="flex h-dvh flex-col bg-[#0b0b0c] text-[#e6e6e6]">
      <header className="sticky top-0 z-10 flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 bg-[#0b0b0c] items-center gap-3 border-b border-white/10 px-2 pt-[env(safe-area-inset-top)] sm:px-3">
        <Link
          to="/admin/workspaces"
          aria-label="Back to workspaces"
          className="flex size-9 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft className="size-[18px]" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm font-semibold">{name}</p>
          <p className="truncate text-[11px] text-white/50">{target}</p>
        </div>
        <span className="flex items-center gap-2 text-xs text-white/60">
          <span
            className={cn(
              'size-2 rounded-full',
              phase.kind === 'open' ? 'bg-emerald-400' : phase.kind === 'connecting' ? 'animate-pulse bg-amber-400' : 'bg-red-400',
            )}
          />
          <span className="hidden sm:inline">
            {phase.kind === 'open' ? 'Connected' : phase.kind === 'connecting' ? 'Connecting…' : 'Closed'}
          </span>
        </span>
      </header>

      <nav aria-label="Terminals" className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-white/10 px-2 py-1.5">
        <Tab active={!term} onClick={() => switchTo(null)} icon={<SquareTerminal className="size-3.5" />} label="shell" hint="Closes with this page" />
        {terminals.map((t) => (
          <Tab
            key={t.id}
            active={term === t.id}
            onClick={() => switchTo(t.id)}
            icon={t.kind === 'claude' ? <Bot className="size-3.5" /> : <SquareTerminal className="size-3.5" />}
            label={t.id}
            hint={`${t.command} in ${t.cwd}`}
            onClose={() => setClosing(t.id)}
          />
        ))}
        <button
          type="button"
          aria-label="New terminal"
          onClick={() => setCreating(true)}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
        >
          <Plus className="size-4" />
        </button>
      </nav>

      <div className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]" />
        {phase.kind === 'closed' && (
          <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-center gap-3 border-t border-white/10 bg-[#141416]/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-sm backdrop-blur">
            <span className="text-white/80">{phase.reason}</span>
            <Button size="sm" variant="secondary" icon={<RotateCw className="size-4" />} onClick={() => setAttempt((n) => n + 1)}>
              Reconnect
            </Button>
          </div>
        )}
      </div>

      <NewTerminalDialog
        workspaceId={workspaceId}
        open={creating}
        onClose={() => setCreating(false)}
        onOpened={(t) => {
          setCreating(false);
          void loadTerminals();
          switchTo(t.id);
        }}
      />
      <ConfirmDialog
        open={!!closing}
        title={`Close ${closing ?? ''}?`}
        description="What runs in it stops (Claude Code included)."
        confirmLabel="Close"
        loading={busy}
        onConfirm={() => void close()}
        onClose={() => !busy && setClosing(null)}
      />
    </div>
  );
}

/** One terminal in the strip; the active one shows × to close it. */
function Tab({
  active,
  onClick,
  icon,
  label,
  hint,
  onClose,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  hint: string;
  onClose?: () => void;
}) {
  return (
    <span
      className={cn(
        'flex h-8 shrink-0 items-center rounded-lg font-mono text-xs',
        active ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white',
      )}
    >
      <button type="button" title={hint} aria-current={active ? 'page' : undefined} onClick={onClick} className="flex h-full items-center gap-1.5 px-2.5">
        {icon}
        {label}
      </button>
      {active && onClose && (
        <button type="button" aria-label={`Close ${label}`} onClick={onClose} className="mr-1 flex size-6 items-center justify-center rounded-md hover:bg-white/15">
          <X className="size-3.5" />
        </button>
      )}
    </span>
  );
}
