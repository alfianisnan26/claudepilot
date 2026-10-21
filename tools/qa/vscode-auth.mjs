// QA check of the VS Code extension's doors (T-1974, security review R5) against a RUNNING portal, by HTTP only:
//   - a cross-site approve is refused (403) and approves nothing;
//   - the device flow's public calls take 4 KiB at most (413);
//   - a device-flow token opens /api/vscode and is refused by /mcp; with the Portal MCP off, the bearer routes are refused;
//   - Allow is refused from VS Code (403), only deny is taken.
// Usage: scripts/scratch-portal.sh start 3351 && QA_PORT=3351 QA_CODE=<code> node tools/qa/vscode-auth.mjs ; then stop it.
// It changes the portal's Portal MCP switches and leaves them as it found them. No real credential: the token is the one it signs in for.
import { BASE, api, login } from './lib.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const post = (path, body, headers = {}) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const cookie = await login();
const call = api(cookie);
const before = (await call('GET', '/api/portal-mcp/settings')).data;
try {
  await call('PUT', '/api/portal-mcp/settings', { enabled: true, sessionControl: true });

  // 1. Cross-site approve.
  const start = await (await post('/api/vscode/device', { client: 'qa check', instance: `qa-${Date.now()}` })).json();
  const code = start.data.userCode;
  const cross = await call('POST', '/api/vscode/approve', { userCode: code, decision: 'approve' }, { Origin: 'https://evil.example' });
  check('cross-site POST /api/vscode/approve is 403', cross.status === 403, `got ${cross.status}`);
  const still = await (await post('/api/vscode/token', { deviceCode: start.data.deviceCode })).json();
  check('and the code is still pending', still.data?.status === 'pending', still.data?.status);

  // 2. Size limits.
  const bigDevice = await post('/api/vscode/device', JSON.stringify({ client: 'x'.repeat(5000) }));
  check('POST /api/vscode/device over 4 KiB is 413', bigDevice.status === 413, `got ${bigDevice.status}`);
  const bigToken = await post('/api/vscode/token', JSON.stringify({ deviceCode: 'y'.repeat(5000) }));
  check('POST /api/vscode/token over 4 KiB is 413', bigToken.status === 413, `got ${bigToken.status}`);

  // 3. A real sign-in, same origin.
  const ok = await call('POST', '/api/vscode/approve', { userCode: code, decision: 'approve' });
  check('same-origin approve works', ok.status === 200, `got ${ok.status}`);
  const poll = await (await post('/api/vscode/token', { deviceCode: start.data.deviceCode })).json();
  const token = poll.data?.token;
  check('the poll hands the token over', poll.data?.status === 'ok' && typeof token === 'string');
  const bearer = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  check('the token opens /api/vscode/me', (await bearer('/api/vscode/me')).status === 200);
  const mcp = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  check('/mcp refuses the VS Code token (401)', mcp.status === 401, `got ${mcp.status}`);

  // 4. Allow is the portal's.
  const allow = await bearer('/api/vscode/sessions/none/respond', { method: 'POST', body: JSON.stringify({ requestId: 'r', decision: 'allow' }) });
  check('Allow from VS Code is refused', allow.status === 403 || allow.status === 404, `got ${allow.status}`);

  // 5. Portal MCP off.
  await call('PUT', '/api/portal-mcp/settings', { enabled: false });
  const off = await bearer('/api/vscode/agents');
  check('Portal MCP off: bearer routes refused (403)', off.status === 403, `got ${off.status}`);
  await call('PUT', '/api/portal-mcp/settings', { enabled: true });
  check('sign-out revokes', (await bearer('/api/vscode/logout', { method: 'POST', body: '{}' })).status === 200 && (await bearer('/api/vscode/me')).status === 401);
} finally {
  if (before) await call('PUT', '/api/portal-mcp/settings', { enabled: before.enabled, sessionControl: before.sessionControl });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
