// Text-diet audit (PLAN.md rule 12): the words on every page, dialog, sheet and menu, and the parts the rule calls out.
// node tools/qa/textdiet.mjs [width ...]   (default 390 1280)  ->  /tmp/qa-shots/textdiet-<width>.json and .md, plus a screenshot per screen.
// Needs the QA portal running with data (workspace qa-ws1, some sessions, pools). Screens it cannot open are listed as "not opened".
import { writeFileSync } from 'node:fs';
import { Browser, SHOTS } from './browser.mjs';
import { api, login, openChat, sleep } from './lib.mjs';

/** Evaluated in the page: what a person reads on this screen (the open dialog or the page) and what the rule objects to. */
const MEASURE = `(() => {
  const root = document.querySelector('[role=dialog]:not([aria-label=Account]), [role=alertdialog]') ?? document.querySelector('[role=menu]') ?? document.querySelector('main') ?? document.body;
  const inDialog = root !== document.body && !root.matches('main');
  const vh = innerHeight;
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const words = (t) => (t.match(/[\\p{L}\\p{N}][\\p{L}\\p{N}'’.$%/:_-]*/gu) || []).length;
  let total = 0, inView = 0; const blocks = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.replace(/\\s+/g, ' ').trim(); if (!t) continue;
    const el = n.parentElement; if (!el || !vis(el) || el.closest('script, style, [aria-hidden=true]')) continue;
    const w = words(t); total += w;
    const r = el.getBoundingClientRect(); if (r.top < vh && r.bottom > 0) inView += w;
  }
  // Explanatory text: leaf-ish blocks of more than 9 words that are not user data (titles of things, transcript).
  for (const el of root.querySelectorAll('p, span, div, small, li')) {
    if (!vis(el) || el.closest('[aria-hidden=true]')) continue;
    if ([...el.children].some((c) => c.textContent.trim().length > 0 && !/^(B|I|EM|STRONG|CODE|A|SPAN|SVG|BR)$/.test(c.tagName))) continue;
    const t = el.innerText?.replace(/\\s+/g, ' ').trim() || ''; const w = words(t);
    if (w >= 10 && !el.closest('[data-transcript], .markdown, pre, code, textarea, input')) blocks.push({ w, t: t.slice(0, 110), size: parseFloat(getComputedStyle(el).fontSize) });
  }
  const uniq = []; const seen = new Set(); for (const b of blocks.sort((a, b) => b.w - a.w)) { if (seen.has(b.t)) continue; seen.add(b.t); uniq.push(b); }
  const tips = root.querySelectorAll('button[aria-label^="About"], button[aria-label*="Why"], button[aria-label*="More about"]').length;
  const badges = [...root.querySelectorAll('[class*="rounded-full"]')].filter((e) => vis(e) && e.innerText && e.innerText.trim().length > 0 && e.innerText.trim().length < 24 && parseFloat(getComputedStyle(e).fontSize) <= 13 && !e.closest('button, a, [role=tab], [role=radio], [role=switch]')).length;
  const boxed = (e) => { const s = getComputedStyle(e); const bw = parseFloat(s.borderTopWidth) + parseFloat(s.borderLeftWidth); return bw > 0 && parseFloat(s.borderTopLeftRadius) >= 12 && vis(e); };
  let nestedCards = 0; for (const e of root.querySelectorAll('*')) if (boxed(e)) { for (let p = e.parentElement; p && p !== root.parentElement; p = p.parentElement) if (boxed(p) && p !== e) { nestedCards++; break; } }
  const dividers = [...root.querySelectorAll('hr, [class*="h-px"], [class*="divide-"], [class*="border-t"], [class*="border-b"]')].filter(vis).length;
  const icons = [...root.querySelectorAll('svg')].filter((e) => vis(e) && e.getBoundingClientRect().width <= 40).length;
  const labelled = [...root.querySelectorAll('button, a[role=button]')].filter((e) => vis(e) && e.querySelector('svg') && words(e.innerText || '') >= 1 && words(e.innerText || '') <= 2).length;
  const fields = [...root.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(vis).length;
  return { inDialog, total, inView, paragraphs: uniq.slice(0, 6), paragraphCount: uniq.length, paragraphWords: uniq.reduce((a, b) => a + b.w, 0), tips, badges, nestedCards, dividers, icons, labelledIconButtons: labelled, fields };
})()`;

const pause = sleep;

async function main() {
  const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
  const widths = process.argv.slice(2).map(Number).filter(Boolean);
  const sizes = widths.length ? widths : [390, 1280];
  const cookie = await login();
  const call = api(cookie);
  const sessions = (await call('GET', '/api/chat/sessions')).data ?? [];
  const pick = (re) => sessions.find((s) => re.test(s.title));
  // A live chat with a little history (the screens of the composer, model sheet and panels need one that can answer).
  let live = null;
  try {
    const created = await call('POST', '/api/chat/sessions', { workspaceId: 'docker/qa-ws1', title: 'QA diet live' });
    if (created.status === 201) {
      const chat = await openChat(cookie, created.data.id);
      await chat.until((c) => c.session?.state === 'idle', 40000, 'idle');
      await chat.send('hello'); await chat.idle();
      await chat.send('[[md]]'); await chat.idle();
      chat.close();
      live = created.data;
    }
  } catch (e) {
    console.log('no live chat for the session screens:', e.message.split('\n')[0]);
  }
  const talk = live ?? pick(/^QA move2 1280/) ?? pick(/^QA xss/) ?? sessions[0];
  const ended = pick(/^QA bulk/);
  const ws = (await call('GET', '/api/workspaces')).data ?? [];
  const mine = ws.find((w) => w.name === 'qa-ws1');
  const tabs = ['accounts', 'skills', 'personas', 'contexts', 'mcp', 'secrets'];

  for (const width of sizes) {
    const phone = width < 640;
    const b = await Browser.launch({ width, height: phone ? 844 : 800 });
    const rows = [];
    const open = async (name, path, steps = async () => {}, { wait = 2500, ready } = {}) => {
      if (only.length && !only.includes(name)) return;
      try {
        if (path) await b.goto(path, 300);
        if (ready) await b.waitFor(ready, 20000, name).catch(() => {});
        await pause(wait);
        await steps();
        await pause(700);
        const m = await b.eval(MEASURE);
        rows.push({ name, ...m });
        await b.shot(`textdiet-${width}-${name}`);
      } catch (e) {
        rows.push({ name, notOpened: String(e.message).split('\n')[0].slice(0, 90) });
      }
      await b.key('Escape').catch(() => {});
      await pause(300);
    };
    const click = (text, o) => b.clickText(text, o);
    try {
      await b.signedIn();
      // ---- pages
      await b.cookie('');
      await open('login', '/login', async () => {}, { wait: 1200 });
      await b.signedIn();
      await open('workspaces', '/admin/workspaces', async () => {}, { ready: `document.body.innerText.includes('qa-ws1')` });
      await open('sessions', '/admin/sessions', async () => {}, { ready: `document.body.innerText.includes('QA')` });
      await open('tickets', '/admin/tickets');
      await open('knowledge', '/admin/knowledge');
      await open('usage', '/admin/usage');
      for (const t of tabs) await open(`pools-${t}`, `/admin/pools?tab=${t}`);
      await open('access', '/admin/access');
      await open('access-mcp', '/admin/access', async () => { await click('MCP', { selector: '[role=tab], button', exact: true }); });
      if (talk) await open('session', `/admin/sessions/${talk.id}`, async () => {}, { wait: 3500 });
      if (mine) await open('shell', `/admin/workspaces/${mine.id}/shell`, async () => {}, { wait: 3500 });
      // ---- shell chrome
      await open('account-menu', '/admin/usage', async () => { await b.eval(`[...document.querySelectorAll('button[aria-label="Account menu"]')].find((e) => e.offsetParent).click()`); });
      if (phone) await open('more-sheet', '/admin/usage', async () => { await b.clickSel('button[aria-label="More"]'); });
      // ---- workspaces
      const wsReady = { ready: `document.body.innerText.includes('qa-ws1')` };
      await open('new-workspace', '/admin/workspaces', async () => { await click(phone ? 'New' : 'New workspace', { exact: phone }); }, wsReady);
      await open('workspace-row-menu', '/admin/workspaces', async () => { await click('Actions for qa-ws1'); }, wsReady);
      await open('workspace-details', '/admin/workspaces', async () => { await click('Details for qa-ws1'); }, wsReady);
      await open('workspace-config', '/admin/workspaces', async () => { await click('Actions for qa-ws1'); await pause(400); await click('Configuration', { selector: '[role=menuitem]' }); }, { ...wsReady, wait: 3000 });
      await open('workspace-remove', '/admin/workspaces', async () => { await click('Actions for qa-ws1'); await pause(400); await click('Remove', { selector: '[role=menuitem]' }); }, wsReady);
      await open('bulk-assign', '/admin/workspaces', async () => { await click('Select', { exact: true }); await pause(400); await click('Select qa-ws1', { selector: '[role=checkbox]' }); await click('Assign pool'); }, wsReady);
      // ---- sessions
      await open('new-session', '/admin/sessions', async () => { await click(phone ? 'New' : 'New session', { exact: phone }); }, { ready: `document.body.innerText.includes('QA')`, wait: 3000 });
      await open('session-row-menu', '/admin/sessions', async () => { await click('Actions for QA', { }); }, { ready: `document.body.innerText.includes('QA')` });
      if (talk) {
        const page = `/admin/sessions/${talk.id}`;
        await open('session-menu', page, async () => { await click('Session actions'); }, { wait: 3500 });
        await open('session-rename', page, async () => { await click('Session actions'); await pause(400); await click('Rename', { selector: '[role=menuitem]' }); }, { wait: 3500 });
        await open('session-delete', page, async () => { await click('Session actions'); await pause(400); await click('Delete', { selector: '[role=menuitem]' }); }, { wait: 3500 });
        await open('session-move', page, async () => { await click('Session actions'); await pause(400); await click('Move to another Claude', { selector: '[role=menuitem]' }); await pause(1500); }, { wait: 3500 });
        await open('session-model', page, async () => { await click('Model and effort'); }, { wait: 3500 });
        await open('session-mode', page, async () => { await click('Permission mode'); }, { wait: 3500 });
        await open('session-usage', page, async () => { await click('Session actions'); await pause(400); await click('Usage', { selector: '[role=menuitem]' }); }, { wait: 3500 });
        await open('session-files', page, async () => { if (phone) { await click('Session actions'); await pause(400); await click('Files and changes', { selector: '[role=menuitem]' }); } else await click('Files', { exact: true }); await pause(1500); }, { wait: 3500 });
        await open('session-attach', page, async () => { await click('Attach images'); }, { wait: 3500 });
      }
      if (ended) await open('session-ended', `/admin/sessions/${ended.id}`, async () => {}, { wait: 3500 });
      // ---- pools
      await open('add-key', '/admin/pools?tab=accounts', async () => { await click(phone ? 'Add' : 'Add key', { exact: phone }); });
      await open('key-menu', '/admin/pools?tab=accounts', async () => { await click('Actions for qa-acct-1'); });
      await open('new-pool', '/admin/pools?tab=accounts', async () => { await click('New', { selector: 'button', exact: true }); });
      await open('custom-endpoint', '/admin/pools?tab=accounts', async () => { await click('Custom', { exact: true }); });
      await open('secret-editor', '/admin/pools/secrets/new', async () => {}, { wait: 3000 });
      await open('mcp-catalog', '/admin/pools/mcp/catalog', async () => {}, { wait: 3000 });
      // ---- access
      await open('access-custom-code', '/admin/access', async () => { await click('Set a custom code'); });
      await open('access-rotate', '/admin/access', async () => { await click('Rotate', { exact: true }); });
    } finally {
      await b.close();
    }
    if (width === sizes.at(-1) && live) await call('POST', `/api/chat/sessions/${live.id}/end`, {});
    writeFileSync(`${SHOTS}/textdiet-${width}.json`, JSON.stringify(rows, null, 1));
    const md = ['| Screen | Words (all / in view) | Paragraphs (count, words) | Info buttons | Badges | Nested cards | Dividers | Icons | Icon+word buttons | Fields |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
    for (const r of rows) md.push(r.notOpened ? `| ${r.name} | not opened: ${r.notOpened} | | | | | | | | |` : `| ${r.name} | ${r.total} / ${r.inView} | ${r.paragraphCount}, ${r.paragraphWords} | ${r.tips} | ${r.badges} | ${r.nestedCards} | ${r.dividers} | ${r.icons} | ${r.labelledIconButtons} | ${r.fields} |`);
    writeFileSync(`${SHOTS}/textdiet-${width}.md`, md.join('\n'));
    console.log(`\n=== ${width}px\n${md.join('\n')}`);
  }
}

await main();
