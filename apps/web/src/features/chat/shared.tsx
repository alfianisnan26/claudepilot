import { Badge, Spinner, type BadgeTone } from '@isnanme/ui';
import { CHAT_ENDED_CREDENTIAL, CHAT_ENDED_INTEGRITY, CHAT_INELIGIBLE, type ChatSessionState } from '@portal/contracts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { ApiError } from '@/lib/api';
import { SLOT_WAIT_WORD } from './rowMeta';
import { ChatAckError } from './useChatSocket';

/** State → label and badge tone. `starting`/`working` spin; `waiting`/`interrupted` ask for you. */
export const SESSION_STATE: Record<ChatSessionState, { label: string; tone: BadgeTone; busy?: boolean }> = {
  starting: { label: 'Starting', tone: 'neutral', busy: true },
  idle: { label: 'Idle', tone: 'neutral' },
  working: { label: 'Working', tone: 'success', busy: true },
  waiting: { label: 'Needs you', tone: 'warning' },
  interrupted: { label: 'Interrupted', tone: 'warning' },
  ended: { label: 'Ended', tone: 'neutral' },
};

/**
 * The session's state as a pill, matching the workspace/account rows. Working with sub-agents or background commands running says how
 * many ("Working · 2 agents"; one word on a phone): a session whose main turn is over still works while its tasks run (T-41).
 */
export function StateBadge({ state, agents = 0 }: { state: ChatSessionState; agents?: number }) {
  const s = SESSION_STATE[state];
  if (state === 'working' && agents > 0) {
    const n = `${agents} ${agents === 1 ? 'agent' : 'agents'}`;
    return (
      <Badge tone={s.tone}>
        <Spinner className="size-3" />
        <span aria-hidden="true" className="sm:hidden">
          {s.label}
        </span>
        <span aria-hidden="true" className="hidden sm:inline">
          {s.label} · {n}
        </span>
        <span className="sr-only">
          {s.label}, {n} running
        </span>
      </Badge>
    );
  }
  return (
    <Badge tone={s.tone}>
      {s.busy && <Spinner className="size-3" />}
      {s.label}
    </Badge>
  );
}

/**
 * T-425: a start or wake waiting for a slot at a cap (T-417): one word, "Queued", and the server's line ("Waiting for a slot · 4 of 4 running in
 * <workspace> (Settings › Sessions)") as its explanation: an ⓘ where a button is allowed (`tip`: the session page), else the title and the
 * screen reader's text (inside a row's link).
 */
export function SlotWaitBadge({ why, tip = false }: { why: string; tip?: boolean }) {
  return (
    <>
      <span title={tip ? undefined : why} className="inline-flex">
        <Badge tone="neutral">
          <Spinner className="size-3" />
          {SLOT_WAIT_WORD}
          {!tip && <span className="sr-only">: {why}</span>}
        </Badge>
      </span>
      {tip && <InfoTip label="About the wait">{why}</InfoTip>}
    </>
  );
}

/**
 * Whether the portal refused because the workspace can't host sessions now (its Claude isn't signed in
 * and there's no pool, or the pool isn't ready: no usable key, delivery not up to date, a pool change
 * under way). The message says why.
 */
export const isIneligible = (e: unknown): boolean => (e instanceof ApiError || e instanceof ChatAckError) && e.code === CHAT_INELIGIBLE;

/** A session the portal ended at once for safety (credential check) or integrity, and why; null otherwise. */
export function endedForSafety(reason: string | null | undefined): { label: string; why: string } | null {
  if (reason?.startsWith(CHAT_ENDED_CREDENTIAL)) return { label: 'Ended for safety', why: reason.slice(CHAT_ENDED_CREDENTIAL.length) };
  if (reason?.startsWith(CHAT_ENDED_INTEGRITY)) return { label: 'Ended for integrity', why: reason.slice(CHAT_ENDED_INTEGRITY.length) };
  return null;
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

/** The workspace user's home folder: where sessions start by default, and shown as `~`. */
export const HOME = '/home/node';

/** How long ago, in the fewest characters: "now", "7m", "3h", "2d". The full date is the tooltip. */
export function timeShort(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / (86400 * 30))}mo`;
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
