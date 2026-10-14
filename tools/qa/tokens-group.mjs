// Access → MCP, Tokens grouped by label (T-258): a label with several live tokens is one row (count, scopes, newest expiry, last use) that
// opens to its tokens, with "Revoke older" and "Revoke all" behind a confirmation that says how many; New token offers 15 minutes to 365
// days and answers a used label with Replace or Add another.
// QA_PORT=3481 QA_CODE=24681372 QA_SHOTS=<dir> node tools/qa/tokens-group.mjs   (a scratch portal; it mints tokens there, never prints one)
import { AUDIT, Browser, SHOTS } from './browser.mjs';
import { api, login, sleep } from './lib.mjs';

const cookie = await login();
const call = api(cookie);
const must = async (p, what) => {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.body?.error?.code ?? ''}`);
  return r;
};
await must(call('PUT', '/api/portal-mcp/settings', { enabled: true }), 'enable MCP');
const state = (await call('GET', '/api/portal-mcp')).data;
if (!state.tokens.some((t) => t.label === 'coordinator' && !t.revokedAt)) {
  for (let i = 0; i < 3; i++) await must(call('POST', '/api/portal-mcp/tokens', { label: 'coordinator', scope: 'admin', expiresIn: i === 0 ? '15m' : '7d', addAnother: i > 0 }), 'mint coordinator');
  await must(call('POST', '/api/portal-mcp/tokens', { label: 'Claude Code, laptop', scope: 'read', expiresIn: '90d' }), 'mint laptop');
}
const dup = await call('POST', '/api/portal-mcp/tokens', { label: 'coordinator', scope: 'admin', expiresIn: '1h' });
const capped = await call('POST', '/api/portal-mcp/tokens', { label: 'coordinator', scope: 'admin', expiresIn: '1h', addAnother: true });
const results = { duplicate: [dup.status, dup.body?.error?.code, dup.body?.error?.details?.live], cap: [capped.status, capped.body?.error?.code], screens: {} };

const failures = [];
for (const dark of [false, true]) {
  for (const [w, h] of [[390, 844], [1280, 800]]) {
    const tag = `${w}-${dark ? 'dark' : 'light'}`;
    const b = await Browser.launch({ width: w, height: h, dark, mobile: w < 600, cookie });
    try {
      await b.goto('/admin/access?tab=mcp', 2500);
      await b.waitFor(`[...document.querySelectorAll('button[aria-expanded]')].some((e) => e.innerText.includes('coordinator'))`, 10000, 'the coordinator group');
      await b.shot(`tokens-${tag}`, { full: true });
      const audit = await b.eval(AUDIT);
      const group = await b.eval(`(() => { const e = [...document.querySelectorAll('button[aria-expanded]')].find((e) => e.innerText.includes('coordinator')); const r = e.getBoundingClientRect(); return { h: Math.round(r.height), text: e.innerText.replace(/\\s+/g, ' ') }; })()`);
      if (audit.hscroll) failures.push(`${tag}: horizontal scroll`);
      if (w < 600 && group.h < 44) failures.push(`${tag}: group row ${group.h}px`);
      await b.clickText('coordinator', { selector: 'button[aria-expanded]' });
      await sleep(400);
      await b.shot(`tokens-open-${tag}`, { full: true });
      await b.clickText('Actions for coordinator');
      await sleep(400);
      await b.shot(`tokens-menu-${tag}`);
      await b.clickText('Revoke older', { selector: '[role=menuitem], button' });
      await sleep(600);
      const title = await b.eval(`document.querySelector('[role=alertdialog], [role=dialog]')?.innerText.replace(/\\s+/g, ' ') ?? ''`);
      if (!/Revoke 2 “coordinator” tokens\?/.test(title)) failures.push(`${tag}: confirmation says "${title.slice(0, 80)}"`);
      await b.shot(`tokens-confirm-${tag}`);
      await b.key('Escape');
      await sleep(400);
      await b.clickText('New', { exact: true });
      await sleep(600);
      await b.focusSel('[role=dialog] input');
      await b.type('coordinator');
      await b.clickText('Create', { selector: '[role=dialog] button', exact: true });
      await sleep(900);
      const inUse = await b.eval(`document.querySelector('[role=dialog] [role=alert]')?.innerText.replace(/\\s+/g, ' ') ?? ''`);
      if (!/live with this label/.test(inUse)) failures.push(`${tag}: no Replace / Add another ("${inUse.slice(0, 60)}")`);
      await b.shot(`tokens-new-${tag}`, { full: true });
      const options = await b.eval(`[...document.querySelectorAll('[role=dialog] select option')].map((o) => o.textContent)`);
      if (options.join() !== '15 minutes,1 hour,1 day,7 days,30 days,90 days,365 days') failures.push(`${tag}: lifetimes ${options.join()}`);
      results.screens[tag] = { group, hscroll: audit.hscroll, small: w < 600 ? audit.small.filter((s) => /coordinator|Revoke/.test(s)) : undefined };
    } finally {
      await b.close();
    }
  }
}
console.log(JSON.stringify({ ...results, failures, shots: SHOTS }, null, 1));
process.exit(failures.length ? 1 : 0);
