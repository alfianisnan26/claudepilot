import { useToast } from '@isnanme/ui';
import {
  CHAT_SOCKET_PATH,
  type ChatClientMessage,
  type ChatEvent,
  type ChatRespond,
  type ChatSend,
  type ChatServerMessage,
  type ChatSession,
  type ChatSubscribe,
} from '@portal/contracts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { chatApi } from './api';

/** The live partial assistant text for the open block, before it's stored as an event. */
export interface ChatDelta {
  agentLabel: string | null;
  text: string;
}

export interface ChatSessionApi {
  connected: boolean;
  /** Stored transcript, ordered and deduped by `seq`. */
  events: ChatEvent[];
  delta: ChatDelta | null;
  session: ChatSession | null;
  send: (text: string, opts?: { priority?: 'next' | 'later' }) => void;
  respond: (requestId: string, decision: 'allow' | 'allow_session' | 'deny', note?: string) => void;
  stop: () => void;
  end: () => void;
}

/** Merge a batch into the transcript, deduped by `seq` and kept in order. */
function mergeEvents(prev: ChatEvent[], incoming: ChatEvent[]): ChatEvent[] {
  if (incoming.length === 0) return prev;
  const bySeq = new Map(prev.map((e) => [e.seq, e]));
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * One dedicated WebSocket for the open session, mirroring `lib/live.tsx`: it opens on mount, closes
 * on unmount, and reconnects with exponential backoff (1 s doubling to 30 s). On every connect it
 * resubscribes from the highest `seq` it has seen, so a dropped connection resumes without gaps.
 * History is seeded once over HTTP; after that the socket is the source of truth.
 */
export function useChatSession(sessionId: string): ChatSessionApi {
  const toast = useToast();
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [delta, setDelta] = useState<ChatDelta | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);
  // Keep toast off the effect deps so a new snackbar never tears down the socket.
  const toastRef = useRef(toast);
  useLayoutEffect(() => {
    toastRef.current = toast;
  });

  useEffect(() => {
    seqRef.current = 0;
    setEvents([]);
    setDelta(null);
    setSession(null);

    let closed = false;
    let retry = 0;
    let timer: number | undefined;
    let ws: WebSocket | null = null;

    const applyEvents = (items: ChatEvent[]) => {
      if (items.length === 0) return;
      for (const e of items) if (e.seq > seqRef.current) seqRef.current = e.seq;
      setEvents((prev) => mergeEvents(prev, items));
      // A finished assistant block or a turn result supersedes whatever the live delta was showing.
      if (items.some((e) => e.kind === 'assistant' || e.kind === 'result')) setDelta(null);
    };

    // Seed the backlog and current state once; the socket keeps them fresh after that.
    void chatApi.history(sessionId).then((items) => !closed && applyEvents(items), () => undefined);
    void chatApi.get(sessionId).then((s) => !closed && setSession(s), () => undefined);

    const subscribe = () => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      const msg: ChatSubscribe = { type: 'subscribe', session: sessionId };
      if (seqRef.current > 0) msg.afterSeq = seqRef.current;
      ws.send(JSON.stringify(msg));
    };

    const handle = (msg: ChatServerMessage) => {
      switch (msg.type) {
        case 'events':
          if (msg.session === sessionId) applyEvents(msg.items);
          break;
        case 'delta':
          if (msg.session === sessionId) setDelta({ agentLabel: msg.agentLabel, text: msg.text });
          break;
        case 'session':
          if (msg.session.id === sessionId) setSession(msg.session);
          break;
        case 'ack':
          if (!msg.ok) toastRef.current(msg.error ?? 'That didn’t go through.', 'error');
          break;
        case 'error':
          if (!msg.session || msg.session === sessionId) toastRef.current(msg.message, 'error');
          break;
      }
    };

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}${CHAT_SOCKET_PATH}`);
      ws = sock;
      wsRef.current = sock;
      sock.onopen = () => {
        retry = 0;
        setConnected(true);
        subscribe();
      };
      sock.onmessage = (e) => {
        let msg: ChatServerMessage;
        try {
          msg = JSON.parse(String(e.data)) as ChatServerMessage;
        } catch {
          return; // not a message we know
        }
        handle(msg);
      };
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        wsRef.current = null;
        setConnected(false);
        if (!closed) timer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
      };
    };

    connect();

    return () => {
      closed = true;
      window.clearTimeout(timer);
      const sock = ws;
      ws = null;
      wsRef.current = null;
      sock?.close();
      setConnected(false);
    };
  }, [sessionId]);

  // Fire-and-forget while the socket is up; a no-op when it's down (the caller watches `connected`).
  const sendMessage = useCallback((msg: ChatClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const send = useCallback(
    (text: string, opts?: { priority?: 'next' | 'later' }) => {
      const msg: ChatSend = { type: 'send', session: sessionId, uuid: crypto.randomUUID(), text };
      if (opts?.priority) msg.priority = opts.priority;
      sendMessage(msg);
    },
    [sessionId, sendMessage],
  );
  const respond = useCallback(
    (requestId: string, decision: 'allow' | 'allow_session' | 'deny', note?: string) => {
      const msg: ChatRespond = { type: 'respond', session: sessionId, requestId, decision };
      if (note) msg.note = note;
      sendMessage(msg);
    },
    [sessionId, sendMessage],
  );
  const stop = useCallback(() => sendMessage({ type: 'control', session: sessionId, op: 'stop' }), [sessionId, sendMessage]);
  const end = useCallback(() => sendMessage({ type: 'control', session: sessionId, op: 'end' }), [sessionId, sendMessage]);

  return { connected, events, delta, session, send, respond, stop, end };
}

export interface ChatListApi {
  sessions: ChatSession[] | null;
  failed: boolean;
  reload: () => Promise<void>;
}

/** The session list with a slow 5 s poll; a failed poll keeps the last list on screen. */
export function useChatList(): ChatListApi {
  const [sessions, setSessions] = useState<ChatSession[] | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    setFailed(false);
    try {
      setSessions(await chatApi.list());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void chatApi.list().then(setSessions, () => undefined), 5_000);
    return () => clearInterval(t);
  }, [reload]);

  return { sessions, failed, reload };
}
