import { buttonClass, Dialog, useIsDesktop } from '@isnanme/ui';
import { ChevronRight, X } from 'lucide-react';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { GlancePopover, type PopoverSide } from './Popover';
import { Quiet } from './Quiet';
import { widgetById } from './registry';
import type { GlanceContext, GlanceSurface, GlanceWidget } from './types';

/** A widget's full form, the same in every surface; the widget may load it lazily, so there is a quiet placeholder. */
export function FullBody({ widget, ctx, surface, close }: { widget: GlanceWidget; ctx: GlanceContext; surface: GlanceSurface; close: () => void }) {
  const Full = widget.Full;
  return (
    <Quiet what={`${widget.id} (full form)`} fallback={<p className="py-3 text-center text-[13.5px] text-muted">Could not show this.</p>}>
      <Suspense fallback={<div className="skeleton h-24 rounded-2xl" aria-busy="true" />}>
        <Full ctx={ctx} surface={surface} close={close} />
      </Suspense>
    </Quiet>
  );
}

/**
 * The heading of a popover or a dock section: icon, one word, the page it opens and, where it can close, ×. It shows from 640 px only
 * (a phone gets the kit's sheet, whose Close the index.css floor sizes), so its two buttons are 32 px with a mouse and 44 px with a
 * coarse pointer, a tablet (T-1859); the 48 px header holds either.
 */
export function FullHeader({ widget, onClose, onNavigate }: { widget: GlanceWidget; onClose?: () => void; onNavigate?: () => void }) {
  const Icon = widget.icon;
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
      <Icon className="size-[18px] shrink-0 text-muted" aria-hidden="true" />
      <h2 className="min-w-0 flex-1 truncate text-[15px] font-bold tracking-tight">{widget.label}</h2>
      {widget.href && (
        <Link to={widget.href} onClick={onNavigate} aria-label={`Open ${widget.label}`} title={`Open ${widget.label}`} className="press inline-flex size-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink pointer-coarse:size-11">
          <ChevronRight className="size-[18px]" />
        </Link>
      )}
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Close" className="press inline-flex size-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink pointer-coarse:size-11">
          <X className="size-4" />
        </button>
      )}
    </header>
  );
}

/** The full form as a bottom sheet on a phone (the kit's dialog is a centred modal from 640 px: where a deep link opens one). */
export function GlanceSheet({ widget, ctx, onClose }: { widget: GlanceWidget; ctx: GlanceContext; onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={widget.label}
      size="sm"
      footer={
        widget.href && (
          <Link to={widget.href} onClick={onClose} className={buttonClass('secondary', 'md')}>
            Open
          </Link>
        )
      }
    >
      <FullBody widget={widget} ctx={ctx} surface="sheet" close={onClose} />
    </Dialog>
  );
}

/**
 * What a strip needs to open full forms: which one is open, how to toggle it from its chip, and the element to render
 * (a popover beside the chip from 640 px, a bottom sheet below). One at a time per strip.
 */
export function useGlanceHost(ctx: GlanceContext, side: PopoverSide) {
  const desktop = useIsDesktop();
  const [open, setOpen] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  // Going to another page (a link, Back, a shortcut) closes what was open, whoever caused it.
  const { pathname } = useLocation();
  useEffect(() => setOpen(null), [pathname]);
  const toggle = useCallback((widget: GlanceWidget, anchor: HTMLElement | null) => {
    setOpen((cur) => (cur?.id === widget.id || !anchor ? null : { id: widget.id, anchor }));
  }, []);
  const widget = open ? widgetById(open.id) : undefined;
  const element =
    open && widget ? (
      desktop ? (
        <GlancePopover anchor={open.anchor} side={side} label={widget.label} onClose={close}>
          <FullHeader widget={widget} onClose={close} onNavigate={close} />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
            <FullBody widget={widget} ctx={ctx} surface="popover" close={close} />
          </div>
        </GlancePopover>
      ) : (
        <GlanceSheet widget={widget} ctx={ctx} onClose={close} />
      )
    ) : null;
  return { openId: open?.id ?? null, toggle, close, element };
}
