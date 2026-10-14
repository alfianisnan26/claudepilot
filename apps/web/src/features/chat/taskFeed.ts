// What the Agents panel needs from the transcript (ticket T-149): the call behind each task (a background command's command line, which
// its task carries only when Claude gave no description, cut to 200 characters) and each sub-agent's own rows (its latest line). The panel
// sits beside the transcript, not inside it, so the transcript publishes these per session and the panel reads them: the transcript never
// renders again for the panel, and the panel renders for them only while it is open.
import type { ChatEvent, ChatTask } from '@portal/contracts';
import { useCallback, useSyncExternalStore } from 'react';
import type { TranscriptRow } from './ToolRows';

export interface TaskFeed {
  /** The call that started each task, by its tool_use id (`ChatTask.toolUseId`). */
  calls: ReadonlyMap<string, ChatEvent>;
  /** Each sub-agent's own rows, by the call that started it (`buildItems`'s `agentRows`). */
  rows: ReadonlyMap<string, TranscriptRow[]>;
}

const EMPTY: TaskFeed = { calls: new Map(), rows: new Map() };
const feeds = new Map<string, TaskFeed>();
const listeners = new Map<string, Set<() => void>>();

/** Sets a session's feed (null when its transcript goes away) and tells its readers. */
export function publishTaskFeed(sessionId: string, feed: TaskFeed | null): void {
  const was = feeds.get(sessionId);
  if (feed === null) {
    if (!was) return;
    feeds.delete(sessionId);
  } else {
    if (was && was.calls === feed.calls && was.rows === feed.rows) return;
    feeds.set(sessionId, feed);
  }
  for (const l of listeners.get(sessionId) ?? []) l();
}

/** A session's feed: empty until its transcript publishes one. */
export function useTaskFeed(sessionId: string): TaskFeed {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let set = listeners.get(sessionId);
      if (!set) listeners.set(sessionId, (set = new Set()));
      set.add(onChange);
      return () => {
        set.delete(onChange);
        if (!set.size) listeners.delete(sessionId);
      };
    },
    [sessionId],
  );
  const read = useCallback(() => feeds.get(sessionId) ?? EMPTY, [sessionId]);
  return useSyncExternalStore(subscribe, read, read);
}

/** The calls that started the tasks, by tool_use id: the newest call of each id, from the main flow or a sub-agent's. */
export function taskCalls(events: readonly ChatEvent[], tasks: readonly ChatTask[]): ReadonlyMap<string, ChatEvent> {
  const wanted = new Set(tasks.flatMap((t) => (t.toolUseId ? [t.toolUseId] : [])));
  const out = new Map<string, ChatEvent>();
  if (!wanted.size) return out;
  for (const e of events) if (e.kind === 'tool_use' && e.toolUseId && wanted.has(e.toolUseId)) out.set(e.toolUseId, e);
  return out;
}
