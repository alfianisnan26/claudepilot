// The ticket card's status pill as a control (PILOT-1200): the same pill (the phase, its colour), which opens a small menu of the ticket
// statuses with their portal labels. The change is optimistic: the card shows it at once and goes back when the server refuses it.
import { TICKET_STATUSES, TICKET_STATUS_LABEL, type ReporterTicket, type ReporterWorkPhase, type TicketStatus } from '@portal/contracts';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { PHASE_LABEL, PHASE_TONE } from '@/features/reporter/shared';
import { Icon } from './icons';

/** The colour of a status in the menu: its phase's (blocked reads as open, red: someone has to act). */
export const STATUS_PHASE: Record<TicketStatus, ReporterWorkPhase> = {
  open: 'open',
  in_progress: 'working',
  blocked: 'open',
  in_review: 'review',
  done: 'fixed',
  wont_do: 'wont-do',
};

/**
 * The card as it will look once the server took the new status, until its answer comes (the server's own view then replaces it). A done
 * ticket that was deployed stays deployed; the rest follows the server's phase rules for a status alone.
 */
export function optimisticTicket(t: ReporterTicket, status: TicketStatus): ReporterTicket {
  const phase: ReporterWorkPhase = status === 'done' && t.phase === 'deployed' ? 'deployed' : STATUS_PHASE[status];
  return { ...t, status, phase };
}

/**
 * Runs one status change: shows it at once (`show`), saves it, then shows the server's card; on a refusal shows the card as it was and
 * says why. Never throws.
 */
export async function changeStatus(
  t: ReporterTicket,
  status: TicketStatus,
  save: (status: TicketStatus) => Promise<ReporterTicket>,
  show: (t: ReporterTicket) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  show(optimisticTicket(t, status));
  try {
    show(await save(status));
    return { ok: true };
  } catch (e) {
    show(t);
    return { ok: false, error: (e as Error).message || 'Something went wrong.' };
  }
}

const pill = 'rounded-full px-2 py-0.5 text-[12.5px] leading-4 font-semibold whitespace-nowrap';

/** The pill, which opens the status menu. Disabled (and busy) while a change is being saved. */
export function StatusMenu({ ticket, saving, onPick }: { ticket: ReporterTicket; saving: boolean; onPick: (s: TicketStatus) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // The current status has focus first, so Enter on it again changes nothing.
    items.current[Math.max(0, TICKET_STATUSES.indexOf(ticket.status))]?.focus();
    const away = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    // Esc closes the menu only, never the panel behind it (the panel's own Esc skips a key a control used).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (saving) setOpen(false);
  }, [saving]);

  const move = (e: ReactKeyboardEvent<HTMLSpanElement>) => {
    const n = TICKET_STATUSES.length;
    const at = items.current.findIndex((el) => el === document.activeElement);
    const to =
      e.key === 'ArrowDown' ? (at + 1) % n : e.key === 'ArrowUp' ? (at - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) {
      if (e.key === 'Tab') setOpen(false);
      return;
    }
    e.preventDefault();
    items.current[to]?.focus();
  };

  const pick = (s: TicketStatus) => {
    close(true);
    if (s !== ticket.status) onPick(s);
  };

  return (
    <span ref={wrap} className="relative inline-flex">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Status: ${TICKET_STATUS_LABEL[ticket.status]}. Change status`}
        aria-busy={saving || undefined}
        disabled={saving}
        data-status-pill
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`${pill} ${PHASE_TONE[ticket.phase]} inline-flex items-center gap-0.5 transition-opacity duration-150 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden disabled:opacity-60`}
      >
        {PHASE_LABEL[ticket.phase]}
        {saving ? <span aria-hidden="true" className="spinner size-3" /> : <Icon name="chevronDown" className="size-3 opacity-70" />}
      </button>
      {open && (
        <StatusOptions
          current={ticket.status}
          onPick={pick}
          onKeyDown={move}
          itemRef={(i, el) => {
            items.current[i] = el;
          }}
        />
      )}
    </span>
  );
}

/** The menu itself: every ticket status with its portal label, in its phase's colour; the current one checked. */
export function StatusOptions({
  current,
  onPick,
  onKeyDown,
  itemRef,
}: {
  current: TicketStatus;
  onPick: (s: TicketStatus) => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLSpanElement>) => void;
  itemRef?: (i: number, el: HTMLButtonElement | null) => void;
}) {
  return (
    // A span: the pill sits in the card's meta line, a <p>.
    <span
      role="menu"
      aria-label="Change status"
      onKeyDown={onKeyDown}
      className="absolute top-full left-0 z-30 mt-1 block w-44 overflow-hidden rounded-2xl border border-line bg-surface py-1 text-ink shadow-lg"
    >
      {TICKET_STATUSES.map((s, i) => (
        <button
          key={s}
          ref={(el) => {
            itemRef?.(i, el);
          }}
          type="button"
          role="menuitemradio"
          aria-checked={current === s}
          onClick={() => onPick(s)}
          className="flex min-h-11 w-full items-center gap-2 px-3 text-left focus-visible:bg-surface-2 focus-visible:outline-hidden"
        >
          <span className="w-4">{current === s && <Icon name="check" className="size-4 text-accent" />}</span>
          <span className={`${pill} ${PHASE_TONE[STATUS_PHASE[s]]}`}>{TICKET_STATUS_LABEL[s]}</span>
        </button>
      ))}
    </span>
  );
}
