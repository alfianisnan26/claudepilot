import { AppError } from '@isnanme/core';

/**
 * Control of a workspace's browser (browser & desktop PRD §12.3): a lease held by one person's device, in the
 * supervisor, renewed from here. While it is held the gate refuses the agent's browser calls. This class is the
 * portal's side: who holds it, whether they are still around, and telling the live views when it changes. The
 * supervisor owns the truth (a portal that dies stops renewing, and control ends within a minute and a half).
 */

/** How long the supervisor keeps a lease without a renewal. */
export const LEASE_TTL_S = 90;
/** Renewals go out this often while the holder's device is around. */
export const RENEW_EVERY_MS = 30_000;
/** A device that switched apps to type a password or fetch a code keeps control this long (PRD §12.3, a Settings row). */
export const AWAY_GRACE_MS = 5 * 60_000;

export const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** What a device is called for people: printable, short, never markup. */
export function deviceLabel(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/[^\p{L}\p{N} .,'’()_-]/gu, '').replace(/\s+/g, ' ').trim() : '';
  return text.slice(0, 40) || 'A device';
}

export interface Lease {
  device: string;
  label: string;
  private: boolean;
  /** The last time this device was seen: a socket open, or a call. */
  seenAt: number;
  /** The handoff this answers, when control started from one. */
  handoffId: string | null;
}

export interface LeaseDeps {
  /** Takes or renews the lease in the supervisor (`cpb-ctl control --on …`). */
  renew: (workspaceId: string, lease: Lease) => Promise<void>;
  /** Whether the supervisor still says this device holds it (a lease can end there on its own). */
  holder: (workspaceId: string) => Promise<string | null>;
  /** The lease ended without the person handing back (it ran out, or the portal lost the device). */
  ended: (workspaceId: string, lease: Lease, why: 'away' | 'lost') => void;
  now?: () => number;
  renewEveryMs?: number;
  graceMs?: number;
}

type Listener = () => void;

export class Leases {
  readonly #leases = new Map<string, Lease>();
  readonly #listeners = new Map<string, Set<Listener>>();
  /** Devices with an open live view, per workspace: while one is open the holder isn't away. */
  readonly #open = new Map<string, Map<string, number>>();
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: LeaseDeps) {}

  start() {
    this.#timer = setInterval(() => void this.#tick(), this.deps.renewEveryMs ?? RENEW_EVERY_MS);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
  }

  #now() {
    return this.deps.now?.() ?? Date.now();
  }

  get(workspaceId: string): Lease | null {
    return this.#leases.get(workspaceId) ?? null;
  }

  /** The device that holds control, or null. */
  holderOf(workspaceId: string): string | null {
    return this.#leases.get(workspaceId)?.device ?? null;
  }

  /** A device took control (or renewed it). */
  set(workspaceId: string, lease: Omit<Lease, 'seenAt'>) {
    const before = this.#leases.get(workspaceId);
    this.#leases.set(workspaceId, { ...lease, seenAt: this.#now() });
    if (!before || before.device !== lease.device || before.private !== lease.private) this.#emit(workspaceId);
  }

  /** Control ended by the person (hand back) or by someone taking over. */
  clear(workspaceId: string) {
    if (this.#leases.delete(workspaceId)) this.#emit(workspaceId);
  }

  /** The supervisor reports who holds control now: adopt it (after a portal restart), or notice it ended. */
  reconcile(workspaceId: string, held: { holder: string; label: string; private: boolean } | null) {
    const mine = this.#leases.get(workspaceId);
    if (!held) {
      if (mine) {
        this.#leases.delete(workspaceId);
        this.deps.ended(workspaceId, mine, 'lost');
        this.#emit(workspaceId);
      }
      return;
    }
    if (!mine || mine.device !== held.holder) {
      // After a restart the portal learns the holder from the supervisor, and renews only if that device shows up within the grace.
      this.#leases.set(workspaceId, { device: held.holder, label: held.label, private: held.private, seenAt: this.#now(), handoffId: null });
      this.#emit(workspaceId);
    }
  }

  /** A device was seen (a socket opened or messaged, a call made): it isn't away. */
  seen(workspaceId: string, device: string) {
    const lease = this.#leases.get(workspaceId);
    if (lease?.device === device) lease.seenAt = this.#now();
  }

  /** A live view opened or closed for a device. */
  opened(workspaceId: string, device: string, delta: 1 | -1) {
    const devices = this.#open.get(workspaceId) ?? new Map<string, number>();
    const n = (devices.get(device) ?? 0) + delta;
    if (n > 0) devices.set(device, n);
    else devices.delete(device);
    this.#open.set(workspaceId, devices);
    this.seen(workspaceId, device);
  }

  isOpen(workspaceId: string, device: string): boolean {
    return (this.#open.get(workspaceId)?.get(device) ?? 0) > 0;
  }

  /** Calls `fn` when who holds control changes. Returns a function that stops it. */
  watch(workspaceId: string, fn: Listener): () => void {
    const set = this.#listeners.get(workspaceId) ?? new Set<Listener>();
    set.add(fn);
    this.#listeners.set(workspaceId, set);
    return () => void set.delete(fn);
  }

  #emit(workspaceId: string) {
    for (const fn of this.#listeners.get(workspaceId) ?? []) {
      try {
        fn();
      } catch {
        // a socket that failed to hear it is closing anyway
      }
    }
  }

  /** Renews every lease whose device is around; ends the ones whose device is gone past the grace. */
  async #tick() {
    for (const [workspaceId, lease] of [...this.#leases]) {
      const away = !this.isOpen(workspaceId, lease.device) && this.#now() - lease.seenAt > (this.deps.graceMs ?? AWAY_GRACE_MS);
      if (away) {
        this.#leases.delete(workspaceId);
        this.deps.ended(workspaceId, lease, 'away');
        this.#emit(workspaceId);
        continue;
      }
      try {
        // Another device may have taken it over meanwhile: then it is theirs, and renewing would take it back.
        const holder = await this.deps.holder(workspaceId);
        if (holder !== lease.device) {
          this.reconcile(workspaceId, holder ? { holder, label: '', private: false } : null);
          continue;
        }
        await this.deps.renew(workspaceId, lease);
      } catch (e) {
        console.error(`[browser] renewing control of ${workspaceId}: ${(e as Error).message}`);
      }
    }
  }
}

/** Refuses what a request may not do (take control from a device that isn't allowed, release another's). */
export function refuse(message: string): never {
  throw new AppError('CONFLICT', message);
}
