import { Badge, Spinner, type BadgeTone } from '@isnanme/ui';
import type { ChatSessionState } from '@portal/contracts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** State → label and badge tone. `starting`/`working` spin; `waiting`/`interrupted` ask for you. */
export const SESSION_STATE: Record<ChatSessionState, { label: string; tone: BadgeTone; busy?: boolean }> = {
  starting: { label: 'Starting', tone: 'neutral', busy: true },
  idle: { label: 'Idle', tone: 'neutral' },
  working: { label: 'Working', tone: 'success', busy: true },
  waiting: { label: 'Needs you', tone: 'warning' },
  interrupted: { label: 'Interrupted', tone: 'warning' },
  ended: { label: 'Ended', tone: 'neutral' },
};

/** The session's state as a pill, matching the workspace/account rows. */
export function StateBadge({ state }: { state: ChatSessionState }) {
  const s = SESSION_STATE[state];
  return (
    <Badge tone={s.tone}>
      {s.busy && <Spinner className="size-3" />}
      {s.label}
    </Badge>
  );
}

/** Which sub-agent a line came from, when it's not the main one. */
export function AgentTag({ label }: { label: string }) {
  return (
    <span
      title={label}
      className="inline-block max-w-[16rem] truncate rounded bg-surface-2 px-1.5 py-0.5 align-middle text-[10.5px] font-semibold tracking-wide text-muted uppercase"
    >
      {label}
    </span>
  );
}

/** A small dollar amount: more decimals the smaller it is, so cents still read. */
export const formatUsd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/** "850", "12.3k", "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_500) return `${(n / 1000).toFixed(n < 9_950 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "42s", "3m 05s", "1h 12m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** The current time, ticking once a second while `active` (live elapsed times). */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
]
  .map((s) => `${s}:not([tabindex="-1"])`)
  .join(',');

/**
 * Modal behaviour for this feature's own overlays (the agents sheet, the image viewer), like the kit's
 * Dialog: focus moves into the element when it mounts and back where it was when it unmounts, Tab
 * stays inside, and Escape closes. Put the ref on an element with `tabIndex={-1}`.
 */
export function useModal<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = ref.current;
    panel?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return e.preventDefault();
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}
