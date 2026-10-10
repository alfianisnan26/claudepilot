import { cn, ease } from '@isnanme/ui';
import type { ChatImage } from '@portal/contracts';
import { Download, ExternalLink, ImageOff, X } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useModal } from './shared';

export interface ViewerImage {
  src: string;
  alt: string;
  /** The file name Download saves it as. */
  name: string;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** A stored image's download name: its own, else one made from its hash and type. */
export const imageFileName = (img: ChatImage) => img.name || `image-${img.blobId.slice(0, 8)}.${EXT[img.mediaType] ?? 'img'}`;

/** "Image you sent", or "Image you sent, 2 of 3" when there are several. */
export const imageAlt = (base: string, i: number, count: number) => (count > 1 ? `${base}, ${i + 1} of ${count}` : base);

/**
 * Image thumbnails, at most 240 px either way. A tap opens the full image over the page, with Open
 * (the original in a new tab) and Download.
 */
export function ImageThumbs({ images, align = 'start', className }: { images: ViewerImage[]; align?: 'start' | 'end'; className?: string }) {
  const [open, setOpen] = useState<ViewerImage | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <div className={cn('flex max-w-full flex-wrap gap-2', align === 'end' && 'justify-end', className)}>
        {images.map((img, i) => (
          <Thumb key={i} image={img} onOpen={() => setOpen(img)} />
        ))}
      </div>
      <Lightbox image={open} onClose={() => setOpen(null)} />
    </>
  );
}

function Thumb({ image, onOpen }: { image: ViewerImage; onOpen: () => void }) {
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
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className="press block overflow-hidden rounded-xl border border-line bg-surface-2 hover:border-line-strong"
    >
      <img
        src={image.src}
        alt={image.alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="block max-h-60 min-h-12 max-w-60 min-w-12 object-contain"
      />
    </button>
  );
}

/** The full image, over everything. Click outside the image, ×, or Escape closes it. */
function Lightbox({ image, onClose }: { image: ViewerImage | null; onClose: () => void }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{image && <LightboxPanel key={image.src} image={image} onClose={onClose} />}</AnimatePresence>
    </MotionConfig>,
    document.body,
  );
}

const BAR_BUTTON =
  'press inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold text-white/85 hover:bg-white/10 hover:text-white';

function LightboxPanel({ image, onClose }: { image: ViewerImage; onClose: () => void }) {
  const ref = useModal<HTMLDivElement>(onClose);
  // A `data:` image (still uploading) can't open in a tab of its own; it can still be saved.
  const canOpen = !image.src.startsWith('data:');
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
        <p className="min-w-0 flex-1 truncate px-2 text-sm font-semibold">{image.name}</p>
        {canOpen && (
          <a href={image.src} target="_blank" rel="noopener noreferrer" className={cn(BAR_BUTTON, 'px-3')} aria-label="Open the image in a new tab">
            <ExternalLink className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Open</span>
          </a>
        )}
        <a href={image.src} download={image.name} className={cn(BAR_BUTTON, 'px-3')} aria-label={`Download ${image.name}`}>
          <Download className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Download</span>
        </a>
        <button type="button" onClick={onClose} aria-label="Close" className={cn(BAR_BUTTON, 'w-10')}>
          <X className="size-[18px]" aria-hidden="true" />
        </button>
      </div>
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-6"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <motion.img
          src={image.src}
          alt={image.alt}
          initial={{ scale: 0.97 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.2, ease }}
          className="max-h-full max-w-full rounded-lg object-contain"
        />
      </div>
    </motion.div>
  );
}
