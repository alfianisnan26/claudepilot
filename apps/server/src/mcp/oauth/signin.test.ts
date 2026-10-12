import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { SignIns } from './signin.js';
import type { OAuthServer } from './status.js';
import { FakeLoginHost } from './testkit.js';

const WS = 'docker/lab';
const ACTOR = 'u_test';
const server = (kind: string, key = 'gitea'): OAuthServer => ({ plugin: `cpm-${kind}`, key, name: 'Gitea' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls instead of sleeping: a fake login is a real process, and a loaded machine starts it slowly. */
async function eventually(cond: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;

function setup(limits = {}) {
  const host = new FakeLoginHost();
  const logs: string[] = [];
  const signIns = new SignIns(() => host, (l) => logs.push(l), limits);
  return { host, logs, signIns, done: () => host.done() };
}
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
const callbackWith = (start: { url: string; callback: string | null }, code: string) => `${start.callback}?code=${code}&state=${stateOf(start.url)}`;

test('start: the URL Claude Code printed, without its terminal escapes, and where it listens', async () => {
  const t = setup();
  try {
    const start = await t.signIns.start(WS, '', server('ok'), ACTOR);
    assert.match(start.url, /^https:\/\/git\.example\.com\/login\/oauth\/authorize\?/);
    assert.ok(!start.url.includes('\x1b'));
    assert.equal(start.callback, 'http://localhost:24819/callback');
    assert.ok(Date.parse(start.expiresAt) > Date.now());
    assert.equal(t.signIns.count(WS), 1);
    // It ran the portal's own script with the Claude folder and the server as plain arguments.
    assert.deepEqual(t.host.shells[0]!.command.slice(0, 2), ['sh', '-c']);
    assert.deepEqual(t.host.shells[0]!.command.slice(-2), ['', 'plugin:cpm-ok:gitea']);
    await t.signIns.cancel(WS, start.signInId, ACTOR);
  } finally {
    t.done();
  }
});

test('complete: the pasted address reaches Claude Code once, and the sign-in is over', async () => {
  const t = setup();
  try {
    const start = await t.signIns.start(WS, '', server('ok'), ACTOR);
    const done = await t.signIns.complete(WS, start.signInId, callbackWith(start, 'goodcode'));
    assert.deepEqual(done, { server: server('ok'), dir: '', startedBy: ACTOR });
    assert.equal(t.host.read().length, 1);
    assert.match(t.host.read()[0]!, /code=goodcode/);
    assert.equal(t.signIns.count(), 0);
    // A second complete (a double tap) still answers "signed in", and writes nothing more to a login that is gone.
    assert.deepEqual(await t.signIns.complete(WS, start.signInId, callbackWith(start, 'goodcode')), { server: server('ok'), dir: '', startedBy: ACTOR });
    await assert.rejects(() => t.signIns.complete('docker/else', start.signInId, callbackWith(start, 'goodcode')), code('CONFLICT'), 'not for another workspace');
    assert.equal(t.host.read().length, 1);
    assert.ok(t.logs.every((l) => !/goodcode/.test(l)), 'no log line holds the code');
    assert.ok(t.logs.some((l) => /finished for plugin:cpm-ok:gitea/.test(l)));
  } finally {
    t.done();
  }
});

test('complete: an address that is not this sign-in’s never reaches the terminal; a refused one can be tried again', async () => {
  const t = setup();
  try {
    const start = await t.signIns.start(WS, 'claudes/0123456789abcdef', server('ok'), ACTOR);
    for (const bad of ['', 'hello', 'http://localhost:9999/callback?code=a&state=b', `${start.callback}?code=a`, `${start.callback}?code=a&state=b\nrm -rf ~`]) {
      await assert.rejects(() => t.signIns.complete(WS, start.signInId, bad), code('VALIDATION_FAILED'), JSON.stringify(bad));
    }
    assert.deepEqual(t.host.read(), [], 'nothing was written to the login');
    // Well formed, but not the state Claude Code is waiting for: it re-prompts, the sign-in stays open.
    await assert.rejects(
      () => t.signIns.complete(WS, start.signInId, `${start.callback}?code=goodcode&state=WRONG`),
      (e) => isAppError(e) && e.code === 'VALIDATION_FAILED' && /doesn’t accept that address/.test(e.message),
    );
    assert.equal(t.signIns.count(WS), 1);
    // The state it was started with works, even with the loopback name a phone shows.
    const done = await t.signIns.complete(WS, start.signInId, `http://127.0.0.1:24819/callback?code=goodcode&state=${stateOf(start.url)}`);
    assert.equal(done.dir, 'claudes/0123456789abcdef');
    assert.equal(t.host.read().length, 2, 'the wrong state and the good one');
  } finally {
    t.done();
  }
});

test('complete: the provider’s refusal ends the sign-in, in words that hold no code', async () => {
  const t = setup();
  try {
    const start = await t.signIns.start(WS, '', server('ok'), ACTOR);
    const denied = `${start.callback}?error=access_denied&error_description=User+denied&state=${stateOf(start.url)}`;
    await assert.rejects(
      () => t.signIns.complete(WS, start.signInId, denied),
      (e) => isAppError(e) && e.code === 'SERVICE_UNAVAILABLE' && e.expose && /Sign-in ended: OAuth error: access_denied - User denied\. Start again\./.test(e.message),
    );
    assert.equal(t.signIns.count(), 0);
    // Claude Code echoed the address in its complaint: the message must not.
    const start2 = await t.signIns.start(WS, '', server('ok'), ACTOR);
    const pasted = callbackWith(start2, 'bad-code-1234');
    await assert.rejects(
      () => t.signIns.complete(WS, start2.signInId, pasted),
      (e) => isAppError(e) && /^Sign-in ended: invalid_grant at /.test(e.message) && !/bad-code-1234|st[a-z0-9]{8}/.test(e.message + JSON.stringify(e.details ?? '')),
    );
    assert.ok(t.logs.every((l) => !/bad-code-1234|goodcode/.test(l)));
  } finally {
    t.done();
  }
});

test('start: Claude Code that can’t start it says why; nothing is left running', async () => {
  const t = setup({ linkMs: 15_000 });
  const quiet = setup({ linkMs: 800 });
  try {
    await assert.rejects(() => t.signIns.start(WS, '', server('none'), ACTOR), /hasn’t loaded this server yet/);
    await assert.rejects(() => t.signIns.start(WS, '', server('nourl'), ACTOR), /Incompatible auth server: does not support dynamic client registration/);
    await assert.rejects(() => t.signIns.start(WS, '', server('http'), ACTOR), /isn’t https/);
    await assert.rejects(() => t.signIns.start(WS, '', server('garbled'), ACTOR), /didn’t start the sign-in: error: unknown option '--no-browser'\./);
    await assert.rejects(() => quiet.signIns.start(WS, '', server('silent'), ACTOR), /no sign-in address appeared/);
    assert.equal(t.signIns.count() + quiet.signIns.count(), 0);
    await eventually(() => t.host.alive().length + quiet.host.alive().length === 0, 'every login to stop');
  } finally {
    t.done();
    quiet.done();
  }
});

test('cancel and replace stop the process and free the slot', async () => {
  const t = setup();
  try {
    const a = await t.signIns.start(WS, '', server('ok'), ACTOR);
    const b = await t.signIns.start(WS, '', server('ok'), ACTOR);
    assert.notEqual(a.signInId, b.signInId);
    assert.equal(t.signIns.count(), 1, 'starting again replaced the first');
    await assert.rejects(() => t.signIns.complete(WS, a.signInId, callbackWith(a, 'goodcode')), code('CONFLICT'));
    await t.signIns.cancel(WS, b.signInId, ACTOR);
    await t.signIns.cancel(WS, b.signInId, ACTOR); // twice is fine
    assert.equal(t.signIns.count(), 0);
    await eventually(() => t.host.alive().length === 0, 'both logins to stop');

    // Another workspace's id can't cancel or complete it.
    const c = await t.signIns.start(WS, '', server('ok', 'other'), ACTOR);
    await t.signIns.cancel('docker/else', c.signInId, ACTOR);
    assert.equal(t.signIns.count(), 1);
    await assert.rejects(() => t.signIns.complete('docker/else', c.signInId, callbackWith(c, 'goodcode')), code('CONFLICT'));
  } finally {
    t.done();
  }
});

test('a sign-in nobody completes ends by itself, and its process stops', async () => {
  const t = setup({ signInMs: 1500 });
  try {
    await t.signIns.start(WS, '', server('ok'), ACTOR);
    assert.equal(t.signIns.count(), 1);
    await eventually(() => t.signIns.count() === 0, 'the sign-in to expire');
    await eventually(() => t.host.alive().length === 0, 'its login to stop');
  } finally {
    t.done();
  }
});

test('a login that ignores Ctrl-C is stopped by its PID', async () => {
  const t = setup({ exitMs: 300 });
  try {
    const start = await t.signIns.start(WS, '', server('stubborn'), ACTOR);
    const child = t.host.shells[0]!.child;
    await t.signIns.cancel(WS, start.signInId, ACTOR);
    assert.deepEqual(t.host.kills, [['kill', String(child.pid)]]);
    await eventually(() => t.host.alive().length === 0, 'the login to stop');
  } finally {
    t.done();
  }
});

test('limits: a workspace holds a few open sign-ins at most', async () => {
  const t = setup();
  try {
    for (const key of ['a', 'b', 'c', 'd']) await t.signIns.start(WS, '', server('ok', key), ACTOR);
    await assert.rejects(() => t.signIns.start(WS, '', server('ok', 'e'), ACTOR), code('CONFLICT'));
    await t.signIns.forgetWorkspace(WS);
    assert.equal(t.signIns.count(), 0);
  } finally {
    t.done();
  }
});

test('a sign-in the browser finished by itself (same machine) is reported, and a later paste still answers', async () => {
  const t = setup();
  try {
    const seen: string[] = [];
    t.signIns.onSignedIn = (ws, dir, s, actor) => seen.push(`${ws}|${dir}|${s.plugin}/${s.key}|${actor}`);
    const start = await t.signIns.start(WS, '', server('selfdone'), ACTOR);
    await eventually(() => seen.length > 0, 'the login to finish by itself');
    assert.deepEqual(seen, [`${WS}||cpm-selfdone/gitea|${ACTOR}`]);
    assert.equal(t.signIns.count(), 0);
    assert.deepEqual(await t.signIns.complete(WS, start.signInId, callbackWith(start, 'goodcode')), { server: server('selfdone'), dir: '', startedBy: ACTOR });
    assert.deepEqual(t.host.read(), [], 'nothing was written to the login that had finished');
  } finally {
    t.done();
  }
});

test('start: only a Claude folder and a portal server name are accepted', async () => {
  const t = setup();
  try {
    await assert.rejects(() => t.signIns.start(WS, '../x', server('ok'), ACTOR), code('VALIDATION_FAILED'));
    await assert.rejects(() => t.signIns.start(WS, '', { plugin: 'cpm-ok; rm', key: 'a', name: 'x' }, ACTOR), code('VALIDATION_FAILED'));
    await assert.rejects(() => t.signIns.start(WS, '', { plugin: 'cpm-ok', key: 'A b', name: 'x' }, ACTOR), code('VALIDATION_FAILED'));
    assert.equal(t.host.shells.length, 0);
  } finally {
    t.done();
  }
});
