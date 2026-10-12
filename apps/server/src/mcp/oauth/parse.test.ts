import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AddressError, checkAuthUrl, checkRedirect, initState, lastLine, parseLogin, parseMcpGet, scrubOAuth, splitChecks, stripTerminal } from './parse.js';

// The fixtures are what Claude Code 2.1.296 printed (B3 experiment, PRD §13.3): the real escapes included.

const AUTH = 'https://git.example.com/login/oauth/authorize?response_type=code&client_id=pub-1&code_challenge=abc&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A24819%2Fcallback&state=st4te&scope=write%3Arepository&resource=https%3A%2F%2Fgitea-mcp.example.com%2Fmcp';
const LINK = `\x1b]8;;${AUTH}\x07\x1b[94m${AUTH}\x1b[39m\x1b]8;;\x07`;
const PROMPT = '\x1b[1G\x1b[0JOr paste the redirect URL here: \x1b[33G';
const START = `cp-pid:4242\r\nStarting authentication for "plugin:cpm-lab:gitea"…\r\n[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp (pre-upgrade storage or provider not round-tripping the value).\r\nVisit this URL to authorize:\r\n  ${LINK}\r\n\r\nWaiting for authorization… (^C to cancel)\r\n${PROMPT}`;

test('stripTerminal: the hyperlink, colours and carriage returns go; the text stays', () => {
  assert.equal(stripTerminal(LINK + '\r\n'), `${AUTH}\n`);
  assert.equal(stripTerminal('a\x1b[1G\x1b[0Jb\x00c'), 'abc');
});

test('scrubOAuth: codes, states and tokens in any address are cut, and so is a given address', () => {
  assert.equal(scrubOAuth('see http://localhost:1/callback?code=abc123&state=zzz9 now'), 'see http://localhost:1/callback?code=[redacted]&state=[redacted] now');
  assert.equal(scrubOAuth('bad http://localhost:1/callback?x=1 here', 'http://localhost:1/callback?x=1'), 'bad [address] here');
  assert.equal(scrubOAuth('?access_token=aaa&refresh_token=bbb&client_secret=ccc'), '?access_token=[redacted]&refresh_token=[redacted]&client_secret=[redacted]');
});

/* ---------- claude mcp get ---------- */

const GET = (status: string, extra = '') => `plugin:cpm-lab:gitea:\n  Scope: Dynamic config (from command line)\n  Status: ${status}\n${extra}  Type: http\n  URL: https://gitea-mcp.example.com/mcp\n  OAuth: client_id configured, callback_port 24819\n`;

test('parseMcpGet: connected, needs sign-in, failed with its issue, absent, unexpected', () => {
  assert.deepEqual(parseMcpGet(GET('✔ Connected')), { state: 'connected', detail: null, absent: false });
  assert.deepEqual(parseMcpGet(GET('! Needs authentication')), { state: 'needs_sign_in', detail: null, absent: false });
  assert.deepEqual(parseMcpGet(GET('✘ Failed to connect', '  Issue: Incompatible auth server: does not support dynamic client registration\n')), {
    state: 'failed',
    detail: 'Incompatible auth server: does not support dynamic client registration',
    absent: false,
  });
  assert.equal(parseMcpGet(GET('✘ Failed to connect')).detail, 'Claude Code couldn’t connect.');
  // The one-line form (`claude mcp list`) carries the reason after a dash.
  assert.equal(parseMcpGet('Status: ✘ Failed to connect — ECONNREFUSED: Unable to connect').detail, 'ECONNREFUSED: Unable to connect');
  const absent = parseMcpGet('No MCP server named "plugin:cpm-lab:gitea". Configured servers: other\n');
  assert.deepEqual([absent.state, absent.absent], ['unknown', true]);
  assert.equal(parseMcpGet('something else').state, 'unknown');
  assert.equal(parseMcpGet(GET('⏸ Pending approval')).state, 'unknown');
});

test('parseMcpGet: a code that leaks into a reason is cut', () => {
  const r = parseMcpGet(GET('✘ Failed to connect', '  Issue: bad redirect http://localhost:24819/callback?code=SECRETCODE&state=abc\n'));
  assert.ok(!/SECRETCODE/.test(r.detail ?? ''));
});

test('initState: what a chat session reports for a server (✅ connected, needs-auth, failed)', () => {
  assert.equal(initState('connected'), 'connected');
  assert.equal(initState('needs-auth'), 'needs_sign_in');
  assert.equal(initState('failed'), 'failed');
  assert.equal(initState('pending'), null);
  assert.equal(initState(undefined), null);
});

test('splitChecks: one block per server, with its exit code', () => {
  const out = '<<<cp-auth>>>plugin:cpm-a:x\nStatus: ✔ Connected\n<<<cp-exit>>>0\n<<<cp-auth>>>plugin:cpm-a:y\nNo MCP server named "y"\n<<<cp-exit>>>1\n';
  const m = splitChecks(out);
  assert.deepEqual([...m.keys()], ['plugin:cpm-a:x', 'plugin:cpm-a:y']);
  assert.equal(m.get('plugin:cpm-a:y')!.code, 1);
  assert.match(m.get('plugin:cpm-a:x')!.text, /Connected/);
});

/* ---------- claude mcp login ---------- */

test('parseLogin: the URL only once its line has ended; then the prompt', () => {
  assert.equal(parseLogin('Starting authentication for "x"…\r\nVisit this URL to authorize:\r\n  https://git.exa').url, null);
  assert.equal(parseLogin('Visit this URL to authorize:\r\n  https://git.exa').url, null);
  const seen = parseLogin(START);
  assert.deepEqual([seen.pid, seen.url, seen.prompting, seen.refused, seen.authenticated, seen.failure, seen.absent], [4242, AUTH, true, 0, false, null, false]);
});

test('parseLogin: a wrapped URL is joined', () => {
  const wrapped = `Visit this URL to authorize:\r\n  ${AUTH.slice(0, 60)}\r\n${AUTH.slice(60)}\r\n\r\nWaiting for authorization…\r\n`;
  assert.equal(parseLogin(wrapped).url, AUTH);
});

test('parseLogin: refused pastes, success, the provider’s refusal, the timeout, no terminal, no such server', () => {
  const refused = `${START}http://localhost:24819/callback?code=zzzzzzzz&state=nope\r\nThat doesn't look like a redirect URL for this sign-in — paste the full address from the browser page this sign-in opened.\r\n${PROMPT}`;
  assert.equal(parseLogin(refused).refused, 1);
  assert.equal(parseLogin(`${START}x\r\nAuthenticated with "plugin:cpm-lab:gitea". Its tools are now available in Claude Code.\r\n`).authenticated, true);
  assert.equal(parseLogin(`${START}x\r\nCouldn't complete authentication for "plugin:cpm-lab:gitea": OAuth error: access_denied - User denied\r\n`).failure, 'OAuth error: access_denied - User denied');
  assert.equal(parseLogin(`${START}\r\nCouldn't complete authentication for "plugin:cpm-lab:gitea": Authentication timeout\r\n`).failure, 'Authentication timeout');
  assert.match(
    parseLogin(`Couldn't complete authentication for "x": stdin isn't a terminal, so authentication can't be completed here. Re-run in an interactive terminal`).failure ?? '',
    /stdin isn't a terminal/,
  );
  assert.equal(parseLogin('No MCP server named "y". Configured servers: x\r\n').absent, true);
});

test('parseLogin: a failure that echoes the pasted address does not keep its code', () => {
  const r = parseLogin(`Couldn't complete authentication for "x": invalid_grant for http://localhost:24819/callback?code=LEAKYCODE&state=abc`);
  assert.ok(!/LEAKYCODE/.test(r.failure ?? ''));
});

/* ---------- The addresses ---------- */

test('checkAuthUrl: the provider’s page and where Claude Code listens', () => {
  assert.deepEqual(checkAuthUrl(AUTH), { url: AUTH, callback: 'http://localhost:24819/callback' });
  // A test provider on loopback may be plain http.
  assert.equal(checkAuthUrl('http://localhost:7701/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A53540%2Fcallback&state=s').callback, 'http://localhost:53540/callback');
});

test('checkAuthUrl: refuses what a person shouldn’t be sent to', () => {
  const back = 'redirect_uri=http%3A%2F%2Flocalhost%3A24819%2Fcallback';
  const refuse = (u: string, why: RegExp) => assert.throws(() => checkAuthUrl(u), (e) => e instanceof AddressError && why.test(e.message), u);
  refuse(`http://git.example.com/authorize?${back}`, /isn’t https/);
  refuse(`https://user:pw@git.example.com/authorize?${back}`, /won’t show/);
  refuse(`javascript:alert(1)//?${back}`, /isn’t https|can’t read|won’t show/);
  refuse('https://git.example.com/authorize?redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback', /no local callback/);
  refuse('https://git.example.com/authorize', /no local callback/);
  refuse(`https://git.example.com/authorize?${back}&x=a b`, /won’t show/);
  refuse(`https://git.example.com/authorize?${back}${'a'.repeat(5000)}`, /won’t show/);
});

const CB = 'http://localhost:24819/callback';

test('checkRedirect: the address the browser ended on, or just its query', () => {
  const good = `${CB}?code=abc123&state=st4te`;
  assert.equal(checkRedirect(good, CB), good);
  assert.equal(checkRedirect(`  ${good}\n`, CB), good, 'a trimmed line');
  assert.equal(checkRedirect(`<${good}>`, CB), good, 'angle brackets from a mail client');
  assert.equal(checkRedirect('http://127.0.0.1:24819/callback?code=abc&state=s', CB), `${CB}?code=abc&state=s`, 'another loopback name is the same place');
  assert.equal(checkRedirect('?code=abc&state=s', CB), `${CB}?code=abc&state=s`);
  assert.equal(checkRedirect('code=abc&state=s', CB), `${CB}?code=abc&state=s`);
  assert.equal(checkRedirect(`${CB}?error=access_denied&error_description=No&state=s`, CB), `${CB}?error=access_denied&error_description=No&state=s`);
});

test('checkRedirect: anything else is refused before it can reach a terminal', () => {
  const refuse = (v: unknown) => assert.throws(() => checkRedirect(v, CB), AddressError, String(v));
  refuse(undefined);
  refuse('');
  refuse('hello not a url');
  refuse('http://localhost:9999/callback?code=a&state=b'); // not the port Claude Code listens on
  refuse('http://localhost:24819/other?code=a&state=b');
  refuse('https://localhost:24819/callback?code=a&state=b');
  refuse('http://evil.example.com:24819/callback?code=a&state=b');
  refuse(`${CB}?state=only`);
  refuse(`${CB}?code=only`);
  refuse(`${CB}?code=a&state=b\r\nrm -rf ~`);
  refuse(`${CB}?code=a&state=b\x03`);
  refuse(`${CB}?code=${'a'.repeat(5000)}&state=b`);
  refuse('code=a b&state=c');
});

test('lastLine: the last real line, without bookkeeping, and without a code', () => {
  assert.equal(lastLine('cp-pid:12\r\n[mcp-sdk] SEP-2352: notice\r\nerror: unknown option \'--no-browser\'\r\n'), "error: unknown option '--no-browser'");
  assert.equal(lastLine('cp-pid:12\r\nStarting authentication for "x"…\r\n'), null);
  assert.ok(!/LEAK/.test(lastLine('bad http://localhost:1/callback?code=LEAK&state=s') ?? ''));
});
