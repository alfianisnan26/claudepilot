import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ReporterAnchor } from '@portal/contracts';
import { cropBox } from '@/features/reporter/shared';
import { usePanel } from './context';
import { clampView, fitScale, fitView, swipeCloses, toggleZoom, zoomAt, type Size, type View } from './formModel';
import { Icon } from './icons';
import { IconBtn, useAuthUrl } from './ui';

/**
 * The full-screen screenshot viewer (owner, 2026-10-31): over the whole panel (the SDK raises its phone sheet to full height while it is
 * open: pilot-reporter:expand), fit to screen, pinch and wheel zoom, drag to pan, double-tap or double-click for 100%, the crop drawn.
 * Esc, the X or a swipe down at fit closes it; "Open in a new tab" is the image's own (same-origin blob) address.
 */
export function Viewer({ src, alt, crop, onClose, actions }: { src: string; alt: string; crop?: { anchor: ReporterAnchor; scroll: { x: number; y: number } | null } | null; onClose: () => void; actions?: ReactNode }) {
  const { client, post } = usePanel();
  const url = useAuthUrl(client, src);
  const frame = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<Size | null>(null);
  const [area, setArea] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startDist: number; startView: View; mid: { x: number; y: number } } | null>(null);
  const drag = useRef<{ x: number; y: number; view: View; t: number; sx: number; sy: number } | null>(null);
  const lastTap = useRef(0);

  useEffect(() => {
    post({ type: 'pilot-reporter:expand', expanded: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // The panel's own Esc-to-close skips a key a control used.
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      post({ type: 'pilot-reporter:expand', expanded: false });
    };
  }, [post, onClose]);

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
    if (img && area.w) setView(fitView(img, area));
  }, [img, area]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = frame.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const box = img && crop ? cropBox(img, crop.anchor, crop.scroll) : null;
  const atFit = img ? Math.abs(view.scale - fitScale(img, area)) < 0.01 : true;

  return (
    <div role="dialog" aria-modal="true" aria-label={alt} className="fixed inset-0 z-[60] flex flex-col bg-black/95 text-white">
      <div className="flex shrink-0 items-center gap-1 px-1 pt-[env(safe-area-inset-top)]">
        <IconBtn icon="x" label="Close" onClick={onClose} className="text-white" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-white/80">{alt}</span>
        {actions}
        {url && url !== 'failed' && (
          <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab" title="Open in a new tab" className="inline-flex size-11 items-center justify-center rounded-xl text-white focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
            <Icon name="externalLink" className="size-[18px]" />
          </a>
        )}
      </div>
      <div
        ref={frame}
        className="relative min-h-0 flex-1 touch-none overflow-hidden select-none"
        onWheel={(e) => {
          if (!img) return;
          setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.0015), local(e), img, area));
        }}
        onDoubleClick={(e) => img && setView((v) => toggleZoom(v, local(e), img, area))}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          pointers.current.set(e.pointerId, local(e));
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
            gesture.current = { startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1, startView: viewRef.current, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
            drag.current = null;
          } else {
            const p = local(e);
            drag.current = { x: p.x, y: p.y, view: viewRef.current, t: Date.now(), sx: p.x, sy: p.y };
          }
        }}
        onPointerMove={(e) => {
          if (!img || !pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, local(e));
          const g = gesture.current;
          if (g && pointers.current.size >= 2) {
            const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            setView(zoomAt(g.startView, d / g.startDist, g.mid, img, area));
          } else if (drag.current) {
            const p = local(e);
            const d = drag.current;
            if (!atFit) setView(clampView({ ...d.view, x: d.view.x + p.x - d.x, y: d.view.y + p.y - d.y }, img, area));
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) gesture.current = null;
          if (!d || !img) return;
          const p = local(e);
          if (swipeCloses(p.y - d.sy, p.x - d.sx, atFit)) return onClose();
          // A quick second tap on touch: the same as a double-click.
          if (e.pointerType === 'touch' && Math.hypot(p.x - d.sx, p.y - d.sy) < 10) {
            if (Date.now() - lastTap.current < 300) {
              setView((v) => toggleZoom(v, p, img, area));
              lastTap.current = 0;
            } else lastTap.current = Date.now();
          }
          drag.current = null;
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          gesture.current = null;
          drag.current = null;
        }}
      >
        {url === 'failed' && <p className="p-6 text-center text-[14px] text-white/70">This image could not load.</p>}
        {url && url !== 'failed' && (
          <div className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, width: img?.w, height: img?.h }}>
            <img src={url} alt={alt} draggable={false} onLoad={(e) => setImg({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} className="block max-w-none" />
            {box && (
              <span aria-hidden="true" className="absolute rounded-sm border-danger" style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%`, borderWidth: `${2 / view.scale}px` }} />
            )}
          </div>
        )}
      </div>
      <p className="shrink-0 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-center text-[12px] text-white/60 tabular-nums">{Math.round(view.scale * 100)}%</p>
    </div>
  );
}
