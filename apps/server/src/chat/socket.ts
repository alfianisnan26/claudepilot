// Chat sessions: the browser WebSocket (chat-sessions PRD §10.5). One per tab, on CHAT_SOCKET_PATH,
// authorized like the shell socket (same origin + the session cookie). It subscribes tabs to sessions,
// forwards the controller's live events to them, and relays send/respond/control back to the controller.

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { isAppError } from '@isnanme/core';
import { CHAT_SOCKET_PATH, type ChatClientMessage, type ChatServerMessage } from '@portal/contracts';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ChatController } from './controller.js';

const PING_MS = 25_000;
/**
 * 24 MB: room for a send with the most images allowed (CHAT_MAX_IMAGES × CHAT_MAX_IMAGE_BYTES, about
 * 20 MB once base64-encoded) plus its JSON. The web app relies on it; per-message checks are the real guard.
 */
const MAX_PAYLOAD = 24 * 1024 * 1024;

/** Browsers send cookies on cross-site WebSocket handshakes, so the origin must be this host. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function refuse(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const errMessage = (e: unknown): string => (isAppError(e) ? e.message : e instanceof Error ? e.message : String(e));

/** A refused send, respond or control: its message, and its code when it has one (`FOLDER_UNTRUSTED` asks for the trust sheet). */
function refused(uuid: string, e: unknown): ChatServerMessage {
  const ack: Extract<ChatServerMessage, { type: 'ack' }> = { type: 'ack', uuid, ok: false, error: errMessage(e) };
  if (isAppError(e)) ack.code = e.code;
  return ack;
}

/**
 * Attaches the chat socket to the HTTP server. `authorized` is checked after the same-origin check,
 * exactly like the shell socket (so pass the session-cookie check through it).
 */
export function attachChat(server: Server, controller: ChatController, authorized: (req: IncomingMessage) => boolean) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== CHAT_SOCKET_PATH) return; // not ours (shell, live, or Vite HMR)
    if (!sameOrigin(req)) return refuse(socket, 403, 'Forbidden');
    if (!authorized(req)) return refuse(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => join(ws));
  });

  function join(ws: WebSocket) {
    const subscribed = new Set<string>();
    const send = (msg: ChatServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    // Forward the controller's live updates (events, deltas, session, input states, tasks) for watched sessions.
    const off = controller.onEvent((sessionId, msg) => {
      if (subscribed.has(sessionId)) send(msg);
    });

    let alive = true;
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, PING_MS);
    ws.on('pong', () => (alive = true));

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: ChatClientMessage;
      try {
        msg = JSON.parse(String(data)) as ChatClientMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      void handle(msg).catch((e: unknown) => send({ type: 'error', session: typeof msg.session === 'string' ? msg.session : undefined, message: errMessage(e) }));
    });
    ws.on('close', () => {
      clearInterval(ping);
      off();
    });
    ws.on('error', () => ws.terminate());

    async function handle(msg: ChatClientMessage) {
      switch (msg.type) {
        case 'subscribe': {
          subscribed.add(msg.session);
          // Backlog first (stored events after the tab's last seq), then live updates flow via `off`.
          const items = controller.history(msg.session, msg.afterSeq ?? 0);
          if (items.length) send({ type: 'events', session: msg.session, items });
          const session = controller.get(msg.session);
          if (session) {
            // A running process gets its reader back if it lost it (after a restart, say).
            controller.attach(msg.session);
            send({ type: 'session', session });
            send({ type: 'tasks', session: msg.session, tasks: controller.tasks(msg.session) });
            // Queued, withdrawn and failed messages: what the transcript alone can't tell a fresh tab.
            for (const input of controller.inputStates(msg.session)) send({ type: 'input', session: msg.session, uuid: input.uuid, state: input.state });
          }
          return;
        }
        case 'unsubscribe':
          subscribed.delete(msg.session);
          return;
        case 'send':
          try {
            await controller.send(msg.session, msg.uuid, msg.text, { priority: msg.priority, attachments: msg.attachments, actor: 'ui' });
            send({ type: 'ack', uuid: msg.uuid, ok: true });
          } catch (e) {
            send(refused(msg.uuid, e));
          }
          return;
        case 'respond':
          try {
            await controller.respond(msg.session, msg.requestId, msg.decision, { note: msg.note, actor: 'ui' });
            send({ type: 'ack', uuid: msg.requestId, ok: true });
          } catch (e) {
            send(refused(msg.requestId, e));
          }
          return;
        case 'control': {
          const key = typeof msg.uuid === 'string' && msg.uuid ? msg.uuid : String(msg.op);
          try {
            await controller.control(msg.session, msg.op, msg.args);
            send({ type: 'ack', uuid: key, ok: true });
          } catch (e) {
            send(refused(key, e));
          }
          return;
        }
      }
    }
  }
}
