import { cn, Menu, Spinner } from '@isnanme/ui';
import type { BrowserTab, PreviewClientMessage, PreviewFrameHeader, PreviewServerEvent } from '@portal/contracts';
import { ArrowLeft, ArrowRight, Check, Maximize2, Plus, RotateCw, X } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { CLOSE, type ViewPhase } from './shared';

/** What the page's own controls (the text bar, the key row) can do to the remote page. */
export interface PreviewHandle {
  /** Types text into the remote page (never logged, never stored). */
  sendText: (text: string, thenEnter?: boolean) => Promise<void>;
  /** One named key, with Ctrl and Alt held when asked. */
  sendKey: (key: string, mods?: { ctrl?: boolean; alt?: boolean }) => void;
  /** A letter with Ctrl held (Ctrl+A). */
  sendCtrl: (letter: string) => void;
}

/** DOM key values, codes and Windows virtual key codes for the keys a phone's key row has. */
const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  Up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  Right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
};
/** CDP's modifier bits. */
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;
const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? ALT : 0) | (e.ctrlKey ? CTRL : 0) | (e.metaKey ? META : 0) | (e.shiftKey ? SHIFT : 0);
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Dead', 'Process', 'Unidentified', 'AltGraph', 'OS']);

const SLOP = 10; // px a finger may move and still be a tap
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 320;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

interface Props {
  workspaceId: string;
  device: string;
  /** This device holds control: its pointer and keys are forwarded. */
  controller: boolean;
  /** Nothing connects while paused (the page is hidden, or control is private). */
  paused: boolean;
  /** Bumping this reconnects (the cover came off, Retry was tapped). */
  attempt: number;
  onPhase: (phase: ViewPhase) => void;
  className?: string;
}

/**
 * The proxy browser (browser PRD §22): the page the browser shows, drawn by the portal from JPEG frames on an
 * authenticated socket, with an address bar and tabs of its own. No VNC: what a person does here reaches the
 * browser as the narrow messages of `PreviewClientMessage`, and only while this device holds control. A viewer sees
 * the same page, read-only. Frames are drawn and dropped; nothing is stored.
 */
export const PreviewView = forwardRef<PreviewHandle, Props>(function PreviewView({ workspaceId, device, controller, paused, attempt, onPhase, className }, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const frame = useRef<PreviewFrameHeader>({ dw: 1280, dh: 800, tab: '', emu: false });
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;

  const [role, setRole] = useState<'viewer' | 'controller'>('viewer');
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<{ kind: string; message: string; prompt: string } | null>(null);
  const [answer, setAnswer] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [fit, setFit] = useState(coarse);
  const [live, setLive] = useState(false);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // The address shown is the front tab's, read from the list so a tab change and its address always arrive together.
  const url = tabs.find((t) => t.id === current)?.url ?? '';

  /** Only the holder of control may send anything beyond a lighter stream (the portal drops the rest anyway). */
  const send = useCallback((m: PreviewClientMessage) => {
    const s = socket.current;
    if (!s || s.readyState !== WebSocket.OPEN) return;
    if (m.t !== 'quality' && m.t !== 'ping' && !controllerRef.current) return;
    s.send(JSON.stringify(m));
  }, []);

  useImperativeHandle(ref, () => ({
    async sendText(text, thenEnter) {
      // In pieces the portal accepts, with a breath between them.
      for (let i = 0; i < text.length; i += 1000) {
        send({ t: 'text', text: text.slice(i, i + 1000) });
        if (i + 1000 < text.length) await sleep(20);
      }
      if (thenEnter) {
        const k = KEYS.Enter!;
        send({ t: 'key', a: 'down', key: k.key, code: k.code, vk: k.vk, text: k.text });
        send({ t: 'key', a: 'up', key: k.key, code: k.code, vk: k.vk });
      }
    },
    sendKey(name, held) {
      const k = KEYS[name];
      if (!k) return;
      const m = (held?.ctrl ? CTRL : 0) | (held?.alt ? ALT : 0);
      send({ t: 'key', a: 'down', key: k.key, code: k.code, vk: k.vk, m, ...(k.text && !m ? { text: k.text } : {}) });
      send({ t: 'key', a: 'up', key: k.key, code: k.code, vk: k.vk, m });
    },
    sendCtrl(letter) {
      if (letter.length !== 1) return;
      const key = letter.toLowerCase();
      const vk = key.toUpperCase().charCodeAt(0);
      send({ t: 'key', a: 'down', key, code: `Key${key.toUpperCase()}`, vk, m: CTRL });
      send({ t: 'key', a: 'up', key, code: `Key${key.toUpperCase()}`, vk, m: CTRL });
    },
  }));

  /* ---------- Frames ---------- */

  const decoding = useRef(false);
  const waiting = useRef<ArrayBuffer | null>(null);
  const draw = useCallback(async (buf: ArrayBuffer) => {
    if (decoding.current) {
      waiting.current = buf; // the newest frame wins
      return;
    }
    decoding.current = true;
    try {
      const headLen = new DataView(buf).getUint16(0);
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 2, headLen))) as PreviewFrameHeader;
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(buf, 2 + headLen)], { type: 'image/jpeg' }));
      const c = canvas.current;
      if (c) {
        if (c.width !== bitmap.width || c.height !== bitmap.height) {
          c.width = bitmap.width;
          c.height = bitmap.height;
        }
        c.getContext('2d')?.drawImage(bitmap, 0, 0);
        frame.current = header;
        setLive(true);
      }
      bitmap.close();
    } catch {
      // a frame that doesn't decode is skipped
    } finally {
      decoding.current = false;
      const next = waiting.current;
      waiting.current = null;
      if (next) void draw(next);
    }
  }, []);

  /* ---------- The socket ---------- */

  const flash = useCallback((text: string) => {
    setNote(text);
    window.setTimeout(() => setNote((n) => (n === text ? null : n)), 3500);
  }, []);

  /** The page's size for the remote page, when this device is fitting it to its screen. */
  const fitViewport = useCallback(() => {
    const el = wrap.current;
    if (!el || !controllerRef.current) return;
    if (!fitRef.current) return send({ t: 'viewport', reset: true });
    const w = Math.round(el.clientWidth);
    const h = Math.round(el.clientHeight);
    if (w < 100 || h < 100) return;
    send({ t: 'viewport', w, h, dpr: Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1))), mobile: coarse() });
  }, [send]);

  const lighter = useCallback(() => {
    const w = wrap.current?.clientWidth ?? 1280;
    send({ t: 'quality', q: 60, fps: 12, maxW: Math.min(1600, Math.max(320, Math.round(w * Math.min(2, window.devicePixelRatio || 1)))) });
  }, [send]);

  useEffect(() => {
    if (paused) return;
    let disposed = false;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let sock: WebSocket | null = null;

    const onEvent = (e: PreviewServerEvent) => {
      switch (e.e) {
        case 'ready':
          retries = 0;
          setRole(e.role);
          onPhaseRef.current({ kind: 'open' });
          lighter();
          if (e.role === 'controller') fitViewport();
          break;
        case 'tabs':
          setTabs(e.tabs);
          setCurrent(e.current);
          break;
        case 'url':
          setTabs((list) => list.map((t) => (t.id === e.id ? { ...t, url: e.url, title: e.title } : t)));
          break;
        case 'loading':
          setLoading(e.on);
          break;
        case 'dialog':
          setDialog({ kind: e.kind, message: e.message, prompt: e.prompt });
          setAnswer(e.prompt);
          break;
        case 'dialog-closed':
          setDialog(null);
          break;
        case 'error':
          if (!e.fatal) flash(e.message);
          break;
        default:
          break;
      }
    };

    const connect = () => {
      if (disposed) return;
      onPhaseRef.current({ kind: 'connecting' });
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const [target, name] = workspaceId.split('/');
      const ws = new WebSocket(`${proto}//${location.host}/api/workspaces/${target}/${name}/browser/preview?device=${encodeURIComponent(device)}`);
      ws.binaryType = 'arraybuffer';
      sock = ws;
      socket.current = ws;
      let opened = false;
      ws.addEventListener('open', () => (opened = true));
      ws.addEventListener('message', (m: MessageEvent) => {
        if (ws !== sock) return;
        if (typeof m.data === 'string') {
          try {
            onEvent(JSON.parse(m.data) as PreviewServerEvent);
          } catch {
            // not an event
          }
        } else void draw(m.data as ArrayBuffer);
      });
      ws.addEventListener('close', (e) => {
        if (disposed || ws !== sock) return;
        sock = null;
        socket.current = null;
        setLive(false);
        setDialog(null);
        if (e.code === CLOSE.roleChanged) return connect();
        if (e.code === CLOSE.private) return onPhaseRef.current({ kind: 'private' });
        if (e.code === CLOSE.refused) return onPhaseRef.current({ kind: 'closed', reason: e.reason || 'The preview is unavailable.' });
        if (e.code === 1008) return onPhaseRef.current({ kind: 'closed', reason: 'The preview refused that.' });
        if (retries++ < 4) timer = setTimeout(connect, Math.min(8000, 800 * 2 ** retries));
        else onPhaseRef.current({ kind: 'closed', reason: opened && e.code === CLOSE.unavailable ? e.reason || 'The preview closed.' : 'Disconnected.' });
      });
    };

    // A page hidden for a minute lets go of the browser (each viewer costs it CPU); it comes back when shown.
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenTimer = setTimeout(() => {
          if (disposed) return;
          const s = sock;
          sock = null;
          socket.current = null;
          s?.close();
          onPhaseRef.current({ kind: 'closed', reason: 'Paused while hidden.' });
        }, 60_000);
      } else {
        clearTimeout(hiddenTimer);
        if (!sock && !disposed) {
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
      const s = sock;
      sock = null;
      socket.current = null;
      s?.close();
      setLive(false);
    };
  }, [workspaceId, device, paused, attempt, draw, flash, fitViewport, lighter]);

  // Fit the remote page to this screen while this device is in control; leave it alone otherwise.
  useEffect(() => {
    const el = wrap.current;
    if (!el || !controller || role !== 'controller') return;
    fitViewport();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(fitViewport, 300);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [controller, role, fit, fitViewport]);

  /* ---------- Input ---------- */

  /** Where a screen position falls on the page, as fractions of the frame, and how many page pixels a screen pixel is. */
  const point = (clientX: number, clientY: number) => {
    const c = canvas.current;
    if (!c || !c.width) return null;
    const r = c.getBoundingClientRect();
    const ratio = c.width / c.height;
    let w = r.width;
    let h = r.width / ratio;
    if (h > r.height) {
      h = r.height;
      w = h * ratio;
    }
    const x = (clientX - (r.left + (r.width - w) / 2)) / w;
    const y = (clientY - (r.top + (r.height - h) / 2)) / h;
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y, scale: frame.current.dw / w };
  };

  const gesture = useRef<{ id: number; sx: number; sy: number; lx: number; ly: number; moved: boolean; long: boolean; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const lastTap = useRef({ at: 0, x: 0, y: 0 });
  const hover = useRef<{ x: number; y: number; m: number } | null>(null);
  const hoverFrame = useRef(0);

  const click = (p: { x: number; y: number }, button: 0 | 2, count: number, m: number) => {
    send({ t: 'mouse', a: 'move', x: p.x, y: p.y, m });
    send({ t: 'mouse', a: 'down', x: p.x, y: p.y, b: button, cc: count, m });
    send({ t: 'mouse', a: 'up', x: p.x, y: p.y, b: button, cc: count, m });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!controller) return;
    wrap.current?.focus({ preventScroll: true });
    const p = point(e.clientX, e.clientY);
    if (!p) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (e.pointerType === 'mouse') {
      send({ t: 'mouse', a: 'move', x: p.x, y: p.y, m: mods(e) });
      send({ t: 'mouse', a: 'down', x: p.x, y: p.y, b: e.button === 2 ? 2 : e.button === 1 ? 1 : 0, cc: Math.min(3, Math.max(1, e.detail || 1)), m: mods(e) });
      return;
    }
    const g = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, long: false } as NonNullable<typeof gesture.current>;
    g.timer = setTimeout(() => {
      if (g.moved || gesture.current !== g) return;
      g.long = true; // a long press is a right click
      click(p, 2, 1, 0);
    }, LONG_PRESS_MS);
    gesture.current = g;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!controller) return;
    if (e.pointerType === 'mouse') {
      const p = point(e.clientX, e.clientY);
      if (!p) return;
      hover.current = { x: p.x, y: p.y, m: mods(e) };
      if (!hoverFrame.current)
        hoverFrame.current = requestAnimationFrame(() => {
          hoverFrame.current = 0;
          const h = hover.current;
          if (h) send({ t: 'mouse', a: 'move', x: h.x, y: h.y, m: h.m });
        });
      return;
    }
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > SLOP) {
      g.moved = true;
      clearTimeout(g.timer);
    }
    if (!g.moved) return;
    // A finger drags the page: the page moves with it.
    const p = point(e.clientX, e.clientY) ?? point(g.sx, g.sy);
    if (p) send({ t: 'mouse', a: 'wheel', x: p.x, y: p.y, dx: (g.lx - e.clientX) * p.scale, dy: (g.ly - e.clientY) * p.scale });
    g.lx = e.clientX;
    g.ly = e.clientY;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!controller) return;
    const p = point(e.clientX, e.clientY);
    if (e.pointerType === 'mouse') {
      if (p) send({ t: 'mouse', a: 'up', x: p.x, y: p.y, b: e.button === 2 ? 2 : e.button === 1 ? 1 : 0, cc: Math.min(3, Math.max(1, e.detail || 1)), m: mods(e) });
      return;
    }
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    clearTimeout(g.timer);
    gesture.current = null;
    if (g.moved || g.long || !p) return;
    // A tap is a click; a second tap close to the first is a double click.
    const now = Date.now();
    const again = now - lastTap.current.at < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.current.x, e.clientY - lastTap.current.y) < 30;
    lastTap.current = again ? { at: 0, x: 0, y: 0 } : { at: now, x: e.clientX, y: e.clientY };
    click(p, 0, again ? 2 : 1, 0);
  };

  const onPointerCancel = () => {
    clearTimeout(gesture.current?.timer);
    gesture.current = null;
  };

  // The wheel needs a listener that may cancel it (React's are passive).
  useEffect(() => {
    const el = wrap.current;
    if (!el || !controller) return;
    const wheel = (e: WheelEvent) => {
      const p = point(e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 600 : 1;
      send({ t: 'mouse', a: 'wheel', x: p.x, y: p.y, dx: e.deltaX * unit * p.scale, dy: e.deltaY * unit * p.scale, m: mods(e) });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
    // `point` reads refs only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, send]);

  const onKey = (e: React.KeyboardEvent, down: boolean) => {
    if (!controller || e.nativeEvent.isComposing || MODIFIER_KEYS.has(e.key)) return;
    const m = mods(e);
    // Ctrl+V is the browser's own paste, which arrives as a paste event with the text.
    if (down && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
    e.preventDefault();
    const named = Object.values(KEYS).find((k) => k.key === e.key);
    const text = e.key === 'Enter' ? '\r' : e.key.length === 1 ? e.key : undefined;
    send({ t: 'key', a: down ? 'down' : 'up', key: e.key.slice(0, 32), code: e.code.slice(0, 32), vk: named?.vk ?? e.keyCode, m, ...(down && text && !(m & (CTRL | META)) ? { text } : {}) });
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (!controller) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) void (async () => { for (let i = 0; i < text.length; i += 1000) { send({ t: 'text', text: text.slice(i, i + 1000) }); await sleep(20); } })();
  };

  /* ---------- Chrome ---------- */

  const toolbar = 'flex h-10 shrink-0 items-center gap-1 border-b border-white/10 bg-[#141416] px-1.5';
  const button = 'flex size-8 shrink-0 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent';
  const go = (v: string) => {
    const t = v.trim();
    if (t) send({ t: 'go', url: t });
  };
  const tabLabel = (t: BrowserTab) => t.title || t.url.replace(/^https?:\/\//, '') || 'New tab';
  const isControl = controller && role === 'controller';

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className={toolbar}>
        {isControl && (
          <>
            <button type="button" aria-label="Back" title="Back" className={button} onClick={() => send({ t: 'back' })}>
              <ArrowLeft className="size-4" />
            </button>
            <button type="button" aria-label="Forward" title="Forward" className={cn(button, 'hidden min-[480px]:flex')} onClick={() => send({ t: 'forward' })}>
              <ArrowRight className="size-4" />
            </button>
            <button type="button" aria-label={loading ? 'Stop' : 'Reload'} title={loading ? 'Stop' : 'Reload'} className={button} onClick={() => send({ t: loading ? 'stop' : 'reload' })}>
              {loading ? <X className="size-4" /> : <RotateCw className="size-4" />}
            </button>
          </>
        )}
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (isControl && draft !== null) go(draft);
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          <input
            aria-label="Address"
            value={draft ?? url}
            onChange={(e) => isControl && setDraft(e.target.value)}
            readOnly={!isControl}
            inputMode="url"
            enterKeyHint="go"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            placeholder={live ? 'Search or enter address' : ''}
            onFocus={(e) => {
              if (!isControl) return;
              setDraft(url);
              requestAnimationFrame(() => e.target.select());
            }}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => e.key === 'Escape' && (e.currentTarget.blur(), setDraft(null))}
            className="h-8 w-full min-w-0 truncate rounded-lg border border-white/10 bg-white/5 px-3 text-[13px] text-white outline-hidden placeholder:text-white/30 read-only:text-white/60 focus:border-white/40"
          />
        </form>
        <span className="[&>div>button]:size-8 [&>div>button]:rounded-lg [&>div>button]:text-white/70 [&>div>button:hover]:bg-white/10 [&>div>button:hover]:text-white [&>div>button[aria-expanded=true]]:bg-white/10">
          <Menu
            label="Tabs"
            trigger={<span className="rounded-md border border-white/40 px-1.5 text-[11px] font-semibold leading-4">{tabs.length || 1}</span>}
            items={[
              ...tabs.map((t) => ({
                label: tabLabel(t).slice(0, 60),
                icon: t.id === current ? <Check className="size-4" /> : <span className="size-4" />,
                // A viewer follows the browser's front tab, so the choice is the holder's.
                disabled: !isControl,
                onSelect: () => send({ t: 'tab', id: t.id }),
              })),
              ...(isControl
                ? [
                    { label: 'New tab', icon: <Plus className="size-4" />, onSelect: () => send({ t: 'newTab' }) },
                    ...(tabs.length > 1 && current ? [{ label: 'Close tab', icon: <X className="size-4" />, onSelect: () => send({ t: 'closeTab', id: current }) }] : []),
                    { label: fit ? 'Original size' : 'Fit to screen', icon: <Maximize2 className="size-4" />, onSelect: () => setFit((f) => !f) },
                  ]
                : []),
            ]}
          />
        </span>
      </div>
      <div className="relative h-0.5 shrink-0 overflow-hidden bg-transparent">{loading && <div className="h-full w-1/3 animate-pulse bg-emerald-400/80" />}</div>

      <div
        ref={wrap}
        tabIndex={controller ? 0 : -1}
        onKeyDown={(e) => onKey(e, true)}
        onKeyUp={(e) => onKey(e, false)}
        onPaste={onPaste}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(e) => controller && e.preventDefault()}
        className={cn('relative min-h-0 flex-1 overflow-hidden bg-[#0b0b0c] outline-hidden select-none', controller && 'touch-none')}
      >
        <canvas ref={canvas} aria-label="The browser’s page" className="absolute inset-0 size-full object-contain" />
        {!live && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner className="size-5" />
          </div>
        )}
        {note && <p className="absolute inset-x-3 top-2 z-[2] rounded-lg bg-black/80 px-3 py-1.5 text-center text-xs text-white">{note}</p>}
        {dialog && (
          <div className="absolute inset-x-3 top-3 z-[2] mx-auto max-w-sm rounded-xl border border-white/15 bg-[#1b1b1e] p-3 text-sm shadow-xl">
            <p className="line-clamp-4 break-words">{dialog.message || '…'}</p>
            {isControl && dialog.kind === 'prompt' && (
              <input
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                aria-label="Answer"
                autoComplete="off"
                className="mt-2 h-9 w-full rounded-lg border border-white/15 bg-white/5 px-3 text-sm text-white outline-hidden focus:border-white/40"
              />
            )}
            {isControl ? (
              <div className="mt-3 flex justify-end gap-2">
                {dialog.kind !== 'alert' && (
                  <button type="button" onClick={() => send({ t: 'dialog', accept: false })} className="h-9 rounded-lg px-3 text-white/70 hover:bg-white/10">
                    Cancel
                  </button>
                )}
                <button type="button" onClick={() => send({ t: 'dialog', accept: true, ...(dialog.kind === 'prompt' ? { text: answer } : {}) })} className="h-9 rounded-lg bg-white px-4 font-medium text-black">
                  OK
                </button>
              </div>
            ) : (
              <p className="mt-2 text-xs text-white/50">Waiting for an answer.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
