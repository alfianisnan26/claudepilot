// A FAKE portal for the extension's tests (no real portal, no real credential): the VS Code API's routes over plain HTTP on 127.0.0.1,
// with fixed data. The token it hands out is made at run time. `POST /fake/approve` stands in for the person approving the code.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'x-pilot-vscode-api': String(extra.api ?? 1), 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', ...extra.headers });
  res.end(JSON.stringify(body));
};
const ok = (res, data, o) => json(res, 200, { success: true, data }, o);
const fail = (res, status, code, message, o) => json(res, status, { success: false, error: { code, message } }, o);

export function fakeData() {
  const at = new Date().toISOString();
  return {
    agents: [
      { id: 's1', title: 'Lead <b>one</b>', state: 'working', waiting: 0, workspaceId: 'local/ws1', parentId: null, lead: true, ticketId: 'T-1', ticketKey: 'KONF-1', model: 'claude-opus-5-5', claudeName: 'Main', agent: null, costUsd: 1.25, costBasis: 'reported', lastActivityAt: at, url: '/admin/sessions/s1' },
      { id: 's2', title: 'Worker', state: 'waiting', waiting: 1, workspaceId: 'local/ws1', parentId: 's1', lead: false, ticketId: 'T-2', ticketKey: null, model: 'claude-sonnet-5', claudeName: 'Main', agent: 'implementer', costUsd: 0.1, costBasis: 'estimate', lastActivityAt: at, url: '/admin/sessions/s2' },
    ],
    tickets: [
      { id: 'T-1', key: 'KONF-1', bucket: 'KONF', status: 'in_progress', priority: 'high', type: 'task', summary: 'Build it', assigneeSessionId: 's1', updatedAt: at, url: '/admin/tickets/KONF-1' },
      { id: 'T-3', key: 'CP-3', bucket: 'CP', status: 'open', priority: 'normal', type: 'bug', summary: 'Fix it', assigneeSessionId: null, updatedAt: at, url: '/admin/tickets/CP-3' },
    ],
    workspaces: [{ id: 'local/ws1', name: 'One', target: 'local', status: 'running', url: '/admin/workspaces' }],
    status: { quota: { claudeId: 'cl1', claudeName: 'Main', label: 'Week', usedPct: 61, resetsAt: null }, claudes: [{ claudeId: 'cl1', claudeName: 'Main', windows: [{ label: 'Week', usedPct: 61, resetsAt: null }] }], attention: 2, approvals: 1, at },
    approvals: [
      { sessionId: 's2', sessionTitle: 'Worker', workspaceId: 'local/ws1', requestId: 'r1', kind: 'tool', toolName: 'Bash', title: 'Run a command', full: 'npm test', fullCut: false, createdAt: at, url: '/admin/sessions/s2' },
    ],
    events: [
      { seq: 1, at, kind: 'user', text: 'hello', toolName: null, requestId: null },
      { seq: 2, at, kind: 'assistant', text: '<img src=x onerror=alert(1)>', toolName: null, requestId: null },
    ],
  };
}

/** Starts the fake on a free port. `opts.api` overrides the API version it claims (for the mismatch tests). */
export async function startFakePortal(opts = {}) {
  const state = { data: fakeData(), pending: new Map(), token: null, calls: [], sent: [], answered: [], api: opts.api ?? 1 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      return fail(res, 400, 'BAD_REQUEST', 'Expected a JSON body.');
    }
    state.calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization ? 'bearer' : null, cookie: !!req.headers.cookie });
    const o = { api: state.api };
    const p = url.pathname;
    if (req.method === 'OPTIONS') return json(res, 204, null, o);
    if (p === '/api/vscode/version') return ok(res, { api: state.api, minApi: opts.minApi ?? 1, name: 'Fake' }, o);
    if (p === '/api/vscode/device' && req.method === 'POST') {
      const deviceCode = randomBytes(32).toString('base64url');
      const userCode = 'BCDF-GHJK';
      state.pending.set(deviceCode, { approved: false, polls: 0, client: String(body.client ?? ''), instance: typeof body.instance === 'string' ? body.instance : null });
      return ok(res, { deviceCode, userCode, verifyUrl: 'http://127.0.0.1/admin/vscode', verifyUrlComplete: `http://127.0.0.1/admin/vscode?code=${userCode}`, expiresIn: 600, interval: opts.interval ?? 1 }, o);
    }
    if (p === '/fake/approve') {
      for (const v of state.pending.values()) v.approved = true;
      return ok(res, { ok: true }, o);
    }
    if (p === '/api/vscode/token' && req.method === 'POST') {
      const e = state.pending.get(body.deviceCode);
      if (!e) return ok(res, { status: 'expired' }, o);
      e.polls++;
      if (opts.autoApproveAfter !== undefined && e.polls > opts.autoApproveAfter) e.approved = true;
      if (!e.approved) return ok(res, { status: 'pending' }, o);
      state.pending.delete(body.deviceCode);
      state.token = `cpat_${randomBytes(32).toString('base64url')}`;
      return ok(res, { status: 'ok', token: state.token, tokenId: 'ptk_fake', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), label: `VS Code · ${e.client}` }, o);
    }
    if (!p.startsWith('/api/vscode/')) return fail(res, 404, 'NOT_FOUND', 'Not found.', o);
    if (req.headers.cookie) return fail(res, 400, 'BAD_REQUEST', 'Send the token without a cookie.', o);
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (!m || !state.token || m[1] !== state.token) return fail(res, 401, 'UNAUTHORIZED', 'Sign in to the portal again from VS Code.', o);
    const d = state.data;
    if (p === '/api/vscode/me') return ok(res, { tokenId: 'ptk_fake', label: 'VS Code · fake', scope: 'operate', expiresAt: new Date().toISOString(), api: state.api }, o);
    if (p === '/api/vscode/logout') {
      state.token = null;
      return ok(res, { revoked: true }, o);
    }
    if (p === '/api/vscode/agents') return ok(res, d.agents, o);
    if (p === '/api/vscode/tickets') return ok(res, d.tickets, o);
    if (p === '/api/vscode/workspaces') return ok(res, d.workspaces, o);
    if (p === '/api/vscode/status') return ok(res, d.status, o);
    if (p === '/api/vscode/approvals') return ok(res, d.approvals, o);
    const s = /^\/api\/vscode\/sessions\/([^/]+)\/(events|send|respond)$/.exec(p);
    if (s) {
      const id = decodeURIComponent(s[1]);
      if (!d.agents.some((a) => a.id === id)) return fail(res, 404, 'NOT_FOUND', 'Not found.', o);
      if (s[2] === 'events') {
        const after = Number(url.searchParams.get('after') ?? 0);
        return ok(res, { events: d.events.filter((e) => e.seq > after), lastSeq: d.events.at(-1)?.seq ?? 0, state: 'working', title: 'Lead one' }, o);
      }
      if (s[2] === 'send') {
        state.sent.push({ id, text: body.text });
        return ok(res, { ok: true, uuid: body.uuid }, o);
      }
      if (body.decision !== 'deny') return fail(res, 403, 'FORBIDDEN', 'Allow it in the portal. From VS Code a request can be denied.', o);
      state.answered.push({ id, ...body });
      return ok(res, { ok: true }, o);
    }
    return fail(res, 404, 'NOT_FOUND', 'Not found.', o);
  });
  await new Promise((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => server.close(r)) };
}

// `node test/fake-portal.mjs <port>`: run it on its own (for the web smoke or a look by hand); it approves every code after two polls.
if (import.meta.url === `file://${process.argv[1]}`) {
  void startFakePortal({ port: Number(process.argv[2] ?? 3359), autoApproveAfter: 2 }).then((f) => console.log(`fake portal on ${f.url}`));
}
