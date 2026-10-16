import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { GATE_SCRIPT } from './gate.js';
import { McpClient } from './mcpclient.js';

/**
 * The gate (PRD §11.3) against a fake supervisor and a fake pinned server: what it answers itself, when it wakes
 * Chrome and starts the server, what it refuses while a person has control, what it redacts, and every handoff
 * result. The real servers and a real Chrome are checked in gate.integration.test.ts.
 */

const FAKE_SERVER = String.raw`
const fs = require('fs'), readline = require('readline');
const log = (o) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n');
log({ started: process.argv.slice(2) });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Fake', version: '1' } } }));
  if (m.method !== 'tools/call') return;
  const { name, arguments: args } = m.params;
  log({ call: name, args });
  if (name === 'browser_boom') process.exit(3);
  const text = name === 'browser_tabs' && args.action === 'list'
    ? '### Result\n- 0: [Other](http://localhost:3000/)\n- 1: (current) [My app [dev]](http://localhost:5173/login)'
    : name === 'browser_headers'
    ? 'cookie: sid=abc123\nAuthorization: Bearer tok_secret\n- Set-Cookie: s=1; Path=/\n{"x-api-key": "k_secret", "accept": "*/*"}\nCF-Access-Client-Secret: cfsecretval\n{"X-Edge-Token": "edgeval"}\nplain: visible'
    : name === 'browser_dump'
    ? 'GET /x?t=plainvalue-in-test-0001&z=1\n| CF-Access-Client-Id | tableidval1 |\n| X-Edge-Token | tableval123 |\n{"name":"X-Edge-Token","value":"pairval123"}\n{"value":"revval123","name":"X-Edge-Token"}\nthe body said plainvalue-in-test-0001 twice: plainvalue-in-test-0001\nshort abc stays'
    : 'ran ' + name + ' ' + JSON.stringify(args);
  console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } }));
});
`;

const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object' } });
const TOOLS = { server: { name: 'Fake', version: '1' }, tools: ['browser_navigate', 'browser_tabs', 'browser_headers', 'browser_dump', 'browser_boom'].map(tool) };

interface Fake {
  state: {
    chrome: { state: string; bootId: string | null };
    control: { held: boolean; label?: string; since?: number };
    sessions: number;
    tabs: { id: string; title: string; url: string }[];
    handoff: { state: string; note: string };
    wakeFails: boolean;
  };
  requests: { method: string; path: string; body: unknown; cpb: string | undefined }[];
}

let dir: string;
let sup: Server;
let supUrl: string;
const fake: Fake = {
  state: { chrome: { state: 'asleep', bootId: null }, control: { held: false }, sessions: 0, tabs: [{ id: 'A', title: '', url: 'about:blank' }], handoff: { state: 'handed_back', note: 'signed in' }, wakeFails: false },
  requests: [],
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cpb-gate-'));
  mkdirSync(join(dir, 'npm/node_modules/@playwright/mcp'), { recursive: true });
  writeFileSync(join(dir, 'npm/node_modules/@playwright/mcp/cli.js'), FAKE_SERVER);
  writeFileSync(join(dir, 'gate.js'), GATE_SCRIPT);
  writeFileSync(join(dir, 'tools.json'), JSON.stringify(TOOLS));
  sup = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const path = req.url ?? '/';
      fake.requests.push({ method: req.method ?? '', path, body: body ? JSON.parse(body) : null, cpb: req.headers['x-cpb'] as string | undefined });
      const send = (status: number, json: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(json)));
      const s = fake.state;
      if (path === '/status')
        return send(200, { protocol: 1, tier: 'browser', display: { width: 1280, height: 800 }, chrome: s.chrome, control: s.control, sessions: s.sessions, tabCount: s.tabs.length, activity: { session: null }, idle: { stopAt: null } });
      if (path === '/wake') {
        if (s.wakeFails) return send(503, { error: 'the display is not up' });
        s.chrome = { state: 'up', bootId: s.chrome.bootId ?? 'boot-1' };
        return send(200, { protocol: 1, tier: 'browser', display: { width: 1280, height: 800 }, chrome: s.chrome, control: s.control, sessions: s.sessions });
      }
      if (path === '/tabs') return send(200, { tabs: s.tabs });
      if (path === '/activity') return send(200, { ok: true });
      if (path === '/handoff') return send(200, { id: '00000000-0000-0000-0000-000000000001', state: 'waiting', note: '' });
      if (path.startsWith('/handoff/')) return send(200, { id: '00000000-0000-0000-0000-000000000001', state: s.handoff.state, note: s.handoff.note });
      send(404, {});
    });
  });
  await new Promise<void>((resolve) => sup.listen(0, '127.0.0.1', resolve));
  supUrl = `http://127.0.0.1:${(sup.address() as AddressInfo).port}`;
});
after(() => {
  sup.close();
  sup.closeAllConnections();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.state.chrome = { state: 'asleep', bootId: null };
  fake.state.control = { held: false };
  fake.state.sessions = 0;
  fake.state.tabs = [{ id: 'A', title: '', url: 'about:blank' }];
  fake.state.wakeFails = false;
  fake.state.handoff = { state: 'handed_back', note: 'signed in' };
  writeFileSync(join(dir, 'fake.log'), '');
});

/** Polls until `fn` holds (the fake supervisor hears the gate's fire-and-forget requests after the tool reply, not before it). */
async function until(fn: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('gave up waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const serverLog = () =>
  readFileSync(join(dir, 'fake.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { started?: string[]; call?: string; args?: Record<string, unknown> });

function gate(extra: string[] = [], env: Record<string, string> = {}) {
  return new McpClient(process.execPath, [join(dir, 'gate.js'), 'playwright', '--tools', join(dir, 'tools.json'), ...extra, '--', '--cdp-endpoint', 'http://127.0.0.1:9222'], {
    env: { CLAUDEPILOT_BROWSER_SUPERVISOR: supUrl, CLAUDEPILOT_BROWSER_NPM: join(dir, 'npm'), FAKE_LOG: join(dir, 'fake.log'), ...env },
  });
}

describe('the gate', () => {
  test('answers initialize and tools/list itself: no server, no wake, and it adds its own tools', async () => {
    const g = gate();
    try {
      const init = await g.init();
      assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, 'claudepilot-browser');
      const tools = await g.tools();
      assert.deepEqual(tools.slice(0, 2), ['browser_navigate', 'browser_tabs']);
      for (const t of ['browser_status', 'browser_handoff', 'browser_navigate_forward', 'browser_reload']) assert.ok(tools.includes(t), t);
      assert.deepEqual(serverLog(), [], 'the pinned server was not started');
      assert.deepEqual(fake.requests.filter((r) => r.path === '/wake'), [], 'Chrome was not woken');
      assert.equal((await g.request('ping')).error, undefined);
      assert.deepEqual((await g.request('resources/list')).result, { resources: [] });
    } finally {
      g.close();
    }
  });

  test('a call wakes Chrome, starts the server once with the client’s initialize, forwards, and reports the activity', async () => {
    const g = gate();
    try {
      await g.init(true);
      const r = await g.call('browser_navigate', { url: 'http://localhost:5173/' });
      assert.equal(r.isError, false);
      assert.equal(r.text, 'ran browser_navigate {"url":"http://localhost:5173/"}');
      const second = await g.call('browser_navigate', { url: 'http://localhost:5173/b' });
      assert.match(second.text, /ran browser_navigate/);
      assert.equal(serverLog().filter((l) => l.started).length, 1, 'one server for both calls');
      assert.deepEqual(serverLog().find((l) => l.started)?.started, ['--cdp-endpoint', 'http://127.0.0.1:9222']);
      assert.equal(fake.requests.filter((r) => r.path === '/wake').length, 1, 'woken once');
      // The gate posts /activity without waiting for it (nothing of the call depends on it), so under load the reply can land here first.
      await until(() => fake.requests.filter((r) => r.path === '/activity').length === 2);
      const activity = fake.requests.filter((r) => r.path === '/activity');
      assert.equal(activity.length, 2);
      assert.equal((activity[0]!.body as { tool: string }).tool, 'browser_navigate');
      assert.ok(fake.requests.every((r) => r.cpb === '1'), 'every request carries X-CPB');
    } finally {
      g.close();
    }
  });

  test('while a person has control it refuses instead of forwarding, and says who and since when', async () => {
    fake.state.chrome = { state: 'up', bootId: 'boot-1' };
    fake.state.control = { held: true, label: 'Alfian’s iPhone', since: Date.UTC(2026, 9, 11, 14, 2) };
    const g = gate();
    try {
      await g.init();
      const r = await g.call('browser_navigate', { url: 'http://localhost:5173/' });
      assert.equal(r.isError, true);
      assert.match(r.text, /A person has control of the browser since 14:02 UTC \(Alfian’s iPhone\)/);
      assert.match(r.text, /browser_snapshot/);
      assert.deepEqual(serverLog(), []);
      // browser_status still answers, and never wakes.
      const s = await g.call('browser_status');
      assert.match(s.text, /A person has control/);
      assert.equal(fake.requests.filter((x) => x.path === '/wake').length, 0);
      // Control ends: the call goes through.
      fake.state.control = { held: false };
      await new Promise((r) => setTimeout(r, 1100)); // the gate caches status for 1 s
      assert.equal((await g.call('browser_navigate', { url: 'http://localhost:5173/' })).isError, false);
    } finally {
      g.close();
    }
  });

  test('a browser that cannot start is a tool error, not a crash', async () => {
    fake.state.wakeFails = true;
    const g = gate();
    try {
      await g.init();
      const r = await g.call('browser_navigate', { url: 'http://localhost/' });
      assert.equal(r.isError, true);
      assert.match(r.text, /The browser could not start: the display is not up/);
      fake.state.wakeFails = false;
      assert.equal((await g.call('browser_navigate', { url: 'http://localhost/' })).isError, false, 'and it recovers');
    } finally {
      g.close();
    }
  });

  test('a new Chrome means a new server (its CDP connection is stale), replaying initialize', async () => {
    fake.state.chrome = { state: 'up', bootId: 'boot-1' };
    const g = gate();
    try {
      await g.init();
      await g.call('browser_navigate', { url: 'http://localhost/a' });
      assert.equal(serverLog().filter((l) => l.started).length, 1);
      fake.state.chrome = { state: 'up', bootId: 'boot-2' }; // idle stop and wake, or a restart
      await new Promise((r) => setTimeout(r, 1100));
      await g.call('browser_navigate', { url: 'http://localhost/b' });
      assert.equal(serverLog().filter((l) => l.started).length, 2);
    } finally {
      g.close();
    }
  });

  test('credential headers in results are replaced; other text is left alone', async () => {
    fake.state.chrome = { state: 'up', bootId: 'boot-1' };
    const g = gate();
    try {
      await g.init();
      const r = await g.call('browser_headers');
      for (const secret of ['sid=abc123', 'tok_secret', 's=1; Path', 'k_secret']) assert.ok(!r.text.includes(secret), `${secret} leaked: ${r.text}`);
      assert.match(r.text, /plain: visible/);
      assert.match(r.text, /"accept": "\*\/\*"/);
      assert.match(r.text, /\[redacted\]/);
    } finally {
      g.close();
    }
  });

  test('the headers a pool adds from secrets are redacted too: the Cloudflare Access ones always, the pool’s own by name (--redact)', async () => {
    fake.state.chrome = { state: 'up', bootId: 'boot-1' };
    const plain = gate();
    try {
      await plain.init();
      const r = await plain.call('browser_headers');
      assert.ok(!r.text.includes('cfsecretval'), `the Cloudflare Access header leaked: ${r.text}`);
      assert.ok(r.text.includes('edgeval'), 'a header the pool did not name is not guessed');
    } finally {
      plain.close();
    }
    const named = gate(['--redact', 'X-Edge-Token,bad name!,a|b']);
    try {
      await named.init();
      const r = await named.call('browser_headers');
      for (const leaked of ['cfsecretval', 'edgeval', 'sid=abc123']) assert.ok(!r.text.includes(leaked), `${leaked} leaked: ${r.text}`);
      assert.match(r.text, /plain: visible/);
      assert.match(r.text, /"accept": "\*\/\*"/);
    } finally {
      named.close();
    }
  });

  test('a header value is masked wherever it appears, and table rows and name/value pairs by the header’s name (m3)', async () => {
    fake.state.chrome = { state: 'up', bootId: 'boot-1' };
    const flags = ['--redact', 'X-Edge-Token', '--redact-env', 'EDGE_TOKEN,SHORT,NOT_SET,bad name!'];
    const g = gate(flags, { EDGE_TOKEN: 'plainvalue-in-test-0001', SHORT: 'abc' });
    try {
      await g.init();
      const r = await g.call('browser_dump');
      for (const leaked of ['plainvalue-in-test-0001', 'tableval123', 'tableidval1', 'pairval123', 'revval123']) assert.ok(!r.text.includes(leaked), `${leaked} leaked: ${r.text}`);
      assert.match(r.text, /short abc stays/, 'a value under 8 characters is not masked: it would hit ordinary words');
      assert.match(r.text, /z=1/);
    } finally {
      g.close();
    }
    // Without the secret's variable in the gate's environment only the structure masks it: the value in a URL or a sentence stays (the residual).
    const bare = gate(flags);
    try {
      await bare.init();
      const r = await bare.call('browser_dump');
      assert.ok(!r.text.includes('tableval123'));
      assert.ok(r.text.includes('plainvalue-in-test-0001'));
    } finally {
      bare.close();
    }
  });

  test('a variable that keeps its note or its KEY= is masked as the header carries it: the bare value too (T-623 S2d)', async () => {
    fake.state.chrome = { state: 'up', bootId: 'boot-1' };
    const flags = ['--redact-env', 'NOTED,QUOTED'];
    const g = gate(flags, { NOTED: 'K=plainvalue-in-test-0001 # note', QUOTED: '"edgeval" # n' });
    try {
      await g.init();
      const r = await g.call('browser_dump');
      assert.ok(!r.text.includes('plainvalue-in-test-0001'), `bare value leaked: ${r.text}`);
      assert.match(r.text, /short abc stays/);
    } finally {
      g.close();
    }
    // A parsed form under 8 characters is not masked either: it would hit ordinary words.
    const short = gate(['--redact-env', 'TINY'], { TINY: 'T=abc # a long note here' });
    try {
      await short.init();
      const r = await short.call('browser_dump');
      assert.match(r.text, /short abc stays/);
    } finally {
      short.close();
    }
  });

  test('forward and reload are built on the pinned server’s own tools', async () => {
    fake.state.chrome = { state: 'up', bootId: 'boot-1' };
    const g = gate();
    try {
      await g.init();
      await g.call('browser_navigate_forward');
      await g.call('browser_reload');
      const calls = serverLog().filter((l) => l.call);
      assert.deepEqual(calls.map((c) => c.call), ['browser_run_code_unsafe', 'browser_run_code_unsafe']);
      assert.match(String(calls[0]!.args?.code), /goForward/);
      assert.match(String(calls[1]!.args?.code), /reload/);
    } finally {
      g.close();
    }
  });

  test('a server that dies mid-call answers with an error and starts again on the next call', async () => {
    fake.state.chrome = { state: 'up', bootId: 'boot-1' };
    const g = gate();
    try {
      await g.init();
      const died = await g.call('browser_boom');
      assert.equal(died.isError, true);
      assert.match(died.text, /server stopped/);
      const next = await g.call('browser_navigate', { url: 'http://localhost/' });
      assert.equal(next.isError, false);
      assert.equal(serverLog().filter((l) => l.started).length, 2);
    } finally {
      g.close();
    }
  });

  test('shared logins: a session uses the blank tab Chrome starts with, and opens a tab of its own when there is more than that', async () => {
    fake.state.chrome = { state: 'up', bootId: 'boot-1' };
    const first = gate(['--shared']);
    try {
      await first.init();
      await first.call('browser_navigate', { url: 'http://localhost/a' });
      assert.deepEqual(serverLog().filter((l) => l.call).map((l) => l.call), ['browser_navigate']);
    } finally {
      first.close();
    }
    writeFileSync(join(dir, 'fake.log'), '');
    fake.state.tabs = [{ id: 'A', title: 'a', url: 'http://localhost/a' }]; // another session's page
    const second = gate(['--shared']);
    try {
      await second.init();
      await second.call('browser_navigate', { url: 'http://localhost/b' });
      const calls = serverLog().filter((l) => l.call);
      assert.deepEqual(calls.map((l) => l.call), ['browser_tabs', 'browser_navigate']);
      assert.deepEqual(calls[0]!.args, { action: 'new' });
    } finally {
      second.close();
    }
    // Isolated logins have a context of their own: no tab bookkeeping at all.
    writeFileSync(join(dir, 'fake.log'), '');
    const isolated = gate([]);
    try {
      await isolated.init();
      await isolated.call('browser_navigate', { url: 'http://localhost/c' });
      assert.deepEqual(serverLog().filter((l) => l.call).map((l) => l.call), ['browser_navigate']);
    } finally {
      isolated.close();
    }
  });

  test('with several tabs open the session’s tab is brought to the front before each call (a tab behind another doesn’t render)', async () => {
    fake.state.chrome = { state: 'up', bootId: 'boot-1' };
    fake.state.tabs = [
      { id: 'A', title: 'a', url: 'http://localhost/a' },
      { id: 'B', title: 'b', url: 'http://localhost/b' },
    ];
    const g = gate(); // isolated logins: it would not open a tab, but still has to be in front
    try {
      await g.init();
      await g.call('browser_navigate', { url: 'http://localhost/c' });
      const calls = serverLog().filter((l) => l.call);
      assert.deepEqual(calls.map((l) => l.call), ['browser_run_code_unsafe', 'browser_navigate']);
      assert.match(String(calls[0]!.args?.code), /bringToFront/);
    } finally {
      g.close();
    }
    // A single tab needs no such thing (a fresh gate: no status cache to wait out).
    writeFileSync(join(dir, 'fake.log'), '');
    fake.state.tabs = [{ id: 'A', title: 'a', url: 'http://localhost/a' }];
    const single = gate();
    try {
      await single.init();
      await single.call('browser_navigate', { url: 'http://localhost/d' });
      assert.deepEqual(serverLog().filter((l) => l.call).map((l) => l.call), ['browser_navigate']);
    } finally {
      single.close();
    }
  });

  test('browser_status lists the tabs without waking Chrome', async () => {
    fake.state.chrome = { state: 'up', bootId: 'boot-1' };
    fake.state.tabs = [{ id: 'A', title: 'Home', url: 'http://localhost:5173/' }];
    const g = gate();
    try {
      await g.init();
      const s = await g.call('browser_status');
      assert.match(s.text, /Browser: up \(browser, 1280x800\)/);
      assert.match(s.text, /The agent has control/);
      assert.match(s.text, /1 open tab:\n- Home http:\/\/localhost:5173\//);
      assert.equal(fake.requests.filter((r) => r.path === '/wake').length, 0);
    } finally {
      g.close();
    }
  });

  describe('browser_handoff', () => {
    const run = async (state: string, note = '') => {
      fake.state.chrome = { state: 'up', bootId: 'boot-1' };
      fake.state.handoff = { state, note };
      const g = gate();
      try {
        await g.init();
        return await g.call('browser_handoff', { reason: 'Sign in to github.com' });
      } finally {
        g.close();
      }
    };
    test('handed back: tells the agent to check with a snapshot', async () => {
      const r = await run('handed_back', 'signed in');
      assert.equal(r.isError, false);
      assert.equal(r.text, 'Handed back: signed in. Check with browser_snapshot, not a screenshot.');
      const asked = fake.requests.find((x) => x.path === '/handoff')!.body as { reason: string; tabUrl: string | null };
      assert.equal(asked.reason, 'Sign in to github.com');
      assert.equal(asked.tabUrl, 'http://localhost:5173/login', 'the tab the pinned server calls current, read by the gate, not named by the agent');
    });
    test('declined, expired and left are errors with their own words', async () => {
      assert.deepEqual(await run('declined', 'not now').then((r) => [r.isError, r.text]), [true, 'Declined: not now']);
      assert.deepEqual(await run('expired').then((r) => [r.isError, r.text]), [true, 'No response after 10 minutes of waiting.']);
      assert.deepEqual(await run('left').then((r) => [r.isError, r.text]), [true, 'The person left before finishing.']);
    });
    test('a reason is required', async () => {
      fake.state.chrome = { state: 'up', bootId: 'boot-1' };
      const g = gate();
      try {
        await g.init();
        const r = await g.call('browser_handoff', { reason: '   ' });
        assert.equal(r.isError, true);
        assert.equal(fake.requests.filter((x) => x.path === '/handoff').length, 0);
      } finally {
        g.close();
      }
    });
  });

  test('an unknown tool and an unknown method are refused cleanly', async () => {
    const g = gate();
    try {
      await g.init();
      assert.equal((await g.call('browser_nope')).isError, true);
      assert.equal((await g.request('nope/method')).error?.code, -32601);
    } finally {
      g.close();
    }
  });

  test('without the pinned server installed, a call says so (and the installer is tried once)', async () => {
    fake.state.chrome = { state: 'up', bootId: 'boot-1' };
    const marker = join(dir, 'install.ran');
    const installer = join(dir, 'install.sh');
    writeFileSync(installer, `#!/bin/sh\necho "$1" >> ${marker}\n`);
    const g = new McpClient(process.execPath, [join(dir, 'gate.js'), 'playwright', '--tools', join(dir, 'tools.json'), '--npm-files', '/plugin/npm', '--', '--x'], {
      env: { CLAUDEPILOT_BROWSER_SUPERVISOR: supUrl, CLAUDEPILOT_BROWSER_NPM: join(dir, 'missing-npm'), CLAUDEPILOT_BROWSER_INSTALL: installer, FAKE_LOG: join(dir, 'fake.log') },
    });
    try {
      await g.init();
      const r = await g.call('browser_navigate', {});
      assert.equal(r.isError, true);
      assert.match(r.text, /not installed in this workspace yet/);
      assert.equal(readFileSync(marker, 'utf8').trim(), '/plugin/npm');
    } finally {
      g.close();
    }
  });
});
