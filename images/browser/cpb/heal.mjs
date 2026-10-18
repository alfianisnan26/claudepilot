// Two small guards for the browser image (T-921), kept apart from init.mjs and supervisor.mjs so a test can run them.
//
// 1. `safeKill` and `guardSignals`: the init runs as root with every capability dropped but SETUID and SETGID, so a `kill` of Chrome
//    (uid 1000) is refused with EPERM, which Node emits as an 'error' event, and an unhandled one inside a timer takes the init down
//    (T-921: Chrome crashed, the pod restarted). A failed signal is logged and never thrown; on EPERM the signal is sent again by a
//    helper running as Chrome's own uid.
// 2. `startWithHeal`: when Chrome does not come up with the request-headers extension, start it once more without, and say so.
//    Names and counts only; no header value passes through here.

const BENIGN = new Set(['ESRCH', 'EPERM']);
const LAST_SIGNAL = Symbol('cpb.lastSignal');

/**
 * Node's `ChildProcess.kill` does not throw a refused signal: it returns false and emits 'error' (syscall "kill", code EPERM). With no
 * listener left that 'error' throws from wherever `kill` was called, a timer included, and the init dies (T-921, init.mjs:161 at
 * 4a838735). This puts one persistent listener on `child`: a signal error is logged and, on EPERM, the last signal `safeKill` sent is
 * sent again through `asChrome(pid, signal)`; any other error (a failed spawn) goes to `onError`. Returns `child`.
 */
export function guardSignals(child, { name = 'child', log = () => {}, asChrome = null, onError = () => {} } = {}) {
  child.on('error', (e) => {
    if (e?.syscall !== 'kill') return onError(e);
    const signal = child[LAST_SIGNAL] ?? 'SIGTERM';
    log(`signal ${signal} to ${name} refused (${e.code ?? 'unknown'})`);
    if (e.code !== 'EPERM' || !asChrome || !child.pid) return;
    try {
      if (asChrome(child.pid, signal) !== true) log(`signal ${signal} to ${name} through the helper not delivered`);
    } catch (e2) {
      log(`signal ${signal} to ${name} through the helper failed: ${String(e2?.message ?? e2).slice(0, 100)}`);
    }
  });
  return child;
}

/**
 * Sends `signal` to `child` and never throws. `asChrome(pid, signal)` is the fallback for EPERM (the init passes a helper that runs as
 * Chrome's uid). Returns true when a signal was delivered.
 */
export function safeKill(child, signal, { log = () => {}, asChrome = null } = {}) {
  try {
    if (child && typeof child === 'object') child[LAST_SIGNAL] = signal;
    return child.kill(signal) !== false;
  } catch (e) {
    const code = e?.code ?? 'unknown';
    log(`kill ${signal} of pid ${child?.pid ?? '?'} failed (${code})${BENIGN.has(code) ? '' : `: ${String(e?.message ?? e).slice(0, 100)}`}`);
    if (code === 'EPERM' && asChrome && child?.pid) {
      try {
        return asChrome(child.pid, signal) === true;
      } catch (e2) {
        log(`kill ${signal} through the helper failed: ${String(e2?.message ?? e2).slice(0, 100)}`);
      }
    }
    return false;
  }
}

/**
 * Start Chrome, wait until it answers, and degrade once if it does not while headers were on.
 *
 * - `start({ headers })` → `{ pid, headers }`: `headers` true only when the extension was really passed to Chrome.
 * - `waitReady(started)` throws when Chrome does not answer in time.
 * - `stop()` ends the failed Chrome; `state.degradedAt` (ms, or 0) is kept by the caller between wakes, so for `cooldownMs` after a
 *   degrade the next wake starts without headers straight away, and after it the headers are tried again.
 * Returns `{ started, headers: 'on' | 'off' | 'degraded' }`; throws when even the second start fails.
 */
export async function startWithHeal({ start, waitReady, stop, state, now = Date.now, cooldownMs = 10 * 60_000, log = () => {} }) {
  const skip = state.degradedAt > 0 && now() - state.degradedAt < cooldownMs;
  const first = await start({ headers: !skip });
  try {
    await waitReady(first);
    if (!skip && first.headers) state.degradedAt = 0;
    return { started: first, headers: skip ? 'degraded' : first.headers ? 'on' : 'off' };
  } catch (e) {
    if (skip || first.headers !== true) throw e;
    log('headers disabled: Chrome did not start with them');
    await stop();
    state.degradedAt = now();
    const second = await start({ headers: false });
    await waitReady(second);
    return { started: second, headers: 'degraded' };
  }
}
