import { Button, cn } from '@isnanme/ui';
import type { ShellClientMessage, ShellServerMessage } from '@portal/contracts';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { ArrowLeft, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';

type Phase = { kind: 'connecting' } | { kind: 'open' } | { kind: 'closed'; reason: string };

/** Always dark, whatever the app theme: terminal programs assume a dark background. */
const THEME = {
  background: '#0b0b0c',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  selectionBackground: '#3a3d41',
};

/** A login shell in a workspace, full screen, over `/api/workspaces/<target>/<name>/shell`. */
export function ShellPage() {
  const { target = '', name = '' } = useParams();
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    document.title = `${name} · shell`;
    return () => void (document.title = 'portal');
  }, [name]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setPhase({ kind: 'connecting' });

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    term.focus();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/workspaces/${target}/${name}/shell?cols=${term.cols}&rows=${term.rows}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const encoder = new TextEncoder();
    let ended = false;
    const control = (msg: ShellClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) return term.write(new Uint8Array(e.data));
      const msg = JSON.parse(String(e.data)) as ShellServerMessage;
      if (msg.type === 'ready') {
        setPhase({ kind: 'open' });
        control({ type: 'resize', cols: term.cols, rows: term.rows });
      } else if (msg.type === 'exit') {
        ended = true;
        setPhase({ kind: 'closed', reason: msg.code ? `Shell exited with code ${msg.code}.` : 'Shell exited.' });
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

    const input = term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(encoder.encode(d)));
    const resized = term.onResize(({ cols, rows }) => control({ type: 'resize', cols, rows }));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);

    return () => {
      observer.disconnect();
      input.dispose();
      resized.dispose();
      ws.onclose = null;
      ws.close();
      term.dispose();
    };
  }, [target, name, attempt]);

  return (
    <div className="flex h-dvh flex-col bg-[#0b0b0c] text-[#e6e6e6]">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-white/10 px-2 pt-[env(safe-area-inset-top)] sm:px-3">
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
    </div>
  );
}
