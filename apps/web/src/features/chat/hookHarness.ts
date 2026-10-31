// A tiny hook runtime for tests (T-382 S5): the web package has no DOM and no hook test library, so this mounts a hook by installing a dispatcher
// into React's own internals (the slot `useState` and friends read). It supports what the paging hooks use: useState, useRef, useCallback,
// useMemo, useContext (a context with no provider answers `opts.context`) and useEffect / useLayoutEffect with their cleanups. A state change re-renders at once, then the effects of that render run. Tests only.
import * as ReactNs from 'react';

type Internals = { H: unknown };
const React = ((ReactNs as unknown as { default?: unknown }).default ?? ReactNs) as Record<string, unknown>;
const internals = React['__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'] as Internals;

interface Slot {
  v?: unknown;
  set?: (x: unknown) => void;
  deps?: readonly unknown[] | undefined;
  cleanup?: (() => void) | void;
}

const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
  !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

export interface Mounted<T> {
  /** What the hook returned on its latest render. */
  readonly current: T;
  /** How many times it rendered. */
  readonly renders: number;
  unmount(): void;
}

/** `context`: what `useContext` answers for a context with no value (no provider in a test), e.g. the toast function. */
export function mountHook<T>(hook: () => T, opts: { context?: unknown } = {}): Mounted<T> {
  const slots: Slot[] = [];
  let index = 0;
  let current!: T;
  let renders = 0;
  let mounted = true;
  let rendering = false;
  let again = false;
  let effects: (() => void)[] = [];

  const slot = (): Slot => (slots[index] ??= {});
  const effect = (create: () => (() => void) | void, deps?: readonly unknown[]) => {
    const s = slot();
    index++;
    if (s.deps !== undefined && same(s.deps, deps)) return;
    s.deps = deps;
    effects.push(() => {
      if (typeof s.cleanup === 'function') s.cleanup();
      s.cleanup = create();
    });
  };

  const dispatcher = {
    useState(init: unknown) {
      const s = slot();
      index++;
      if (!('v' in s)) {
        s.v = typeof init === 'function' ? (init as () => unknown)() : init;
        s.set = (x) => {
          const next = typeof x === 'function' ? (x as (p: unknown) => unknown)(s.v) : x;
          if (Object.is(next, s.v)) return;
          s.v = next;
          if (mounted) render();
        };
      }
      return [s.v, s.set];
    },
    useRef(init: unknown) {
      const s = slot();
      index++;
      return (s.v ??= { current: init });
    },
    useCallback(fn: unknown, deps?: readonly unknown[]) {
      const s = slot();
      index++;
      if (!same(s.deps, deps)) ((s.v = fn), (s.deps = deps));
      return s.v;
    },
    useMemo(fn: () => unknown, deps?: readonly unknown[]) {
      const s = slot();
      index++;
      if (!same(s.deps, deps)) ((s.v = fn()), (s.deps = deps));
      return s.v;
    },
    useEffect: effect,
    useLayoutEffect: effect,
    useContext(ctx: { _currentValue?: unknown }) {
      return ctx._currentValue ?? opts.context;
    },
    useDebugValue() {},
  };

  function render() {
    if (rendering) {
      again = true;
      return;
    }
    rendering = true;
    try {
      do {
        again = false;
        const before = internals.H;
        internals.H = dispatcher;
        index = 0;
        effects = [];
        try {
          current = hook();
          renders++;
        } finally {
          internals.H = before;
        }
        for (const run of effects) run();
      } while (again && mounted);
    } finally {
      rendering = false;
    }
  }

  render();
  return {
    get current() {
      return current;
    },
    get renders() {
      return renders;
    },
    unmount() {
      mounted = false;
      for (const s of slots) if (typeof s.cleanup === 'function') s.cleanup();
    },
  };
}
