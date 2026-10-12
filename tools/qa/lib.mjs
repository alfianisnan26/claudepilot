// Small helpers for QA scripts against a running portal: sign in, call the API, drive a chat session over its socket.
// Defaults to the QA portal (port 3101, code 24681357); override with QA_PORT and QA_CODE.
import WebSocket from 'ws';

export const PORT = Number(process.env.QA_PORT ?? 3101);
export const BASE = `http://localhost:${PORT}`;
export const CODE = process.env.QA_CODE ?? '24681357';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function login(code = CODE) {
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ code }) });
  const m = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`login failed: ${r.status} ${await r.text()}`);
  return m[1];
}

/** `api(cookie)(method, path, body)` -> { status, body } with the JSON body parsed (and `.data` unwrapped as `data`). */
export const api = (cookie) => async (method, path, body, extraHeaders = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Cookie: `portal_session=${cookie}`, Origin: BASE, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: r.status, body: json, text, data: json?.data, headers: r.headers };
};

/** Opens the chat socket and subscribes to a session; collects its events. */
export async function openChat(cookie, sessionId, { afterSeq = 0 } = {}) {
  const ws = new WebSocket(`ws://localhost:${PORT}/api/chat/live`, { headers: { Cookie: `portal_session=${cookie}`, Origin: BASE } });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    ws.on('unexpected-response', (_q, res) => reject(new Error(`socket refused ${res.statusCode}`)));
  });
  const chat = { ws, events: [], messages: [], session: null, acks: new Map(), requests: [], deltas: 0 };
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    chat.messages.push(m);
    if (m.type === 'events') for (const e of m.items) { chat.events.push(e); if (e.kind === 'request' && e.request) chat.requests.push(e.request); }
    else if (m.type === 'session') chat.session = m.session;
    else if (m.type === 'ack') chat.acks.set(m.uuid, m);
    else if (m.type === 'delta') chat.deltas++;
  });
  ws.send(JSON.stringify({ type: 'subscribe', session: sessionId, afterSeq }));
  let n = 0;
  chat.send = async (text, opts = {}) => {
    const uuid = `qa-${Date.now()}-${++n}`;
    ws.send(JSON.stringify({ type: 'send', session: sessionId, uuid, text, ...opts }));
    for (let i = 0; i < 100 && !chat.acks.has(uuid); i++) await sleep(100);
    return chat.acks.get(uuid);
  };
  chat.control = async (op, args) => {
    const uuid = `qa-c-${Date.now()}-${++n}`;
    ws.send(JSON.stringify({ type: 'control', session: sessionId, op, uuid, args }));
    for (let i = 0; i < 100 && !chat.acks.has(uuid); i++) await sleep(100);
    return chat.acks.get(uuid);
  };
  chat.respond = async (requestId, decision, note) => {
    ws.send(JSON.stringify({ type: 'respond', session: sessionId, requestId, decision, note }));
    for (let i = 0; i < 100 && !chat.acks.has(requestId); i++) await sleep(100);
    return chat.acks.get(requestId);
  };
  /** Waits until the session is idle (or ended/interrupted) after at least `minEvents` events. */
  chat.until = async (pred, ms = 60000, what = 'condition') => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred(chat)) return true;
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${what}; state=${chat.session?.state}; last events: ${JSON.stringify(chat.events.slice(-3))}`);
  };
  chat.idle = (ms = 60000) => chat.until((c) => c.session && ['idle', 'ended', 'interrupted'].includes(c.session.state), ms, 'idle');
  chat.close = () => ws.close();
  return chat;
}
