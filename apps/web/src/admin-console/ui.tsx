import { Check, Copy, Info, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Sheet, sheetsOpen } from '../components/Sheet';
import { usePaneFill } from '../components/WindowedList';

export { Sheet };

/*
 * The Admin console's small kit: buttons, fields, a sheet (bottom on phones, centred on desktop), a section with a reload button, an InfoTip,
 * a confirmation sheet (with a reason when the action takes one) and the once-only secret sheet. 44 px targets everywhere; focus rings stay
 * (outline-hidden only on the programmatic-focus dialog container, never outline-none).
 */

export const btn = 'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium disabled:opacity-50';
export const btnPlain = `${btn} border border-line bg-surface hover:bg-surface-2`;
export const btnDanger = `${btn} border border-line bg-surface text-danger hover:bg-danger-soft`;
export const btnPrimary = `${btn} bg-primary text-primary-ink`;
export const field = 'min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink';
export const chip = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs';
export const list = 'flex flex-col divide-y divide-line rounded-xl border border-line bg-surface';
/** Where a windowed list's filters stick on a phone: under the console's top bar (the document scrolls there). */
export const CONSOLE_STICKY = 'sticky top-[calc(env(safe-area-inset-top)+3rem)] z-[5] -mx-4 bg-bg/95 px-4 pt-1 backdrop-blur';

/** Runs an action through the console: a step-up refusal asks for the password and runs it again; an error shows in the banner. */
export type Run = <T>(action: () => Promise<T>) => Promise<T | undefined>;

/** A desktop (1024 px and up): the console's content pane scrolls and a detail opens beside its list. */
export function useWide(): boolean {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(query);
    const on = () => setWide(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

/**
 * Master-detail (docs/coord/UI-STANDARD.md §4; owner, 2026-11-01): on a desktop the list and, when one is open, its detail side by side,
 * the detail a panel that fills the pane's height and scrolls inside; on a phone the list alone and the detail as a sheet (DetailPanel).
 */
export function MasterDetail({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  return (
    <div data-master-detail={detail ? 'open' : 'closed'} className={detail ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(22rem,30rem)] lg:items-start lg:gap-6' : undefined}>
      <div className="min-w-0">{list}</div>
      {detail}
    </div>
  );
}

/** The detail of a master-detail: a side panel on a desktop (its own scroll, the pane's height), a sheet on a phone. Escape closes either. */
export function DetailPanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const wide = useWide();
  const box = useRef<HTMLElement>(null);
  const height = usePaneFill(box, wide, 320);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!wide) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && sheetsOpen() === 0 && close.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wide]);
  if (!wide)
    return (
      <Sheet title={title} onClose={onClose}>
        {children}
      </Sheet>
    );
  return (
    <aside
      ref={box}
      data-detail-panel=""
      aria-label={title}
      className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface"
      style={height !== null ? { height } : undefined}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4">
        <h3 className="break-any min-w-0 flex-1 py-3 text-base font-semibold">{title}</h3>
        <button type="button" className={btnPlain} aria-label="Close" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">{children}</div>
    </aside>
  );
}

/** An ⓘ that opens one or two sentences under it: the explanation lives here, never as a paragraph on the page. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="inline-flex flex-col">
      <button type="button" className={`${btn} px-0 text-muted`} aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <Info size={16} aria-hidden />
      </button>
      {open && (
        <span id={id} role="note" className="break-any block max-w-sm rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
          {children}
        </span>
      )}
    </span>
  );
}

export function useList<T>(run: Run, load: () => Promise<T[]>) {
  const [items, setItems] = useState<T[] | null>(null);
  const reload = useCallback(() => void run(load).then((v) => v && setItems(v)), [run, load]);
  useEffect(reload, [reload]);
  return { items, reload };
}

export function Section({ title, onReload, actions, tip, children }: { title: string; onReload: () => void; actions?: ReactNode; tip?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {tip && <InfoTip label={`About ${title}`}>{tip}</InfoTip>}
        <span className="flex-1" />
        {actions}
        <button type="button" className={btnPlain} aria-label="Reload" title="Reload" onClick={onReload}>
          <RefreshCw size={18} aria-hidden />
        </button>
      </div>
      {children}
    </section>
  );
}

export const Empty = ({ items }: { items: unknown[] | null }) =>
  items === null ? <p className="text-sm text-muted">Loading</p> : items.length === 0 ? <p className="text-sm text-muted">None</p> : null;

/** A label above its field. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {children}
    </label>
  );
}

/**
 * Asks before a write that cannot be undone or takes something away. `reason`: a text field (`min` characters when required) whose value is
 * passed to `onConfirm`. Closes itself once `onConfirm` resolves true.
 */
export function Confirm({
  title,
  body,
  action,
  danger,
  reason,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  action: string;
  danger?: boolean;
  reason?: { label: string; min: number };
  onConfirm: (reason: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (await onConfirm(text.trim())) onClose();
    } finally {
      setBusy(false);
    }
  };
  const short = !!reason && text.trim().length < reason.min;
  return (
    <Sheet title={title} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <div className="break-any text-sm">{body}</div>
        {reason && (
          <Field label={reason.label}>
            <textarea className={`${field} min-h-24 py-2`} required={reason.min > 0} minLength={reason.min || undefined} maxLength={200} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={btnPlain} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={danger ? btnDanger : btnPrimary} disabled={busy || short}>
            {action}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** A secret shown once (a one-time password, a new server code): copy it now; it is not shown again. */
export function Secret({ title, value, onClose }: { title: string; value: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(value).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  return (
    <Sheet title={title} onClose={onClose}>
      <p className="text-sm text-muted">Shown once.</p>
      <div className="flex gap-2">
        <input className={`${field} font-mono`} readOnly value={value} aria-label={title} onFocus={(e) => e.target.select()} />
        <button type="button" className={btnPlain} aria-label="Copy" onClick={copy}>
          {copied ? <Check size={18} aria-hidden /> : <Copy size={18} aria-hidden />}
        </button>
      </div>
      <button type="button" className={btnPrimary} onClick={onClose}>
        Done
      </button>
    </Sheet>
  );
}
