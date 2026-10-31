// UI reporter connect (PILOT-1111): the popup cannot always reach its opener. Signing in inside the popup goes through the portal's own
// pages, whose Cross-Origin-Opener-Policy (same-origin) puts the popup in a new browsing context group: window.opener is null for good,
// even back on /reporter/v1/connect. The page used to stop there ("The reporter window is gone"); it now asks the server to hold the
// approval and the panel claims it with the verifier only it knows.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { REPORTER_TOKEN_PREFIX } from '@portal/contracts';
import { CONNECT_HOLD_MS, connectNonceOf } from './routes.js';
import { connectCode } from './pages.js';
import { PORTAL, STG, UAT, reporterHarness } from './testkit.js';

const body = async (r: Response) => (await r.json()) as { data: Record<string, unknown> };
const pair = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, nonce: connectNonceOf(verifier) };
};

async function rig(opts: { now?: () => Date } = {}) {
  const h = await reporterHarness(opts);
  const approve = (b: Record<string, unknown>, headers: Record<string, string> = { origin: PORTAL }) =>
    h.call('/reporter/v1/connect', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
  const claim = (b: Record<string, unknown>, headers: Record<string, string> = { origin: PORTAL, 'sec-fetch-site': 'same-origin' }) =>
    h.call('/reporter/v1/connect/claim', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
  return { h, approve, claim };
}

test('connect page: no dead end without an opener; it asks the server to hold the approval, and refuses an opener of another origin', async () => {
  const { h } = await rig();
  try {
    const { nonce } = pair();
    const page = await (await h.call(`/reporter/v1/connect?bucket=KONF&origin=${encodeURIComponent(STG)}&nonce=${nonce}`)).text();
    assert.doesNotMatch(page, /reporter window is gone/, 'the old dead end');
    assert.match(page, /hold:!o/, 'no opener of this origin => hold');
    assert.match(page, /x===location\.origin\?o:/, 'the opener must be a window of the portal origin');
    assert.match(page, /not opened by the reporter/, 'an opener of another origin is refused');
    assert.match(page, /o\.postMessage\(d,location\.origin\)/, 'the token goes to the portal origin only');
    assert.doesNotMatch(page, /postMessage\([^)]*['"]\*['"]/);
    assert.ok(page.includes(connectCode(nonce)), 'the code the panel shows too');
    assert.match(page, /<svg class="mark"/, 'the pilot mark, inline (the CSP allows no other source)');
    assert.doesNotMatch(page, /<img/);
    assert.match(page, /id="ok"[^>]*>Approve<\/button>/, 'the button says what it does');
  } finally {
    h.done();
  }
});

test('connect hold: no token to the popup, one claim with the verifier, same pending for anything else, CSRF and same-origin kept', async () => {
  const { h, approve, claim } = await rig();
  try {
    const { verifier, nonce } = pair();
    const held = await approve({ bucket: 'KONF', origin: STG, nonce, hold: true });
    assert.equal(held.status, 200);
    const heldText = await held.text();
    assert.ok(!heldText.includes(REPORTER_TOKEN_PREFIX), 'the popup gets no token when it holds');
    assert.deepEqual(JSON.parse(heldText).data, { held: true });

    const pending = { pending: true };
    assert.deepEqual((await body(await claim({ bucket: 'KONF', origin: STG, verifier: pair().verifier }))).data, pending, 'another verifier');
    assert.deepEqual((await body(await claim({ bucket: 'KONF', origin: STG, verifier: nonce }))).data, pending, 'the nonce itself is not the verifier');
    assert.deepEqual((await body(await claim({ bucket: 'KONF', origin: UAT, verifier }))).data, pending, 'another origin');
    assert.deepEqual((await body(await claim({ bucket: 'OTHER', origin: STG, verifier }))).data, pending, 'another bucket');
    assert.equal((await claim({ bucket: 'KONF', origin: STG, verifier }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status, 404, 'a cross-site claim');

    const ok = (await body(await claim({ bucket: 'KONF', origin: STG, verifier }))).data;
    assert.equal(ok.type, 'pilot-reporter:connected');
    assert.equal(ok.nonce, nonce, 'the nonce the panel put in the popup URL');
    assert.ok(String(ok.token).startsWith(REPORTER_TOKEN_PREFIX));
    assert.ok(h.service.verify(String(ok.token)), 'the claimed token works');
    assert.deepEqual((await body(await claim({ bucket: 'KONF', origin: STG, verifier }))).data, pending, 'one use');

    // The approval itself keeps its rules: cookie, same origin, an allowed site.
    assert.equal((await approve({ bucket: 'KONF', origin: STG, nonce, hold: true }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await approve({ bucket: 'KONF', origin: 'https://evil.example', nonce, hold: true })).status, 404);
    h.setSignedIn(false);
    assert.equal((await approve({ bucket: 'KONF', origin: STG, nonce, hold: true })).status, 401);
  } finally {
    h.done();
  }
});

test('connect hold: expires after two minutes', async () => {
  let now = Date.now();
  const { h, approve, claim } = await rig({ now: () => new Date(now) });
  try {
    const { verifier, nonce } = pair();
    await approve({ bucket: 'KONF', origin: STG, nonce, hold: true });
    now += CONNECT_HOLD_MS + 1;
    assert.deepEqual((await body(await claim({ bucket: 'KONF', origin: STG, verifier }))).data, { pending: true });
  } finally {
    h.done();
  }
});
