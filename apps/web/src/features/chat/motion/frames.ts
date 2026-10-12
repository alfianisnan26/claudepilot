/**
 * One animation-frame loop for everything in the chat that moves per frame: the reply's reveal and the
 * transcript following it. They share a frame and run in a fixed order (the reveal changes the page, the
 * follower then reads the new height and scrolls), so a word and the scroll that follows it land in the same
 * paint instead of a frame apart. The loop sleeps when no task is awake.
 */
export interface FrameTask {
  /** Runs the task on the next frame (and on each one after, while it returns `true`). */
  wake(): void;
  /** Takes the task out for good. */
  dispose(): void;
}

interface Entry {
  order: number;
  run: (now: number, dt: number) => boolean;
  awake: boolean;
}

export interface FrameSource {
  request: (cb: (now: number) => void) => number;
  cancel: (id: number) => void;
}

const entries: Entry[] = [];
let raf = 0;
let last = 0;
let source: FrameSource | null = null;

const browser: FrameSource = { request: (cb) => requestAnimationFrame(cb), cancel: (id) => cancelAnimationFrame(id) };

/** Tests drive the loop with a fake frame source. */
export function setFrameSource(next: FrameSource | null): void {
  if (raf) (source ?? browser).cancel(raf);
  raf = 0;
  last = 0;
  source = next;
}

function tick(now: number): void {
  raf = 0;
  const dt = last ? Math.min(now - last, 250) : 16.7;
  last = now;
  let again = false;
  // Copy: a task may dispose itself (or another) while it runs.
  for (const e of entries.slice()) {
    if (!e.awake) continue;
    e.awake = e.run(now, dt);
    again ||= e.awake;
  }
  if (again) raf = (source ?? browser).request(tick);
  else last = 0;
}

/**
 * Registers a task. `run(now, dt)` returns whether it wants the next frame too; `order` sets who runs first
 * within a frame (lower first).
 */
export function frameTask(order: number, run: (now: number, dt: number) => boolean): FrameTask {
  const entry: Entry = { order, run, awake: false };
  entries.push(entry);
  entries.sort((a, b) => a.order - b.order);
  return {
    wake() {
      entry.awake = true;
      if (!raf) raf = (source ?? browser).request(tick);
    },
    dispose() {
      entry.awake = false;
      const i = entries.indexOf(entry);
      if (i >= 0) entries.splice(i, 1);
    },
  };
}
