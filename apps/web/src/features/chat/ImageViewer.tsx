import { cn, ease } from '@isnanme/ui';
import type { ChatImage } from '@portal/contracts';
import { ChevronLeft, ChevronRight, Download, ExternalLink, ImageOff, X } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { saveUrl } from './artifacts/save';
import { useModal } from './shared';

export interface ViewerImage {
  src: string;
  alt: string;
  /** The file name Download saves it as. */
  name: string;
  /** The picture's size in pixels, when known: its box is laid out before it loads. */
  width?: number;
  height?: number;
  /** For the share sheet; images the portal stores are one of the four web types. */
  mediaType?: string;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** A stored image's download name: its own, else one made from its hash and type. */
export const imageFileName = (img: ChatImage) => img.name || `image-${img.blobId.slice(0, 8)}.${EXT[img.mediaType] ?? 'img'}`;

/** "Image you sent", or "Image you sent, 2 of 3" when there are several. */
export const imageAlt = (base: string, i: number, count: number) => (count > 1 ? `${base}, ${i + 1} of ${count}` : base);

/** The tallest (or widest) a thumbnail is, in pixels (chat-sessions PRD FR47). */
const THUMB = 240;

/**
 * Image thumbnails, at most 240 px either way, in boxes sized before they load when the picture's size
 * is known. A tap opens the picture over the page: pinch or double-tap to zoom, swipe or the arrows to
 * move through the others, and a Download (the share sheet on a phone).
 */
export function ImageThumbs({ images, align = 'start', className, actions = false }: { images: ViewerImage[]; align?: 'start' | 'end'; className?: string; actions?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <div className={cn('flex max-w-full flex-wrap gap-2', align === 'end' && 'justify-end', className)}>
        {images.map((img, i) => (
          <Thumb key={`${img.src}:${i}`} image={img} onOpen={() => setOpen(i)} actions={actions} />
        ))}
      </div>
      <Lightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </>
  );
}

function Thumb({ image, onOpen, actions }: { image: ViewerImage; onOpen: () => void; actions: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div
        role="img"
        aria-label={`${image.alt} (couldn’t load)`}
        className="flex size-24 flex-col items-center justify-center gap-1 rounded-xl border border-line bg-surface-2 text-[11px] text-muted"
      >
        <ImageOff className="size-4" aria-hidden="true" />
        Unavailable
      </div>
    );
  }
  // With the size known the box is exactly the picture's, scaled to fit 240 px, so nothing moves when it loads.
  const sized =
    image.width && image.height
      ? (() => {
          const k = Math.min(1, THUMB / Math.max(image.width, image.height));
          return { width: Math.max(48, Math.round(image.width * k)), height: Math.max(48, Math.round(image.height * k)) };
        })()
      : null;
  const button = (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      title={image.name}
      style={sized ?? undefined}
      className="press block max-w-full overflow-hidden rounded-xl border border-line bg-surface-2 hover:border-line-strong"
    >
      <img
        src={image.src}
        alt={image.alt}
        width={sized?.width}
        height={sized?.height}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={cn('block object-contain', sized ? 'size-full' : 'max-h-60 min-h-12 max-w-60 min-w-12')}
      />
    </button>
  );
  if (!actions) return button;
  // A Download on the picture itself, for what the agent produced (a button can't sit inside a button).
  return (
    <div className="relative max-w-full">
      {button}
      <button
        type="button"
        onClick={() => void saveUrl(image.src, image.name, image.mediaType ?? 'image/*')}
        aria-label={`Download ${image.name}`}
        title="Download"
        className="press absolute right-1.5 bottom-1.5 flex size-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm hover:bg-black/70 tap:size-10"
      >
        <Download className="size-4" />
      </button>
    </div>
  );
}

/** The picture over everything. Click outside it, ×, or Escape closes it; the arrows (or a swipe) move through the set. */
function Lightbox({ images, index, onIndex, onClose }: { images: ViewerImage[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{index !== null && images[index] && <LightboxPanel key="viewer" images={images} index={index} onIndex={onIndex} onClose={onClose} />}</AnimatePresence>
    </MotionConfig>,
    document.body,
  );
}

const BAR_BUTTON = 'press inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white/85 hover:bg-white/10 hover:text-white tap:size-11';

function LightboxPanel({ images, index, onIndex, onClose }: { images: ViewerImage[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const ref = useModal<HTMLDivElement>(onClose);
  const image = images[index]!;
  const many = images.length > 1;
  // A `data:` or `blob:` picture (still uploading) can't open in a tab of its own; it can still be saved.
  const canOpen = !image.src.startsWith('data:') && !image.src.startsWith('blob:');
  const go = (to: number) => onIndex((to + images.length) % images.length);

  useEffect(() => {
    if (!many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') go(index - 1);
      else if (e.key === 'ArrowRight') go(index + 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, many, images.length]);

  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={image.alt}
      tabIndex={-1}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ duration: 0.18, ease }}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 text-white outline-none"
    >
      <div className="flex shrink-0 items-center gap-1 px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 sm:px-4">
        <p className="min-w-0 flex-1 truncate px-2 text-sm font-semibold">
          {image.name}
          {many && <span className="ml-2 font-normal text-white/60 tabular-nums">{index + 1} / {images.length}</span>}
        </p>
        {canOpen && (
          <a href={image.src} target="_blank" rel="noopener noreferrer" className={BAR_BUTTON} aria-label="Open in a new tab" title="Open in a new tab">
            <ExternalLink className="size-[18px]" aria-hidden="true" />
          </a>
        )}
        <button type="button" onClick={() => void saveUrl(image.src, image.name, image.mediaType ?? 'image/*')} className={BAR_BUTTON} aria-label={`Download ${image.name}`} title="Download">
          <Download className="size-[18px]" aria-hidden="true" />
        </button>
        <button type="button" onClick={onClose} aria-label="Close" title="Close" className={BAR_BUTTON}>
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>
      <Stage image={image} many={many} onStep={(d) => go(index + d)} onClose={onClose} />
      {many && (
        <>
          <button type="button" onClick={() => go(index - 1)} aria-label="Previous picture" className={cn(BAR_BUTTON, 'absolute top-1/2 left-2 hidden -translate-y-1/2 bg-black/40 sm:inline-flex')}>
            <ChevronLeft className="size-5" />
          </button>
          <button type="button" onClick={() => go(index + 1)} aria-label="Next picture" className={cn(BAR_BUTTON, 'absolute top-1/2 right-2 hidden -translate-y-1/2 bg-black/40 sm:inline-flex')}>
            <ChevronRight className="size-5" />
          </button>
        </>
      )}
    </motion.div>
  );
}

const MAX_ZOOM = 5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The picture itself: pinch (two fingers) or the wheel to zoom, drag to pan once zoomed, double-tap to
 * toggle, and at normal size a horizontal swipe moves to the next picture. Nothing here changes the page's own zoom.
 */
function Stage({ image, many, onStep, onClose }: { image: ViewerImage; many: boolean; onStep: (delta: number) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startDist: number; startScale: number } | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: number; background: boolean } | null>(null);
  const lastTap = useRef(0);

  // A new picture starts unzoomed.
  useEffect(() => setView({ scale: 1, x: 0, y: 0 }), [image.src]);

  const limit = (scale: number, x: number, y: number) => {
    const r = box.current?.getBoundingClientRect();
    const mx = r ? ((scale - 1) * r.width) / 2 : 0;
    const my = r ? ((scale - 1) * r.height) / 2 : 0;
    return { scale, x: clamp(x, -mx, mx), y: clamp(y, -my, my) };
  };

  // The wheel zooms (a trackpad pinch arrives as a wheel with the control key).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        const scale = clamp(v.scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), 1, MAX_ZOOM);
        return scale === 1 ? { scale, x: 0, y: 0 } : limit(scale, v.x, v.y);
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const down = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { startDist: dist(a!, b!), startScale: view.scale };
      drag.current = null;
    } else drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: 0, background: e.target === e.currentTarget }; // (the target is the box itself only off the picture)
  };

  const move = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      const scale = clamp(gesture.current.startScale * (dist(a!, b!) / gesture.current.startDist), 1, MAX_ZOOM);
      setView((v) => (scale === 1 ? { scale, x: 0, y: 0 } : limit(scale, v.x, v.y)));
    } else if (drag.current) {
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      drag.current.moved = Math.max(drag.current.moved, Math.hypot(dx, dy));
      if (view.scale > 1) setView(limit(view.scale, drag.current.vx + dx, drag.current.vy + dy));
    }
  };

  const up = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    const d = drag.current;
    if (!d || pointers.current.size > 0) return;
    drag.current = null;
    const dx = e.clientX - d.x;
    // At normal size a long horizontal swipe is "next" or "previous"; a tap on the dark around the picture closes it.
    if (view.scale === 1 && many && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - d.y) * 1.5) return onStep(dx < 0 ? 1 : -1);
    if (d.moved < 8) {
      const now = performance.now();
      if (now - lastTap.current < 320) {
        lastTap.current = 0;
        setView((v) => (v.scale > 1 ? { scale: 1, x: 0, y: 0 } : limit(2.5, 0, 0)));
      } else {
        lastTap.current = now;
        if (d.background) onClose();
      }
    }
  };

  return (
    <div
      ref={box}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      className="flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] select-none sm:p-6"
    >
      <motion.img
        src={image.src}
        alt={image.alt}
        draggable={false}
        initial={{ scale: 0.97 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.2, ease }}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transition: pointers.current.size ? 'none' : 'transform 0.12s ease-out' }}
        className="max-h-full max-w-full rounded-lg object-contain"
      />
    </div>
  );
}
