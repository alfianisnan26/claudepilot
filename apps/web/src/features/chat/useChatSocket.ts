import { useToast } from '@isnanme/ui';
import {
  CHAT_SOCKET_PATH,
  type ChatAttachment,
  type ChatClientMessage,
  type ChatControl,
  type ChatEvent,
  type ChatInputState,
  type ChatRespond,
  type ChatSend,
  type ChatServerMessage,
  type ChatSession,
  type ChatSubscribe,
  type ChatTask,
} from '@portal/contracts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { chatApi } from './api';

/** The live partial assistant text for the open block, before it's stored as an event. */
export interface ChatDelta {
  agentLabel: string | null;
  text: string;
}

export interface ChatSendOptions {
  /** `next` steers the running turn; `later` runs it as its own turn after this one. */
  priority?: 'next' | 'later';
  attachments?: ChatAttachment[];
}

/** A message this tab sent that isn't in the stored transcript yet; shown at once so a send never looks lost. */
export interface ChatOutgoing {
  uuid: string;
  text: string;
  /** The attached images as `data:` URLs, for the thumbnails. */
  images: { src: string; name: string }[];
}

export type ChatControlOp = ChatControl['op'];
export type ChatControlArgs = NonNullable<ChatControl['args']>;

/** A send or control the portal refused: its ack's error, and its `code` when it gave one (e.g. `FOLDER_UNTRUSTED`). */
export class ChatAckError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ChatAckError';
  }
}

export interface ChatSessionApi {
  connected: boolean;
  /** Stored transcript, ordered and deduped by `seq`. */
  events: ChatEvent[];
  delta: ChatDelta | null;
  session: ChatSession | null;
  /** Where each message is in Claude Code's queue, by its uuid: this tab's sends plus every `input` update seen. */
  inputs: Map<string, ChatInputState>;
  /** Sent from this tab but not stored yet; the stored `user` event with the same uuid replaces it. */
  outbox: ChatOutgoing[];
  /** The session's sub-agents and background tasks (the full current list). */
  tasks: ChatTask[];
  /**
   * Sends a message. Settles on the portal's ack: rejects with its error (a `ChatAckError`), or when the
   * socket is down or drops first.
   */
  send: (text: string, opts?: ChatSendOptions) => Promise<void>;
  respond: (requestId: string, decision: 'allow' | 'allow_session' | 'deny', note?: string) => void;
  /** Sends a control op. Settles on its ack, so a picker can show "Unable to validate model" where it was used. */
  control: (op: ChatControlOp, args?: ChatControlArgs) => Promise<void>;
  stop: () => void;
  end: () => void;
}

/**
 * How long a control waits for its ack before giving up. Generous: the portal may first have to wake
 * the session's process, then wait for Claude Code's answer (validating a model takes a moment).
 */
const ACK_TIMEOUT_MS = 60_000;
const NOT_CONNECTED = 'Not connected. Try again in a moment.';

/** A send or control waiting for its `ack`, keyed by the uuid it went out with. */
interface Waiter {
  kind: 'send' | 'control';
  op?: ChatControlOp;
  resolve: () => void;
  reject: (e: Error) => void;
  timer?: number;
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
 * History and the task list are seeded over HTTP; after that the socket is the source of truth.
 * Sends and controls carry a client uuid and settle on the matching `ack`.
 */
export function useChatSession(sessionId: string): ChatSessionApi {
  const toast = useToast();
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [delta, setDelta] = useState<ChatDelta | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [inputs, setInputs] = useState<Map<string, ChatInputState>>(() => new Map());
  const [outbox, setOutbox] = useState<ChatOutgoing[]>([]);
  const [tasks, setTasks] = useState<ChatTask[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);
  const waitersRef = useRef(new Map<string, Waiter>());
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
    setInputs(new Map());
    setOutbox([]);
    setTasks([]);
    const waiters = new Map<string, Waiter>();
    waitersRef.current = waiters;

    let closed = false;
    let retry = 0;
    let opened = false;
    let timer: number | undefined;
    let ws: WebSocket | null = null;
    // Bumped by every live `tasks` message, so a list fetched before it never overwrites it.
    let tasksVersion = 0;

    const applyEvents = (items: ChatEvent[]) => {
      if (items.length === 0) return;
      for (const e of items) if (e.seq > seqRef.current) seqRef.current = e.seq;
      setEvents((prev) => mergeEvents(prev, items));
      // A finished assistant block or a turn result supersedes whatever the live delta was showing.
      if (items.some((e) => e.kind === 'assistant' || e.kind === 'result')) setDelta(null);
      // Stored now: the transcript shows the real event instead of the optimistic copy.
      const stored = new Set(items.flatMap((e) => (e.kind === 'user' && e.uuid ? [e.uuid] : [])));
      if (stored.size) setOutbox((o) => (o.some((x) => stored.has(x.uuid)) ? o.filter((x) => !stored.has(x.uuid)) : o));
    };

    const loadTasks = () => {
      const version = tasksVersion;
      chatApi.tasks(sessionId).then((list) => !closed && version === tasksVersion && setTasks(list), () => undefined);
    };

    // Seed the backlog, current state and tasks once; the socket keeps them fresh after that.
    void chatApi.history(sessionId).then((items) => !closed && applyEvents(items), () => undefined);
    void chatApi.get(sessionId).then((s) => !closed && setSession(s), () => undefined);
    loadTasks();

    const settle = (uuid: string, w: Waiter, ok: boolean, error?: string, code?: string) => {
      waiters.delete(uuid);
      window.clearTimeout(w.timer);
      if (ok) return w.resolve();
      if (w.kind === 'send') {
        setInputs((m) => new Map(m).set(uuid, 'failed'));
        setOutbox((o) => o.filter((x) => x.uuid !== uuid));
      }
      w.reject(new ChatAckError(error || 'That didn’t go through.', code));
    };

    // Sends and controls still waiting when the socket drops never get their ack: fail them now. A send
    // the portal did take still shows up when the transcript resumes, hence the advice.
    const dropWaiters = () => {
      if (waiters.size === 0) return;
      const sends = new Set<string>();
      for (const [uuid, w] of waiters) {
        window.clearTimeout(w.timer);
        if (w.kind === 'send') sends.add(uuid);
        w.reject(
          new Error(
            w.kind === 'send'
              ? 'The connection dropped before this was confirmed. Check the transcript before sending again.'
              : 'The connection dropped before this was confirmed.',
          ),
        );
      }
      waiters.clear();
      if (sends.size) {
        setOutbox((o) => o.filter((x) => !sends.has(x.uuid)));
        setInputs((m) => {
          const next = new Map(m);
          for (const uuid of sends) next.delete(uuid);
          return next;
        });
      }
    };

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
          // Deltas are pieces of the open block: append them (a new agent starts a new bubble).
          if (msg.session === sessionId)
            setDelta((d) => (d && d.agentLabel === msg.agentLabel ? { ...d, text: d.text + msg.text } : { agentLabel: msg.agentLabel, text: msg.text }));
          break;
        case 'session':
          if (msg.session.id === sessionId) setSession(msg.session);
          break;
        case 'input':
          if (msg.session === sessionId) setInputs((m) => (m.get(msg.uuid) === msg.state ? m : new Map(m).set(msg.uuid, msg.state)));
          break;
        case 'tasks':
          if (msg.session === sessionId) {
            tasksVersion++;
            setTasks(msg.tasks);
          }
          break;
        case 'ack': {
          const w = waiters.get(msg.uuid);
          if (w) {
            settle(msg.uuid, w, msg.ok, msg.error, msg.code);
            break;
          }
          // C1 portals key a control's ack by its op name; match those to the oldest waiter for that op.
          const byOp = [...waiters].find(([, x]) => x.kind === 'control' && x.op === msg.uuid);
          if (byOp) settle(byOp[0], byOp[1], msg.ok, msg.error, msg.code);
          else if (!msg.ok) toastRef.current(msg.error ?? 'That didn’t go through.', 'error');
          break;
        }
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
        // Tasks that changed while the socket was down were never pushed: fetch the list again.
        if (opened) loadTasks();
        opened = true;
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
        dropWaiters();
        if (!closed) timer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
      };
    };

    connect();

    return () => {
      closed = true;
      window.clearTimeout(timer);
      // Leaving: nobody is left to tell, so waiters are just forgotten.
      for (const w of waiters.values()) window.clearTimeout(w.timer);
      waiters.clear();
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
    (text: string, opts: ChatSendOptions = {}) =>
      new Promise<void>((resolve, reject) => {
        const ws = wsRef.current;
        if (ws?.readyState !== WebSocket.OPEN) return reject(new Error(NOT_CONNECTED));
        const uuid = crypto.randomUUID();
        const msg: ChatSend = { type: 'send', session: sessionId, uuid, text };
        if (opts.priority) msg.priority = opts.priority;
        const attachments = opts.attachments ?? [];
        if (attachments.length) msg.attachments = attachments;
        waitersRef.current.set(uuid, { kind: 'send', resolve, reject });
        setInputs((m) => new Map(m).set(uuid, 'sending'));
        const images = attachments.map((a) => ({ src: `data:${a.mediaType};base64,${a.dataBase64}`, name: a.name }));
        setOutbox((o) => [...o, { uuid, text, images }]);
        ws.send(JSON.stringify(msg));
      }),
    [sessionId],
  );

  const control = useCallback(
    (op: ChatControlOp, args?: ChatControlArgs) =>
      new Promise<void>((resolve, reject) => {
        const ws = wsRef.current;
        if (ws?.readyState !== WebSocket.OPEN) return reject(new Error(NOT_CONNECTED));
        const uuid = crypto.randomUUID();
        const waiters = waitersRef.current;
        const timer = window.setTimeout(() => {
          if (waiters.delete(uuid)) reject(new Error('The session didn’t answer. Try again.'));
        }, ACK_TIMEOUT_MS);
        waiters.set(uuid, { kind: 'control', op, resolve, reject, timer });
        const msg: ChatControl = { type: 'control', session: sessionId, op, uuid };
        if (args) msg.args = args;
        ws.send(JSON.stringify(msg));
      }),
    [sessionId],
  );

  const respond = useCallback(
    (requestId: string, decision: 'allow' | 'allow_session' | 'deny', note?: string) => {
      const msg: ChatRespond = { type: 'respond', session: sessionId, requestId, decision };
      if (note) msg.note = note;
      sendMessage(msg);
    },
    [sessionId, sendMessage],
  );
  const fail = useCallback((e: unknown) => toastRef.current(e instanceof Error ? e.message : 'That didn’t go through.', 'error'), []);
  const stop = useCallback(() => void control('stop').catch(fail), [control, fail]);
  const end = useCallback(() => void control('end').catch(fail), [control, fail]);

  return { connected, events, delta, session, inputs, outbox, tasks, send, respond, control, stop, end };
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
