import { CHAT_SOCKET_PATH, type ChatClientMessage, type ChatServerMessage } from '@portal/contracts';

// What the glance widgets do to a chat session (answer an approval, stop an agent): the chat socket's own messages, sent over a short
// connection of their own and settled on the portal's ack. There is no glance route for this on purpose: `controller.respond` and
// `controller.control` already hold every rule (the request must still be open, the chat must not be moving, Bypass and its re-check
// are separate calls this file never makes), and a second path would have to repeat them.

/** The part of a WebSocket a call uses, so a test can stand one in. */
export interface SocketLike {
  readyState: number;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface CallDeps {
  open?: (url: string) => SocketLike;
  url?: string;
  timeoutMs?: number;
  newId?: () => string;
}

/** A call the portal refused or that did not complete: its message, and the portal's `code` when it gave one. */
export class CallError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CallError';
  }
}

/** How long an answer to a request waits for its ack. */
export const RESPOND_TIMEOUT_MS = 20_000;
/** A stop may first wait for the turn's process to answer (the session page allows a minute). */
export const STOP_TIMEOUT_MS = 60_000;

const defaultUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${CHAT_SOCKET_PATH}`;
const defaultOpen = (url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;
const defaultId = () => crypto.randomUUID();

/** Sends one chat-socket message and settles on the portal's `ack` for `ackKey` (or its `error` for that session). Closes the connection after. */
export function callChat(message: ChatClientMessage, ackKey: string, deps: CallDeps = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = (deps.open ?? defaultOpen)(deps.url ?? defaultUrl());
    let settled = false;
    const finish = (error: CallError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {
        // already gone
      }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new CallError('The portal did not answer. Check the agent before trying again.')), deps.timeoutMs ?? RESPOND_TIMEOUT_MS);
    socket.onopen = () => socket.send(JSON.stringify(message));
    socket.onmessage = (e) => {
      let msg: ChatServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ChatServerMessage;
      } catch {
        return; // not a message we know
      }
      if (msg.type === 'ack' && msg.uuid === ackKey) finish(msg.ok ? null : new CallError(msg.error || 'That did not go through.', msg.code));
      else if (msg.type === 'error' && (!msg.session || msg.session === message.session)) finish(new CallError(msg.message || 'That did not go through.'));
    };
    socket.onerror = () => finish(new CallError('Could not reach the portal.'));
    socket.onclose = () => finish(new CallError('The connection dropped before this was confirmed.'));
  });
}

/** Allow or deny one open request: the same `respond` message the session page's approval card sends. */
export function respondTo(sessionId: string, requestId: string, decision: 'allow' | 'deny', deps?: CallDeps): Promise<void> {
  return callChat({ type: 'respond', session: sessionId, requestId, decision }, requestId, deps);
}

/** Stop: the session's turn is interrupted (the composer's Stop). */
export function stopSession(sessionId: string, deps: CallDeps = {}): Promise<void> {
  const uuid = (deps.newId ?? defaultId)();
  return callChat({ type: 'control', session: sessionId, op: 'stop', uuid }, uuid, { timeoutMs: STOP_TIMEOUT_MS, ...deps });
}

/** Stop one running sub-agent or background task of a session (the Agents panel's Stop). */
export function stopTask(sessionId: string, taskId: string, deps: CallDeps = {}): Promise<void> {
  const uuid = (deps.newId ?? defaultId)();
  return callChat({ type: 'control', session: sessionId, op: 'stop_task', uuid, args: { taskId } }, uuid, { timeoutMs: STOP_TIMEOUT_MS, ...deps });
}
