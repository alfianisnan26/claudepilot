/**
 * One read per session at a time (T-376). Opening a session reads the newest page in an effect that tears down and runs again whenever
 * React remounts it (StrictMode in development, a session change back and forth); the second run joins the read already in flight instead
 * of sending a second `GET .../events`. A settled read is forgotten, so a later open reads afresh.
 */
export function sharedRead<T>(read: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const inflight = new Map<string, Promise<T>>();
  return (key) => {
    const joined = inflight.get(key);
    if (joined) return joined;
    const p = read(key);
    inflight.set(key, p);
    const forget = () => {
      if (inflight.get(key) === p) inflight.delete(key);
    };
    p.then(forget, forget);
    return p;
  };
}
