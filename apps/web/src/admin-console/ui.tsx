import { Check, Copy, Info, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

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

/** Runs an action through the console: a step-up refusal asks for the password and runs it again; an error shows in the banner. */
export type Run = <T>(action: () => Promise<T>) => Promise<T | undefined>;

/** Open sheets, the top last: Escape closes only the top one (a confirmation over a user's sheet). */
const openSheets: object[] = [];

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // The latest onClose, so a parent's re-render (a new arrow each time) neither re-focuses the sheet nor reorders the stack.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const me = {};
    openSheets.push(me);
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && openSheets.at(-1) === me && close.current();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      openSheets.splice(openSheets.indexOf(me), 1);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="max-h-[90dvh] w-full overflow-y-auto overscroll-contain rounded-t-2xl bg-bg pb-[env(safe-area-inset-bottom)] outline-hidden sm:max-w-lg sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-bg px-4">
          <h2 className="break-any min-w-0 flex-1 py-3 text-base font-semibold">{title}</h2>
          <button type="button" className={btnPlain} aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="flex flex-col gap-4 p-4">{children}</div>
      </div>
    </div>
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
