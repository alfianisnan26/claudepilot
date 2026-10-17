import { useToast } from '@isnanme/ui';
import {
  CHAT_SOCKET_PATH,
  type BtwClientMessage,
  type ChatAttachment,
  type ChatBtw,
  type ChatClientMessage,
  type ChatControl,
  type ChatEvent,
  type ChatFile,
  type ChatInputState,
  type ChatRespond,
  type ChatSend,
  type BtwServerMessage,
  type ChatServerMessage,
  type ChatSession,
  type ChatSubscribe,
  type ChatTask,
} from '@portal/contracts';
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { chatApi } from './api';
import { foldBtw, refusedBtw, type BtwState } from './btw/state';
import { appendLive, EMPTY_HISTORY, expand, olderDone, olderFailed, olderStart, seed, seedAll, type History } from './history';
import { createDeltaBatcher, foldLive, NO_LIVE, settleLive, type AgentLive, type LiveState } from './motion/deltas';
import { ListPager } from './listPaging';
import { sharedRead } from './sharedRead';

/** The newest page, one read in flight per session: a remounted effect (StrictMode in dev) joins it instead of reading again. */
const newestPage = sharedRead((id: string) => chatApi.page(id));

/** The live partial assistant text for the open block, before it's stored as an event. */
export interface ChatDelta {
  agentLabel: string | null;
  text: string;
  /** A thinking block is open (its text isn't streamed); `since` is when this tab heard it start. */
  thinking?: { since: number };
}

export interface ChatSendOptions {
  /** `next` steers the running turn; `later` runs it as its own turn after this one. */
  priority?: 'next' | 'later';
  attachments?: ChatAttachment[];
  /** What the transcript shows for the attachments until the stored message replaces it (files already uploaded, so nothing is read from `attachments`). */
  shown?: { images: { src: string; name: string; width?: number; height?: number }[]; files: ChatFile[] };
}

/** A message this tab sent that isn't in the stored transcript yet; shown at once so a send never looks lost. */
export interface ChatOutgoing {
  uuid: string;
  text: string;
  /** The attached images, for the thumbnails (a `data:` URL for one sent inline, else where the portal serves it). */
  images: { src: string; name: string; width?: number; height?: number }[];
  /** The other files attached. */
  files: ChatFile[];
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

/** Where the transcript's pages stand (T-376, history.ts). */
export interface ChatPaging {
  /** The newest page is in. */
  seeded: boolean;
  /** Older events exist than the first one held (false: the start of the chat is held). */
  more: boolean;
  older: History['older'];
}

export interface ChatSessionApi {
  connected: boolean;
  /** Stored transcript held, ordered and deduped by `seq`: the newest page, the older pages read since, and what came live. */
  events: ChatEvent[];
  paging: ChatPaging;
  /** Reads the page before the first event held; a no-op while one is read or at the start. */
  loadOlder: () => void;
  /** Reads one event whole (a `tool_result` a page cut to its preview) and puts it in its preview's place. */
  loadWhole: (seq: number) => Promise<void>;
  /** The main agent's live reply (a sub-agent's never shows here). */
  delta: ChatDelta | null;
  /** What each sub-agent is writing right now, by its Task call (`ChatTask.toolUseId`). */
  agentLive: ReadonlyMap<string, AgentLive>;
  session: ChatSession | null;
  /** The session was deleted (here or in another tab), or never existed. */
  removed: boolean;
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
  /** The side question card (btw): the newest one, null when none is open. */
  btw: ChatBtw | null;
  /** Asks one; the card shows at once and fills as the portal streams. */
  btwAsk: (question: string) => void;
  btwCancel: () => void;
  /** Closes the card (stops it when still running). */
  btwClose: () => void;
  /** Pins the answered card to the transcript; rejects with the portal's reason. */
  btwPin: () => Promise<void>;
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

/**
 * One dedicated WebSocket for the open session, mirroring `lib/live.tsx`: it opens on mount, closes
 * on unmount, and reconnects with exponential backoff (1 s doubling to 30 s). On every connect it
 * resubscribes from the highest `seq` it has seen, so a dropped connection resumes without gaps.
 * The transcript is seeded over HTTP with its newest page only (T-376, history.ts), and the socket subscribes after that page's newest
 * event (a subscribe without one sends the whole backlog); older pages are read as the reader scrolls up (`loadOlder`). The task list
 * is seeded over HTTP too; after that the socket is the source of truth.
 * Sends and controls carry a client uuid and settle on the matching `ack`.
 */
export function useChatSession(sessionId: string): ChatSessionApi {
  const toast = useToast();
  const [connected, setConnected] = useState(false);
  const [hist, setHist] = useState<History>(EMPTY_HISTORY);
  const histRef = useRef(hist);
  histRef.current = hist;
  /** Bumped per session: a page or an event read for the session before is dropped. */
  const generation = useRef(0);
  const [live, setLive] = useState<LiveState>(NO_LIVE);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [removed, setRemoved] = useState(false);
  const [inputs, setInputs] = useState<Map<string, ChatInputState>>(() => new Map());
  const [outbox, setOutbox] = useState<ChatOutgoing[]>([]);
  const [tasks, setTasks] = useState<ChatTask[]>([]);
  const [btwState, setBtwState] = useState<BtwState>(null);
  /** Ids of the btw asks this tab made: a refusing `ack` is keyed by one of them. */
  const btwAsked = useRef(new Map<string, { id: string; session: string; question: string; askedAt: string }>());
  const btwRef = useRef<ChatBtw | null>(null);
  btwRef.current = btwState?.item ?? null;
  /** A btw_delta applied once per frame (the same reason as the main deltas). */
  const btwPending = useRef<{ msgs: BtwServerMessage[]; frame: number }>({ msgs: [], frame: 0 });

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
    generation.current++;
    histRef.current = EMPTY_HISTORY;
    setHist(EMPTY_HISTORY);
    setLive(NO_LIVE);
    setSession(null);
    setRemoved(false);
    setInputs(new Map());
    setOutbox([]);
    setTasks([]);
    setBtwState(null);
    btwAsked.current.clear();
    const waiters = new Map<string, Waiter>();
    waitersRef.current = waiters;
    // Deltas are applied once per frame, not once per message (each one re-renders the whole page).
    const deltas = createDeltaBatcher((messages) => setLive((l) => messages.reduce<LiveState>(foldLive, l)));

    let closed = false;
    let retry = 0;
    let opened = false;
    let timer: number | undefined;
    let ws: WebSocket | null = null;
    // Bumped by every live `tasks` message, so a list fetched before it never overwrites it.
    let tasksVersion = 0;

    const applyEvents = (items: ChatEvent[]) => {
      if (items.length === 0) return;
      deltas.flush(); // the deltas first, then whatever supersedes them
      for (const e of items) if (e.seq > seqRef.current) seqRef.current = e.seq;
      setHist((h) => appendLive(h, items));
      // A finished block or a turn result supersedes what was live, each agent's its own (settleLive).
      setLive((l) => settleLive(l, items));
      // Stored now: the transcript shows the real event instead of the optimistic copy.
      const stored = new Set(items.flatMap((e) => (e.kind === 'user' && e.uuid ? [e.uuid] : [])));
      if (stored.size) setOutbox((o) => (o.some((x) => stored.has(x.uuid)) ? o.filter((x) => !stored.has(x.uuid)) : o));
    };

    const loadTasks = () => {
      const version = tasksVersion;
      chatApi.tasks(sessionId).then(
        (list) => !closed && version === tasksVersion && setTasks(list),
        () => undefined,
      );
    };

    // Seed the newest page, the current state and tasks once; the socket keeps them fresh after that. The socket subscribes only once the
    // page is in, after its newest event: a subscribe without `afterSeq` sends the whole backlog. A page that cannot be read falls back
    // to exactly that (as before T-376), so the chat still shows.
    let seeded = false;
    void newestPage(sessionId).then(
      (page) => {
        if (closed) return;
        seeded = true;
        for (const e of page.events) if (e.seq > seqRef.current) seqRef.current = e.seq;
        // A transition (T-376 S4): the page's rows render in slices the browser can interrupt, not as one 450 ms task at 4x CPU.
        startTransition(() => setHist((h) => seed(h, page)));
        subscribe();
      },
      () => {
        if (closed) return;
        seeded = true;
        setHist(seedAll);
        subscribe();
      },
    );
    void chatApi.get(sessionId).then(
      (s) => !closed && setSession(s),
      () => undefined,
    );
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
      if (!seeded || ws?.readyState !== WebSocket.OPEN) return;
      const msg: ChatSubscribe = { type: 'subscribe', session: sessionId };
      if (seqRef.current > 0) msg.afterSeq = seqRef.current;
      ws.send(JSON.stringify(msg));
    };

    const flushBtw = () => {
      const q = btwPending.current;
      cancelAnimationFrame(q.frame);
      q.frame = 0;
      const msgs = q.msgs.splice(0);
      if (msgs.length) setBtwState((s) => msgs.reduce<BtwState>((acc, m) => foldBtw(acc, m), s));
    };

    const handle = (msg: ChatServerMessage) => {
      switch (msg.type) {
        case 'events':
          if (msg.session === sessionId) applyEvents(msg.items);
          break;
        case 'delta':
          // Pieces of the open block, appended (see foldDelta); a thinking start shows as "Thinking…" until the block is stored.
          if (msg.session === sessionId) deltas.push(msg);
          break;
        case 'session':
          if (msg.session.id === sessionId) setSession(msg.session);
          break;
        case 'removed':
          if (msg.session === sessionId) setRemoved(true);
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
        case 'btw':
          if (msg.session === sessionId) {
            flushBtw();
            setBtwState((s) => foldBtw(s, msg));
          }
          break;
        case 'btw_delta':
          if (msg.session === sessionId) {
            const q = btwPending.current;
            q.msgs.push(msg);
            if (!q.frame) q.frame = requestAnimationFrame(flushBtw);
          }
          break;
        case 'ack': {
          const asked = btwAsked.current.get(msg.uuid);
          if (asked && !msg.ok) {
            flushBtw();
            setBtwState((s) => (s && s.item.id !== asked.id ? s : { item: refusedBtw(asked, msg.code, msg.error), seq: 0 }));
            break;
          }
          if (asked) break;
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
      deltas.cancel();
      cancelAnimationFrame(btwPending.current.frame);
      btwPending.current = { msgs: [], frame: 0 };
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
        const images =
          opts.shown?.images ??
          attachments.flatMap((a) => ('dataBase64' in a ? [{ src: `data:${a.mediaType};base64,${a.dataBase64}`, name: a.name }] : []));
        setOutbox((o) => [...o, { uuid, text, images, files: opts.shown?.files ?? [] }]);
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
  const sendBtw = useCallback((msg: BtwClientMessage) => sendMessage(msg), [sendMessage]);
  const btwAsk = useCallback(
    (question: string) => {
      const q = question.trim();
      if (!q) return;
      const prev = btwRef.current;
      if (prev) sendBtw({ type: 'btw_close', session: sessionId, btw: prev.id });
      const base = { id: crypto.randomUUID(), session: sessionId, question: q, askedAt: new Date().toISOString() };
      btwAsked.current.set(base.id, base);
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        setBtwState({ item: { ...base, status: 'failed', answer: '', reason: 'workspace', note: NOT_CONNECTED }, seq: 0 });
        return;
      }
      setBtwState({ item: { ...base, status: 'running', answer: '' }, seq: 0 });
      sendBtw({ type: 'btw_ask', session: sessionId, btw: base.id, question: q });
    },
    [sessionId, sendBtw],
  );
  const btwCancel = useCallback(() => {
    const b = btwRef.current;
    if (b) sendBtw({ type: 'btw_cancel', session: sessionId, btw: b.id });
  }, [sessionId, sendBtw]);
  const btwClose = useCallback(() => {
    const b = btwRef.current;
    if (b) sendBtw({ type: 'btw_close', session: sessionId, btw: b.id });
    setBtwState(null);
  }, [sessionId, sendBtw]);
  const btwPin = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        const b = btwRef.current;
        const ws = wsRef.current;
        if (!b) return resolve();
        if (ws?.readyState !== WebSocket.OPEN) return reject(new Error(NOT_CONNECTED));
        const uuid = crypto.randomUUID();
        waitersRef.current.set(uuid, { kind: 'control', resolve, reject });
        ws.send(JSON.stringify({ type: 'btw_pin', session: sessionId, btw: b.id, uuid } satisfies BtwClientMessage));
      }),
    [sessionId],
  );
  // The page before the first event held (T-376): one at a time, dropped when the session changed meanwhile.
  const loadOlder = useCallback(() => {
    const h = histRef.current;
    const next = olderStart(h);
    if (!next || h.before === null) return;
    const before = h.before;
    const gen = generation.current;
    histRef.current = next; // a second call before the render sees it loading
    setHist((cur) => olderStart(cur) ?? cur);
    chatApi.page(sessionId, before).then(
      (page) => gen === generation.current && startTransition(() => setHist((cur) => olderDone(cur, before, page))),
      () => gen === generation.current && setHist(olderFailed),
    );
  }, [sessionId]);
  // A preview opened: the whole event takes its place. Rejects with the portal's error for the caller to show.
  const loadWhole = useCallback(
    async (seq: number) => {
      const gen = generation.current;
      const whole = await chatApi.event(sessionId, seq);
      if (gen === generation.current) setHist((h) => expand(h, whole));
    },
    [sessionId],
  );
  const fail = useCallback((e: unknown) => toastRef.current(e instanceof Error ? e.message : 'That didn’t go through.', 'error'), []);
  const stop = useCallback(() => void control('stop').catch(fail), [control, fail]);
  const end = useCallback(() => void control('end').catch(fail), [control, fail]);

  const paging = useMemo<ChatPaging>(
    () => ({ seeded: hist.seeded, more: hist.more, older: hist.older }),
    [hist.seeded, hist.more, hist.older],
  );
  return {
    connected,
    events: hist.events,
    paging,
    loadOlder,
    loadWhole,
    delta: live.main,
    agentLive: live.agents,
    session,
    removed,
    inputs,
    outbox,
    tasks,
    btw: btwState?.item ?? null,
    btwAsk,
    btwCancel,
    btwClose,
    btwPin,
    send,
    respond,
    control,
    stop,
    end,
  };
}

export interface ChatListApi {
  sessions: ChatSession[] | null;
  failed: boolean;
  /** Reloads from the newest page (older pages already loaded are dropped). */
  reload: () => Promise<void>;
  /** An older page is there to load (D-58). */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
}

const LIST_PAGE = 50;

/**
 * The session list (D-58: pages): the newest page, a slow 5 s poll of that first page only, and `loadMore` for the older ones. The poll keeps
 * the older pages already loaded only while the seam under page 1 holds (`keepsOlder`), else it drops them; a refused cursor starts over
 * from page 1; a failed poll keeps the last list on screen.
 */
export function useChatList(): ChatListApi {
  // The paging rules live in ListPager (listPaging.ts, tested); the hook holds it and re-renders when it changes.
  const pager = useRef(new ListPager<ChatSession>());
  const [, setTick] = useState(0);
  const render = () => setTick((n) => n + 1);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const reload = useCallback(async () => {
    setFailed(false);
    try {
      const page = await chatApi.list({ limit: LIST_PAGE });
      pager.current.restart();
      pager.current.applyHead(page);
      setTick((n) => n + 1);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    // The poll refreshes page 1. The older pages stay only while the seam under page 1 did not move (`keepsOlder`): else a row would be in neither list.
    const t = setInterval(
      () =>
        void chatApi.list({ limit: LIST_PAGE }).then(
          (page) => {
            pager.current.applyHead(page);
            setTick((n) => n + 1);
          },
          () => undefined,
        ),
      5_000,
    );
    return () => clearInterval(t);
  }, [reload]);

  const loadMore = useCallback(async () => {
    const ticket = pager.current.beginMore();
    if (!ticket) return;
    setLoadingMore(true);
    try {
      const page = await chatApi.list({ limit: LIST_PAGE, cursor: ticket.cursor });
      // A page that lands after a poll dropped the older pages is stale: finishMore refuses it.
      if (pager.current.finishMore(ticket, page)) render();
    } catch (e) {
      // A refused cursor (a restart ended it) never works again: start over from page 1. Any other failure leaves the button, and a tap tries again.
      if (pager.current.failMore(ticket, e) === 'restart') await reload();
    } finally {
      setLoadingMore(false);
    }
  }, [reload]);

  const sessions = pager.current.items;

  return { sessions, failed, reload, hasMore: pager.current.next !== null, loadingMore, loadMore };
}
