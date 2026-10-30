// Chat sessions: the browser WebSocket (chat-sessions PRD §10.5). One per tab, on CHAT_SOCKET_PATH,
// authorized like the shell socket (same origin + the session cookie). It subscribes tabs to sessions,
// forwards the controller's live events to them, and relays send/respond/control back to the controller.

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { isAppError } from '@isnanme/core';
import { CHAT_SOCKET_PATH, type Actor, type ChatClientMessage, type ChatServerMessage } from '@portal/contracts';
import { WebSocketServer, type WebSocket } from 'ws';
import { actorOfSocket, actorUserId } from '../authz/seam.js';
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

/**
 * A refused send, respond or control: its message, and its code when it has one (`FOLDER_UNTRUSTED` asks
 * for the trust sheet; `CHAT_INELIGIBLE` means the workspace can't host sessions now, the message says why).
 */
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
    // Who is on this connection is fixed here, at the handshake; a message that names a session checks that person's right to it.
    const actor = actorOfSocket(req, authorized);
    wss.handleUpgrade(req, socket, head, (ws) => join(ws, actor));
  });

  function join(ws: WebSocket, actor: Actor) {
    const subscribed = new Set<string>();
    const send = (msg: ChatServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    // Forward the controller's live updates (events, deltas, session, input states, tasks) for watched sessions.
    const off = controller.onEvent((sessionId, msg) => {
      if (subscribed.has(sessionId)) send(msg);
    });

    // A side question's messages (chat PRD §20) go to the person who asked, on the tabs watching its session, and to no one else subscribed to it.
    const offBtw = controller.btw.onMessage((userId, sessionId, msg) => {
      if (userId === actorUserId(actor) && subscribed.has(sessionId)) send(msg);
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
      offBtw();
    });
    ws.on('error', () => ws.terminate());

    async function handle(msg: ChatClientMessage) {
      switch (msg.type) {
        case 'subscribe': {
          // A folded session's old id means the chat that took it in.
          const id = controller.resolve(msg.session);
          subscribed.add(id);
          // Backlog first (stored events after the tab's last seq), then live updates flow via `off`. T-2589: bounded by the store's
          // HISTORY_MAX_EVENTS; a tab further behind gets the newest of them (a gap before the first), the older ones stay in the paged read.
          const items = controller.history(id, msg.afterSeq ?? 0);
          if (items.length) send({ type: 'events', session: id, items });
          const session = controller.get(id);
          if (session) {
            // A running process gets its reader back if it lost it (after a restart, say).
            controller.attach(id);
            send({ type: 'session', session });
            send({ type: 'tasks', session: id, tasks: controller.tasks(id) });
            // Queued, withdrawn and failed messages: what the transcript alone can't tell a fresh tab.
            for (const input of controller.inputStates(id)) send({ type: 'input', session: id, uuid: input.uuid, state: input.state });
            // A thinking block already under way shows as "Thinking…", timed from its real start.
            for (const t of controller.openThinking(id))
              send({ type: 'delta', session: id, agentLabel: t.agentLabel, ...(t.parentToolUseId ? { parentToolUseId: t.parentToolUseId } : {}), text: '', thinking: true, elapsedMs: t.elapsedMs });
            // The person's open side questions on it (their cards survive a reload or a dropped connection).
            for (const item of controller.btw.open(actor, id)) send({ type: 'btw', session: id, item });
          } else send({ type: 'removed', session: msg.session }); // deleted (or never was)
          return;
        }
        case 'unsubscribe':
          subscribed.delete(controller.resolve(msg.session));
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
        case 'btw_ask':
          try {
            await controller.btw.ask(actor, msg.session, msg.btw, msg.question);
          } catch (e) {
            send(refused(String(msg.btw ?? ''), e));
          }
          return;
        case 'btw_cancel':
        case 'btw_close':
          try {
            if (msg.type === 'btw_cancel') controller.btw.cancel(actor, msg.session, msg.btw);
            else controller.btw.close(actor, msg.session, msg.btw);
          } catch (e) {
            send(refused(String(msg.btw ?? ''), e));
          }
          return;
        case 'btw_pin':
          try {
            controller.btw.pin(actor, msg.session, msg.btw);
            send({ type: 'ack', uuid: msg.uuid, ok: true });
          } catch (e) {
            send(refused(String(msg.uuid ?? msg.btw ?? ''), e));
          }
          return;
        case 'control': {
          const key = typeof msg.uuid === 'string' && msg.uuid ? msg.uuid : String(msg.op);
          try {
            // A person in the app: the one caller that may turn on Auto (for a session a person started).
            await controller.control(msg.session, msg.op, msg.args, { actor: 'ui' });
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
