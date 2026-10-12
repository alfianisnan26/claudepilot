import RFB from '@novnc/novnc/core/rfb.js';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { CLOSE, type ViewPhase } from './shared';

/** X keysyms for the keys a phone's key row sends. */
export const KEYSYM = {
  Enter: 0xff0d,
  Backspace: 0xff08,
  Tab: 0xff09,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Control: 0xffe3,
  Alt: 0xffe9,
} as const;

export interface VncHandle {
  /** Types text into the remote page, a character at a time (never logged, never stored). */
  sendText: (text: string, thenEnter?: boolean) => Promise<void>;
  /** One named key, with Ctrl and Alt held when asked. */
  sendKey: (key: keyof typeof KEYSYM, mods?: { ctrl?: boolean; alt?: boolean }) => void;
  /** A letter with Ctrl held (Ctrl+L, Ctrl+W). */
  sendCtrl: (letter: string) => void;
}

const symOf = (ch: string): number => {
  if (ch === '\n') return KEYSYM.Enter;
  if (ch === '\t') return KEYSYM.Tab;
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x100 ? cp : 0x01000000 + cp;
};

/**
 * The browser's screen over VNC (browser PRD §12.1, §15.2): noVNC fitted to the width, talking RFB to the portal's
 * bridge, which decides what this device may send. A viewer's keys and pointer never leave the bridge; the `viewOnly`
 * flag here only keeps this page from trying. When who holds control changes the bridge closes the socket with 4001
 * and this reconnects at once with its new role; while control is Private it closes with 4002 and the page shows a
 * cover instead of retrying.
 */
export const VncView = forwardRef<
  VncHandle,
  {
    workspaceId: string;
    device: string;
    /** This device holds control: its keys and pointer are forwarded. */
    controller: boolean;
    /** Nothing connects while paused (the page is hidden, or the browser is off). */
    paused: boolean;
    /** Bumping this reconnects (the cover came off, Retry was tapped). */
    attempt: number;
    onPhase: (phase: ViewPhase) => void;
    className?: string;
  }
>(function VncView({ workspaceId, device, controller, paused, attempt, onPhase, className }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;

  useImperativeHandle(ref, () => ({
    async sendText(text, thenEnter) {
      // A few milliseconds apart, so the display's keyboard keeps up with a pasted password.
      for (const ch of text) {
        const rfb = rfbRef.current;
        if (!rfb || !controllerRef.current) return;
        rfb.sendKey(symOf(ch), null);
        await new Promise((r) => setTimeout(r, 4));
      }
      if (thenEnter) rfbRef.current?.sendKey(KEYSYM.Enter, 'Enter');
    },
    sendKey(key, mods) {
      const rfb = rfbRef.current;
      if (!rfb || !controllerRef.current) return;
      if (mods?.ctrl) rfb.sendKey(KEYSYM.Control, 'ControlLeft', true);
      if (mods?.alt) rfb.sendKey(KEYSYM.Alt, 'AltLeft', true);
      rfb.sendKey(KEYSYM[key], null);
      if (mods?.alt) rfb.sendKey(KEYSYM.Alt, 'AltLeft', false);
      if (mods?.ctrl) rfb.sendKey(KEYSYM.Control, 'ControlLeft', false);
    },
    sendCtrl(letter) {
      const rfb = rfbRef.current;
      if (!rfb || !controllerRef.current || letter.length !== 1) return;
      rfb.sendKey(KEYSYM.Control, 'ControlLeft', true);
      rfb.sendKey(symOf(letter.toLowerCase()), null);
      rfb.sendKey(KEYSYM.Control, 'ControlLeft', false);
    },
  }));

  // The bridge reconnects as soon as who holds control changes, which can be before this page has read the new
  // status: the connection's flag follows the prop, so it never stays view-only after control arrived.
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = !controller;
  }, [controller]);

  useEffect(() => {
    const el = host.current;
    if (!el || paused) return;
    let disposed = false;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let rfb: RFB | null = null;

    const connect = () => {
      if (disposed) return;
      onPhaseRef.current({ kind: 'connecting' });
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const [target, name] = workspaceId.split('/');
      const ws = new WebSocket(`${proto}//${location.host}/api/workspaces/${target}/${name}/browser/view?device=${encodeURIComponent(device)}`);
      const current = ws;
      let opened = false;
      ws.addEventListener('open', () => (opened = true));
      ws.addEventListener('close', (e) => {
        if (disposed || ws !== current) return;
        rfb = null;
        rfbRef.current = null;
        if (e.code === CLOSE.roleChanged) return connect();
        if (e.code === CLOSE.private) return onPhaseRef.current({ kind: 'private' });
        if (e.code === CLOSE.refused) return onPhaseRef.current({ kind: 'closed', reason: e.reason || 'Too many are watching.' });
        if (e.code === 1008) return onPhaseRef.current({ kind: 'closed', reason: 'The display refused that.' });
        // The browser or the network went away: try again a few times, then say so.
        if (retries++ < 4) timer = setTimeout(connect, Math.min(8000, 800 * 2 ** retries));
        else onPhaseRef.current({ kind: 'closed', reason: opened && e.code === CLOSE.unavailable ? e.reason || 'The display closed.' : 'Disconnected.' });
      });
      const view = new RFB(el, ws, { shared: true });
      view.viewOnly = !controllerRef.current;
      view.scaleViewport = true;
      view.clipViewport = false;
      view.resizeSession = false;
      view.focusOnClick = true;
      view.showDotCursor = false;
      view.background = '#0b0b0c';
      view.qualityLevel = 6;
      view.compressionLevel = 2;
      view.addEventListener('connect', () => {
        retries = 0;
        onPhaseRef.current({ kind: 'open' });
      });
      rfb = view;
      rfbRef.current = view;
    };

    // A page hidden for a minute lets go of the display (each viewer costs it CPU); it comes back when shown.
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenTimer = setTimeout(() => {
          if (disposed) return;
          rfb?.disconnect();
          rfb = null;
          rfbRef.current = null;
          onPhaseRef.current({ kind: 'closed', reason: 'Paused while hidden.' });
        }, 60_000);
      } else {
        clearTimeout(hiddenTimer);
        if (!rfbRef.current && !disposed) {
          retries = 0;
          connect();
        }
      }
    };
    document.addEventListener('visibilitychange', visibility);
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(hiddenTimer);
      document.removeEventListener('visibilitychange', visibility);
      rfb?.disconnect();
      rfbRef.current = null;
    };
  }, [workspaceId, device, paused, attempt]);

  return <div ref={host} className={className} />;
});
