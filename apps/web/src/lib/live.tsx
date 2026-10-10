import { LIVE_PATH, type LiveMessage, type LiveTopic } from '@portal/contracts';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useAuth } from './auth';

type Handler = (msg: LiveMessage) => void;

/**
 * One WebSocket per tab to `/api/live`. Pages subscribe to topics and the portal pushes changes, so
 * nothing polls. Reconnects with backoff (1 s doubling to 30 s); after a reconnect, pages showing
 * accounts or storage reload, since changes made meanwhile weren't seen.
 */
class LiveClient {
  readonly #handlers = new Map<LiveTopic, Set<Handler>>();
  readonly #listeners = new Set<() => void>();
  #ws: WebSocket | null = null;
  #connected = false;
  #everConnected = false;
  #retry = 0;
  #timer: number | undefined;
  #running = false;

  start() {
    this.#running = true;
    this.#connect();
  }

  stop() {
    this.#running = false;
    window.clearTimeout(this.#timer);
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
    this.#setConnected(false);
  }

  get connected() {
    return this.#connected;
  }

  onConnectedChange(fn: () => void) {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  subscribe(topic: LiveTopic, handler: Handler) {
    let set = this.#handlers.get(topic);
    if (!set) {
      this.#handlers.set(topic, (set = new Set()));
      this.#sendTopics();
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0 && this.#handlers.get(topic) === set) {
        this.#handlers.delete(topic);
        this.#sendTopics();
      }
    };
  }

  #connect() {
    if (!this.#running) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${LIVE_PATH}`);
    this.#ws = ws;
    ws.onopen = () => {
      this.#retry = 0;
      this.#setConnected(true);
      this.#sendTopics();
      if (this.#everConnected) for (const type of ['accounts', 'system'] as const) this.#dispatch({ type });
      this.#everConnected = true;
    };
    ws.onmessage = (e) => {
      try {
        this.#dispatch(JSON.parse(String(e.data)) as LiveMessage);
      } catch {
        // not a message we know
      }
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#setConnected(false);
      if (this.#running) this.#timer = window.setTimeout(() => this.#connect(), Math.min(30_000, 1000 * 2 ** this.#retry++));
    };
  }

  #dispatch(msg: LiveMessage) {
    for (const h of this.#handlers.get(msg.type) ?? []) h(msg);
  }

  #sendTopics() {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ type: 'subscribe', topics: [...this.#handlers.keys()] }));
  }

  #setConnected(value: boolean) {
    if (this.#connected === value) return;
    this.#connected = value;
    for (const fn of this.#listeners) fn();
  }
}

const LiveContext = createContext<LiveClient | null>(null);

/** Opens the live socket while signed in. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const [client] = useState(() => new LiveClient());
  const signedIn = state.status === 'in';
  useEffect(() => {
    if (!signedIn) return;
    client.start();
    return () => client.stop();
  }, [client, signedIn]);
  return <LiveContext.Provider value={client}>{children}</LiveContext.Provider>;
}

/** Calls `handler` with each push on `topic` while mounted (and `enabled`). */
export function useLive<T extends LiveTopic>(topic: T, handler: (msg: Extract<LiveMessage, { type: T }>) => void, enabled = true) {
  const client = useContext(LiveContext);
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!client || !enabled) return;
    return client.subscribe(topic, (msg) => latest.current(msg as Extract<LiveMessage, { type: T }>));
  }, [client, topic, enabled]);
}

/** Whether the live socket is up; pages poll only while it isn't. */
export function useLiveConnected(): boolean {
  const client = useContext(LiveContext);
  return useSyncExternalStore(
    (fn) => client?.onConnectedChange(fn) ?? (() => undefined),
    () => client?.connected ?? false,
  );
}
