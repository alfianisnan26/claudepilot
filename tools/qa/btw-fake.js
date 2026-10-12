// Injected before the page's scripts by btw-layout.mjs: a stand-in for the chat socket and the session's HTTP routes, so the REAL session page runs
// against a scripted session: a transcript long enough to scroll, a main turn that streams on demand (window.__fake.startMain/stopMain), and a btw
// engine that answers by keyword in the question (LONG, FAIL, SLOW, REFUSE; anything else a short answer). No portal engine, no Claude.
(() => {
  const SID = 'bv-fake';
  const now = () => new Date().toISOString();
  const session = {
    id: SID, workspaceId: 'bv-ws', cwd: '/work', title: 'btw layout fixture', state: 'idle', origin: 'ui', model: 'claude-sonnet', mode: 'default', effort: null,
    ultracode: false, ultracodeAvailable: false, process: 'live', context: null, costUsd: 0, turns: 12, lastSeq: 0, waiting: 0, waitingFor: null,
    createdAt: now(), lastActivityAt: now(), endedReason: null, claudeId: '', claudeName: null, predecessorId: null, successorId: null, archivedAt: null,
    ticketId: null, parentId: null, worktree: null, startedBy: 'ui', bypassCapable: false, claudeSessionId: 'x', previousClaudes: [], switching: null,
  };
  const events = [];
  let seq = 0;
  const add = (kind, extra) => events.push({ seq: ++seq, at: now(), kind, ...extra });
  for (let i = 0; i < 14; i++) {
    add('user', { text: `Question ${i}: how does module ${i} handle retries?`, uuid: `u${i}` });
    add('assistant', { text: `Module ${i} retries with backoff.\n\n` + 'It waits, doubles the delay and gives up after five tries. '.repeat(4) });
    add('result', { costUsd: 0.01 * i, turnCostUsd: 0.01, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, durationMs: 4000 });
  }
  session.lastSeq = seq;

  const json = (d) => Promise.resolve(new Response(JSON.stringify({ data: d }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const p = new URL(typeof input === 'string' ? input : input.url, location.origin).pathname;
    const base = `/api/chat/sessions/${SID}`;
    if (p === base) return json(session);
    if (p === `${base}/events`) return json(events);
    if (p === `${base}/tasks`) return json([]);
    if (p === `${base}/files`) return json({ path: '/work', parent: null, entries: [] });
    if (p.startsWith(base)) return json(null);
    return realFetch(input, init);
  };

  const timers = new Set();
  const every = (ms, fn) => { const t = setInterval(fn, ms); timers.add(t); return t; };
  const after = (ms, fn) => { const t = setTimeout(fn, ms); timers.add(t); return t; };
  const live = new Map(); // btw id -> { item, timers }
  let sock = null;
  const emit = (o) => sock && sock.onmessage && sock.onmessage({ data: JSON.stringify(o) });
  const setBtw = (item) => emit({ type: 'btw', session: SID, item: { ...item } });

  const answerFor = (q) => {
    if (q.includes('LONG')) return Array.from({ length: 300 }, (_, i) => `Line ${i + 1}: ` + 'the retry loop doubles its delay each time. '.repeat(2)).join('\n\n');
    if (q.includes('WIDE')) return 'Unbroken: ' + 'x'.repeat(240) + '\n\n```\n' + 'const veryLongLine = ' + '"y".repeat(10) + '.repeat(12) + '\n```\n\n| a | b |\n|---|---|\n| ' + 'z'.repeat(80) + ' | 2 |';
    return 'It retries with exponential backoff. The first wait is short, each next one doubles, and after five tries it reports the failure to the caller.';
  };
  const run = (m) => {
    const q = m.question;
    const item = { id: m.btw, session: SID, question: q, status: 'running', answer: '', askedAt: now(), context: { messages: 28, truncated: false, lastSeq: seq, chars: 4000 } };
    const mine = [];
    live.set(m.btw, { item, mine });
    setBtw(item);
    const settle = (patch) => {
      Object.assign(item, patch, { settledAt: now() });
      setBtw(item);
    };
    if (q.includes('FAIL')) return mine.push(after(250, () => settle({ status: 'failed', reason: 'no_quota' })));
    const full = answerFor(q);
    const slow = q.includes('SLOW');
    const chunk = q.includes('LONG') ? 300 : 12;
    let at = 0, n = 0;
    const t = every(slow ? 120 : 30, () => {
      const text = full.slice(at, at + chunk);
      at += chunk;
      if (!text || (slow && at > 400)) {
        if (slow) return;
        clearInterval(t);
        return settle({ status: 'answered', answer: full, model: 'claude-sonnet', usage: { input: 5200, output: 310, cacheRead: 0, cacheWrite: 0, costUsd: 0.0214, estimate: true, basis: 'reported' } });
      }
      item.answer += text;
      emit({ type: 'btw_delta', session: SID, btw: m.btw, text, seq: ++n });
    });
    mine.push(t);
  };

  let mainTimer = null, mainText = '';
  window.__fake = {
    events, session,
    startMain() {
      session.state = 'working'; emit({ type: 'session', session: { ...session } });
      mainText = '';
      mainTimer = every(60, () => { const w = 'streaming words keep coming in, '; mainText += w; emit({ type: 'delta', session: SID, agentLabel: null, text: w }); });
    },
    stopMain() {
      clearInterval(mainTimer);
      add('assistant', { text: mainText }); add('result', { costUsd: 1, turnCostUsd: 0.01, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, durationMs: 1 });
      session.state = 'idle';
      emit({ type: 'events', session: SID, items: events.slice(-2) }); emit({ type: 'session', session: { ...session } });
    },
    pinned: 0, closed: [], asked: [],
  };

  const Real = window.WebSocket;
  class Fake {
    constructor() { this.readyState = 0; sock = this; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); }, 20); }
    send(d) {
      const m = JSON.parse(d);
      if (m.type === 'subscribe') { emit({ type: 'session', session: { ...session } }); }
      else if (m.type === 'send' || m.type === 'control') emit({ type: 'ack', uuid: m.uuid, ok: true });
      else if (m.type === 'btw_ask') {
        window.__fake.asked.push(m.question);
        if (m.question.includes('REFUSE')) emit({ type: 'ack', uuid: m.btw, ok: false, error: 'One at a time.', code: 'busy' });
        else run(m);
      } else if (m.type === 'btw_cancel') {
        const b = live.get(m.btw);
        if (b) { b.mine.forEach(clearInterval); b.item.status = 'cancelled'; b.item.settledAt = now(); setBtw(b.item); }
      } else if (m.type === 'btw_close') {
        const b = live.get(m.btw);
        window.__fake.closed.push(m.btw);
        if (b) b.mine.forEach(clearInterval);
      } else if (m.type === 'btw_pin') {
        const b = live.get(m.btw);
        window.__fake.pinned++;
        emit({ type: 'ack', uuid: m.uuid, ok: true });
        add('system', { text: `btw: ${b.item.question}`, btw: { id: b.item.id, question: b.item.question, answer: b.item.answer, askedAt: b.item.askedAt, askedBy: 'user:u_owner' } });
        emit({ type: 'events', session: SID, items: events.slice(-1) });
        b.item.pinnedSeq = seq; setBtw(b.item);
      }
    }
    close() { this.readyState = 3; this.onclose && this.onclose({}); }
  }
  function WS(url, ...rest) { return String(url).includes('/api/chat/live') ? new Fake() : new Real(url, ...rest); }
  Object.assign(WS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = WS;
  try { Object.keys(localStorage).filter((k) => k.startsWith('claudepilot.btw.')).forEach((k) => localStorage.removeItem(k)); } catch {}
})();
