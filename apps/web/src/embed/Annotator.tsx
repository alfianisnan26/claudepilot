import { REPORTER_LIMITS, type ReporterAnnotation, type ReporterAnnotationColor } from '@portal/contracts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import {
  COLORS,
  DEFAULT_COLOR,
  TOOLS,
  addMark,
  bounds,
  canAnnotate,
  canRedo,
  canUndo,
  clearAll,
  clientToImage,
  downWhileTyping,
  drawnScale,
  drawMark,
  emptyDoc,
  fontOf,
  fromWire,
  handles,
  hasBlur,
  haloOf,
  hitTest,
  isMeaningful,
  moveMark,
  nextStep,
  normRect,
  redo,
  removeMark,
  renderFlat,
  replaceMark,
  resizeMark,
  simplify,
  toWire,
  toolForKey,
  undo,
  unitOf,
  widthFor,
  type Doc,
  type FlatCanvas,
  type Mark,
  type SizeClass,
  type Tool,
} from './annotate';
import { usePanel } from './context';
import { clampView, fitView, zoomAt, type Size, type View } from './formModel';
import { Icon, type IconName } from './icons';

/**
 * The annotation editor (PILOT-1111, owner 2026-10-31): full screen over the panel, the screenshot with a canvas of marks in its own pixel
 * coordinates. One finger draws with the tool; two fingers pinch and pan (and drop a mark in progress, so a pinch never draws). Phone: the
 * tools pinned at the bottom in the safe area (two rows of five, every tool on screen); desktop: one top bar. Done flattens the marks (blurs
 * pixelate the real pixels) into a PNG of the screenshot's size. A pointer maps to the image through the canvas's bounding rect read at
 * that event (clientToImage), so a layout shift, a zoom or a pan between events can never move a mark (or a blur) off the finger.
 */
const DARK = { background: '#0b0d12', color: '#fff' } as const;
const DIM = { color: 'rgba(255, 255, 255, 0.72)' } as const;
const ACCENT = '#1e88ff';
const TOOL_ICON: Record<Tool, IconName> = {
  select: 'pointer',
  pen: 'pencil',
  line: 'line',
  arrow: 'arrowUpRight',
  rect: 'square',
  ellipse: 'circle',
  text: 'type',
  highlight: 'highlighter',
  blur: 'grid',
  step: 'listOrdered',
};
const COLOR_NAME: Record<ReporterAnnotationColor, string> = { '#ef233c': 'Red', '#ffd60a': 'Yellow', '#2dc653': 'Green', '#1e88ff': 'Blue', '#ffffff': 'White' };
const SIZES: { v: SizeClass; label: string }[] = [
  { v: 's', label: 'Small' },
  { v: 'm', label: 'Medium' },
  { v: 'l', label: 'Large' },
];

type Op =
  | { kind: 'draw'; mark: Mark }
  | { kind: 'box'; start: { x: number; y: number }; mark: Mark }
  | { kind: 'move'; from: Mark; start: { x: number; y: number }; moved: boolean; wasSelected: boolean }
  | { kind: 'resize'; from: Mark; handle: number }
  | { kind: 'pan'; start: { x: number; y: number }; view: View }
  | { kind: 'tap'; at: { x: number; y: number }; screen: { x: number; y: number } };

type Editing = { id: string | null; x: number; y: number; value: string; color: ReporterAnnotationColor; width: number };

let seq = 0;
const markId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

export function Annotator({ src, initial, onCancel, onDone }: { src: string; initial?: ReporterAnnotation[]; onCancel: () => void; onDone: (marks: ReporterAnnotation[], image: Blob | null) => void }) {
  const { post } = usePanel();
  const frame = useRef<HTMLDivElement>(null);
  const baseCanvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const size: Size = useMemo(() => (img ? { w: img.naturalWidth, h: img.naturalHeight } : { w: 0, h: 0 }), [img]);
  const unit = unitOf(size);
  const [area, setArea] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [doc, setDoc] = useState<Doc>(() => emptyDoc(fromWire(initial, markId)));
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<ReporterAnnotationColor>(DEFAULT_COLOR);
  const [sizeClass, setSizeClass] = useState<SizeClass>('m');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live refs for the pointer and key handlers (no re-render per pointer move: the overlay is redrawn in a frame callback).
  const st = useRef({ doc, view, tool, color, sizeClass, selected, editing, unit, size, area });
  st.current = { doc, view, tool, color, sizeClass, selected, editing, unit, size, area };
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const op = useRef<Op | null>(null);
  const draft = useRef<Mark | null>(null);
  const pinch = useRef<{ dist: number; mid: { x: number; y: number }; view: View } | null>(null);
  /** After a pinch, the fingers left on the glass do nothing until all are lifted. */
  const quiet = useRef(false);
  const space = useRef(false);
  const frameReq = useRef(0);

  useEffect(() => {
    post({ type: 'pilot-reporter:expand', expanded: true });
    return () => post({ type: 'pilot-reporter:expand', expanded: false });
  }, [post]);

  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => setFailed(true);
    i.src = src;
  }, [src]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setArea({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  useEffect(() => {
    if (size.w && area.w) setView(fitView(size, area));
  }, [size, area]);

  const measure = useCallback((s: string, px: number) => {
    const ctx = overlay.current?.getContext('2d');
    if (!ctx) return s.length * px * 0.6;
    ctx.font = fontOf(px);
    return ctx.measureText(s).width;
  }, []);

  // The base layer: the screenshot with the blurs applied to its pixels (what Done exports), redrawn only when the blurs change.
  const blurKey = JSON.stringify(doc.marks.filter((m) => m.type === 'blur').map((m) => ('rect' in m ? m.rect : null)));
  useLayoutEffect(() => {
    const c = baseCanvas.current;
    if (!c || !img) return;
    renderFlat(c as unknown as FlatCanvas, img, size, doc.marks.filter((m) => m.type === 'blur'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, size, blurKey]);

  const draw = useCallback(() => {
    cancelAnimationFrame(frameReq.current);
    frameReq.current = requestAnimationFrame(() => {
      const c = overlay.current;
      const s = st.current;
      if (!c || !s.size.w) return;
      if (c.width !== s.size.w || c.height !== s.size.h) {
        c.width = s.size.w;
        c.height = s.size.h;
      }
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      const px = 1 / s.view.scale;
      const live = draft.current;
      for (const m of s.doc.marks) {
        if (live && m.id === live.id) continue;
        if (s.editing && m.id === s.editing.id) continue;
        drawMark(ctx, m, { blurOutline: 1.5 * px });
      }
      if (live) {
        drawMark(ctx, live, { blurOutline: 1.5 * px });
        if (live.type === 'blur' && 'rect' in live) {
          ctx.save();
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.fillRect(live.rect.x, live.rect.y, live.rect.w, live.rect.h);
          ctx.restore();
        }
      }
      const sel = live && op.current && (op.current.kind === 'move' || op.current.kind === 'resize') ? live : s.doc.marks.find((m) => m.id === s.selected);
      if (sel && !s.editing) {
        const b = bounds(sel, measure);
        const pad = 6 * px;
        ctx.save();
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5 * px;
        ctx.setLineDash([5 * px, 4 * px]);
        ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
        ctx.setLineDash([]);
        for (const h of handles(sel)) {
          ctx.beginPath();
          ctx.arc(h.x, h.y, 8 * px, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.lineWidth = 2 * px;
          ctx.stroke();
        }
        ctx.restore();
      }
    });
  }, [measure]);
  useEffect(draw, [draw, doc, selected, editing, view.scale, size]);

  /** The pointer in image pixels and the drawn scale, from the canvas as it is on screen at this event (never a cached rect or view). */
  const imageAt = (e: { clientX: number; clientY: number }) => {
    const c = overlay.current;
    const size = st.current.size;
    if (!c) return { at: { x: 0, y: 0 }, k: st.current.view.scale };
    const box = c.getBoundingClientRect();
    return { at: clientToImage({ x: e.clientX, y: e.clientY }, box, size), k: drawnScale(box, size) };
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = frame.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const cancelOp = useCallback(() => {
    op.current = null;
    draft.current = null;
    draw();
  }, [draw]);

  const commitText = useCallback(() => {
    const e = st.current.editing;
    if (!e) return;
    // The textarea's blur and a tap on the stage can both finish it in one frame: only the first counts.
    st.current.editing = null;
    const text = e.value.replace(/\s+$/, '').slice(0, REPORTER_LIMITS.annotationTextChars);
    setDoc((d) => {
      if (e.id) {
        const was = d.marks.find((m) => m.id === e.id);
        if (!was) return d;
        if (!text.trim()) return removeMark(d, e.id);
        return was.type === 'text' && was.text === text ? d : replaceMark(d, { ...(was as Extract<Mark, { type: 'text' }>), text });
      }
      if (!text.trim()) return d;
      return addMark(d, { id: markId(), type: 'text', points: [e.x, e.y], color: e.color, width: e.width, text });
    });
    setEditing(null);
  }, []);

  const startText = (at: { x: number; y: number }) => {
    const s = st.current;
    const hit = hitTest(s.doc.marks, at, 10 / s.view.scale, measure);
    if (hit?.type === 'text') {
      setSelected(hit.id);
      setEditing({ id: hit.id, x: hit.points[0]!, y: hit.points[1]!, value: hit.text, color: hit.color, width: hit.width });
      return;
    }
    setEditing({ id: null, x: at.x, y: at.y, value: '', color: s.color, width: widthFor('text', s.sizeClass, s.unit) });
  };

  /* ---------- Pointer ---------- */

  const onDown = (e: RPointerEvent) => {
    if (busy || !img) return;
    if (st.current.editing) {
      // A tap outside the text being written finishes it; with the Text tool that is all, with another tool it also starts that mark.
      commitText();
      if (downWhileTyping(st.current.tool) === 'finish') return;
    }
    frame.current?.setPointerCapture?.(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      // Two fingers: zoom and pan; whatever the first finger began is dropped.
      cancelOp();
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: st.current.view };
      quiet.current = true;
      return;
    }
    if (pointers.current.size > 2 || quiet.current) return;
    const s = st.current;
    const { at, k } = imageAt(e);
    if (e.button === 1 || space.current) {
      op.current = { kind: 'pan', start: p, view: s.view };
      return;
    }
    const slop = (e.pointerType === 'touch' ? 16 : 8) / k;
    const w = widthFor(s.tool, s.sizeClass, s.unit);
    switch (s.tool) {
      case 'select': {
        const sel = s.doc.marks.find((m) => m.id === s.selected);
        if (sel) {
          const reach = 22 / k;
          const h = handles(sel).findIndex((q) => Math.hypot(q.x - at.x, q.y - at.y) <= reach);
          if (h >= 0) {
            op.current = { kind: 'resize', from: sel, handle: h };
            return;
          }
        }
        const hit = hitTest(s.doc.marks, at, slop, measure);
        if (hit) {
          op.current = { kind: 'move', from: hit, start: at, moved: false, wasSelected: hit.id === s.selected };
          setSelected(hit.id);
        } else {
          setSelected(null);
          op.current = { kind: 'pan', start: p, view: s.view };
        }
        return;
      }
      case 'text':
      case 'step':
        op.current = { kind: 'tap', at, screen: p };
        return;
      case 'pen':
      case 'highlight':
        draft.current = { id: markId(), type: s.tool, points: [at.x, at.y], color: s.color, width: w };
        op.current = { kind: 'draw', mark: draft.current };
        break;
      case 'line':
      case 'arrow':
        draft.current = { id: markId(), type: s.tool, points: [at.x, at.y, at.x, at.y], color: s.color, width: w };
        op.current = { kind: 'draw', mark: draft.current };
        break;
      case 'rect':
      case 'ellipse':
        draft.current = { id: markId(), type: s.tool, rect: { x: at.x, y: at.y, w: 0, h: 0 }, color: s.color, width: w };
        op.current = { kind: 'box', start: at, mark: draft.current };
        break;
      case 'blur':
        draft.current = { id: markId(), type: 'blur', rect: { x: at.x, y: at.y, w: 0, h: 0 } };
        op.current = { kind: 'box', start: at, mark: draft.current };
        break;
    }
    setSelected(null);
    draw();
  };

  const onMove = (e: RPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const s = st.current;
    const g = pinch.current;
    if (g && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = zoomAt(g.view, Math.hypot(a.x - b.x, a.y - b.y) / g.dist, g.mid, s.size, s.area);
      setView(clampView({ ...z, x: z.x + mid.x - g.mid.x, y: z.y + mid.y - g.mid.y }, s.size, s.area));
      return;
    }
    const o = op.current;
    if (!o || quiet.current) return;
    const { at, k } = imageAt(e);
    switch (o.kind) {
      case 'pan':
        setView(clampView({ ...o.view, x: o.view.x + p.x - o.start.x, y: o.view.y + p.y - o.start.y }, s.size, s.area));
        return;
      case 'draw': {
        const m = o.mark as Extract<Mark, { points: number[] }>;
        if (m.type === 'line' || m.type === 'arrow') o.mark = { ...m, points: [m.points[0]!, m.points[1]!, at.x, at.y] };
        else {
          const lx = m.points.at(-2)!;
          const ly = m.points.at(-1)!;
          if (Math.hypot(at.x - lx, at.y - ly) < 1 / k) return;
          m.points.push(at.x, at.y);
        }
        draft.current = o.mark;
        break;
      }
      case 'box':
        o.mark = { ...o.mark, rect: normRect(o.start, at) } as Mark;
        draft.current = o.mark;
        break;
      case 'move': {
        const dx = at.x - o.start.x;
        const dy = at.y - o.start.y;
        if (!o.moved && Math.hypot(dx, dy) * k < 4) return;
        o.moved = true;
        draft.current = moveMark(o.from, dx, dy);
        break;
      }
      case 'resize':
        draft.current = resizeMark(o.from, o.handle, at);
        break;
      case 'tap':
        return;
    }
    draw();
  };

  const onUp = (e: RPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (quiet.current) {
      if (pointers.current.size === 0) quiet.current = false;
      cancelOp();
      return;
    }
    const o = op.current;
    const s = st.current;
    op.current = null;
    const live = draft.current;
    draft.current = null;
    if (!o) return draw();
    switch (o.kind) {
      case 'draw':
      case 'box': {
        if (!live) break;
        let m = live;
        if (m.type === 'pen' || m.type === 'highlight') m = { ...m, points: simplify(m.points, 0.6 * s.unit) };
        if (isMeaningful(m, s.unit)) setDoc((d) => addMark(d, m));
        break;
      }
      case 'move':
        if (o.moved && live) setDoc((d) => replaceMark(d, live));
        else if (o.wasSelected && o.from.type === 'text') startText({ x: o.from.points[0]!, y: o.from.points[1]! });
        break;
      case 'resize':
        if (live) setDoc((d) => replaceMark(d, live));
        break;
      case 'tap':
        if (s.tool === 'text') startText(o.at);
        else if (s.tool === 'step') setDoc((d) => addMark(d, { id: markId(), type: 'step', points: [o.at.x, o.at.y], color: s.color, width: widthFor('step', s.sizeClass, s.unit), n: nextStep(d.marks) }));
        break;
      case 'pan':
        break;
    }
    draw();
  };

  const onCancelPointer = (e: RPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) quiet.current = false;
    cancelOp();
  };

  /* ---------- Actions ---------- */

  /** The new text box takes the focus without scrolling the stage (autoFocus would scroll it into view and shift the picture). */
  const focusText = useCallback((el: HTMLTextAreaElement | null) => el?.focus({ preventScroll: true }), []);

  /** Switching the tool ends the text being written first (on iOS a tap on a button does not take the focus, so its blur never comes). */
  const pick = useCallback(
    (t: Tool) => {
      if (st.current.editing) commitText();
      setTool(t);
      if (t !== 'select') setSelected(null);
    },
    [commitText],
  );

  const doUndo = useCallback(() => {
    setSelected(null);
    setDoc((d) => undo(d));
  }, []);
  const doRedo = useCallback(() => {
    setSelected(null);
    setDoc((d) => redo(d));
  }, []);
  const deleteSelected = useCallback(() => {
    const id = st.current.selected;
    if (!id) return;
    setDoc((d) => removeMark(d, id));
    setSelected(null);
  }, []);

  /** A colour or size picked with a mark selected applies to that mark too. */
  const restyle = (patch: { color?: ReporterAnnotationColor; size?: SizeClass }) => {
    if (patch.color) setColor(patch.color);
    if (patch.size) setSizeClass(patch.size);
    const m = doc.marks.find((x) => x.id === selected);
    if (!m || m.type === 'blur') return;
    const next = { ...m } as Mark & { color: ReporterAnnotationColor; width: number };
    if (patch.color) next.color = patch.color;
    if (patch.size) next.width = widthFor(m.type, patch.size, unit);
    setDoc((d) => replaceMark(d, next));
  };

  const finish = async () => {
    if (editing) commitText();
    const marks = toWire(st.current.doc.marks);
    if (!marks.length || !img) return onDone([], null);
    setBusy(true);
    setError(null);
    try {
      const c = document.createElement('canvas');
      renderFlat(c as unknown as FlatCanvas, img, size, marks);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
      if (!blob) throw new Error('The image could not be made.');
      if (blob.size > REPORTER_LIMITS.screenshotBytes) throw new Error('The annotated image is too large to upload.');
      onDone(marks, blob);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  // Keyboard: tool letters, Delete, Esc (drops the mark in progress, else the selection; never closes the panel), undo and redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as Element | null)?.closest?.('textarea, input');
      if (typing) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setEditing(null);
        }
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        doRedo();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (op.current || draft.current) cancelOp();
        else if (confirmClear) setConfirmClear(false);
        else setSelected(null);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (st.current.selected) {
          e.preventDefault();
          deleteSelected();
        }
        return;
      }
      if (e.key === ' ') {
        space.current = true;
        return;
      }
      if (mod || e.altKey) return;
      const t = toolForKey(e.key);
      if (t) {
        e.preventDefault();
        pick(t);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') space.current = false;
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [doUndo, doRedo, deleteSelected, cancelOp, confirmClear, pick]);

  const blurred = hasBlur(doc.marks);
  const tooBig = img ? !canAnnotate(size) : false;
  const full = doc.marks.length >= REPORTER_LIMITS.annotations;
  const sel = doc.marks.find((m) => m.id === selected) ?? null;

  // Phone: two rows of five, so every tool (Blur and Number too) is on screen at 390 px with no hidden scroll; desktop: one row.
  const toolRow = (phone: boolean) => (
    <div role="toolbar" aria-label="Tools" className={phone ? 'grid grid-cols-5 justify-items-center gap-y-0.5 px-1' : 'flex shrink-0 items-center gap-0.5'}>
      {TOOLS.map((t) => (
        <ToolBtn key={t.tool} icon={TOOL_ICON[t.tool]} label={`${t.label} (${t.key.toUpperCase()})`} on={tool === t.tool} onClick={() => pick(t.tool)} />
      ))}
    </div>
  );
  const styleRow = (
    <div className="flex shrink-0 items-center gap-0.5">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={COLOR_NAME[c]}
          title={COLOR_NAME[c]}
          aria-pressed={color === c}
          onClick={() => restyle({ color: c })}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-hidden"
        >
          <span className="size-6 rounded-full" style={{ background: c, boxShadow: color === c ? `0 0 0 2px #0b0d12, 0 0 0 4px #fff` : 'inset 0 0 0 1px rgba(255,255,255,0.35)' }} />
        </button>
      ))}
      <span className="mx-1 h-6 w-px shrink-0 bg-white/20" aria-hidden="true" />
      {SIZES.map((x) => (
        <button
          key={x.v}
          type="button"
          aria-label={x.label}
          title={x.label}
          aria-pressed={sizeClass === x.v}
          onClick={() => restyle({ size: x.v })}
          className={`inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-[13px] font-bold focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-hidden ${sizeClass === x.v ? 'bg-white text-[#0b0d12]' : ''}`}
        >
          {x.v.toUpperCase()}
        </button>
      ))}
    </div>
  );

  const editStyle: CSSProperties | undefined = editing
    ? {
        left: editing.x,
        top: editing.y,
        font: fontOf(editing.width),
        lineHeight: 1.25,
        color: editing.color,
        WebkitTextStroke: `${Math.max(1, editing.width / 12)}px ${haloOf(editing.color)}`,
        minWidth: editing.width * 4,
        maxWidth: Math.max(editing.width * 4, size.w - editing.x),
      }
    : undefined;

  return (
    <div role="dialog" aria-modal="true" aria-label="Annotate" className="fixed inset-0 z-[70] flex flex-col" style={DARK} data-annotator data-marks={doc.marks.length} data-scale={view.scale.toFixed(3)}>
      <div className="flex shrink-0 items-center gap-1 pt-[env(safe-area-inset-top)] pr-12 pl-1">
        <BarBtn icon="x" label="Cancel" onClick={onCancel} />
        <div className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto sm:flex">
          {toolRow(false)}
          <span className="mx-1 h-6 w-px shrink-0 bg-white/20" aria-hidden="true" />
          {styleRow}
        </div>
        <span className="flex-1 sm:hidden" />
        <BarBtn icon="undo" label="Undo" disabled={!canUndo(doc) || busy} onClick={doUndo} />
        <BarBtn icon="redo" label="Redo" disabled={!canRedo(doc) || busy} onClick={doRedo} />
        {sel ? <BarBtn icon="trash2" label="Delete mark" onClick={deleteSelected} /> : <BarBtn icon="trash2" label="Clear all" disabled={!doc.marks.length || busy} aria-expanded={confirmClear} onClick={() => setConfirmClear(!confirmClear)} />}
        <button
          type="button"
          onClick={() => void finish()}
          disabled={busy || failed || tooBig}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl bg-white px-3 text-[14px] font-semibold text-[#0b0d12] focus-visible:ring-2 focus-visible:ring-[#1e88ff] focus-visible:outline-hidden disabled:opacity-50"
        >
          <Icon name="check" className="size-[18px]" />
          {busy ? '…' : 'Done'}
        </button>
      </div>
      {confirmClear && (
        <div role="group" aria-label="Clear all marks" className="flex shrink-0 items-center gap-2 px-3 pb-1">
          <span className="min-w-0 flex-1 text-[13.5px]">Clear all marks?</span>
          <button type="button" onClick={() => setConfirmClear(false)} className="inline-flex min-h-11 items-center rounded-xl px-3 text-[14px] font-semibold focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-hidden">
            Keep
          </button>
          <button
            type="button"
            onClick={() => {
              setDoc((d) => clearAll(d));
              setSelected(null);
              setConfirmClear(false);
            }}
            className="inline-flex min-h-11 items-center rounded-xl bg-[#ef233c] px-3 text-[14px] font-semibold text-white focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-hidden"
          >
            Clear
          </button>
        </div>
      )}
      <div
        ref={frame}
        data-stage
        className={`relative min-h-0 flex-1 touch-none overflow-hidden select-none ${tool === 'select' ? 'cursor-default' : 'cursor-crosshair'}`}
        onWheel={(e) => {
          if (!size.w) return;
          setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.0015), local(e), size, area));
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancelPointer}
        onScroll={(e) => {
          // overflow:hidden still scrolls when a focused child asks to be shown: the stage never moves under the finger.
          e.currentTarget.scrollTop = 0;
          e.currentTarget.scrollLeft = 0;
        }}
      >
        {(blurred || error || tooBig || full) && (
          // Over the stage, not above it: the note appears with the first blur, mid-gesture, and must not push the canvas down.
          <p role="status" className="pointer-events-none absolute inset-x-0 top-0 z-10 px-3 py-1 text-[12.5px] break-words" style={{ background: 'rgba(11, 13, 18, 0.82)', ...(error || tooBig ? { color: '#ff8a96' } : DIM) }}>
            {error ?? (tooBig ? 'This shot is too large to annotate.' : full ? `At most ${REPORTER_LIMITS.annotations} marks.` : 'Blurred areas are removed from the uploaded image.')}
          </p>
        )}
        {failed && <p className="p-6 text-center text-[14px]" style={DIM}>This image could not load.</p>}
        {img && !tooBig && (
          <div className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, width: size.w, height: size.h }}>
            <canvas ref={baseCanvas} aria-label="Screenshot" role="img" className="absolute inset-0 block" style={{ width: size.w, height: size.h }} />
            <canvas ref={overlay} aria-hidden="true" className="absolute inset-0 block" style={{ width: size.w, height: size.h }} />
            {editing && (
              <textarea
                ref={focusText}
                aria-label="Text"
                value={editing.value}
                maxLength={REPORTER_LIMITS.annotationTextChars}
                rows={Math.max(1, editing.value.split('\n').length)}
                onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                onPointerDown={(e) => e.stopPropagation()}
                onBlur={commitText}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commitText();
                  }
                }}
                className="absolute resize-none overflow-hidden border-0 bg-transparent p-0 outline-dashed outline-2 outline-white/80 [field-sizing:content]"
                style={editStyle}
              />
            )}
          </div>
        )}
      </div>
      <div className="shrink-0 pb-[max(0.25rem,env(safe-area-inset-bottom))] sm:hidden">
        {toolRow(true)}
        <div className="overflow-x-auto px-1 [scrollbar-width:none]">{styleRow}</div>
      </div>
    </div>
  );
}

function BarBtn({ icon, label, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-white focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-hidden disabled:opacity-35 ${className}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

function ToolBtn({ icon, label, on, onClick }: { icon: IconName; label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex size-11 shrink-0 items-center justify-center rounded-xl focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-hidden ${on ? 'bg-white text-[#0b0d12]' : 'text-white'}`}
    >
      <Icon name={icon} />
    </button>
  );
}
