// Screenshots every page at phone and desktop size, light and dark, with the generic page audit for each.
// usage: node tools/qa/sweep.mjs [prefix]   writes /tmp/qa-shots/<prefix>-<page>-<w>-<theme>.png and prints the audit summary
import { writeFileSync } from 'node:fs';
import { AUDIT, Browser, SHOTS } from './browser.mjs';
import { api, login } from './lib.mjs';

const prefix = process.argv[2] ?? 'sweep';
const cookie = await login();
const call = api(cookie);
const sessions = (await call('GET', '/api/chat/sessions?limit=100')).data?.items ?? [];
const withTranscript = sessions.find((s) => s.title === 'QA xss transcript') ?? sessions[0];
const ws = (await call('GET', '/api/workspaces')).data ?? [];
const mine = ws.find((w) => w.name.startsWith('qa-'));
const pages = [
  ['home', '/admin/home'],
  ['workspaces', '/admin/workspaces'],
  ['sessions', '/admin/sessions'],
  ['usage', '/admin/usage'],
  ['tickets', '/admin/tickets'],
  ['knowledge', '/admin/knowledge'],
  ['pools-accounts', '/admin/pools?tab=accounts'],
  ['pools-skills', '/admin/pools?tab=skills'],
  ['pools-personas', '/admin/pools?tab=personas'],
  ['pools-contexts', '/admin/pools?tab=contexts'],
  ['pools-mcp', '/admin/pools?tab=mcp'],
  ['pools-secrets', '/admin/pools?tab=secrets'],
  ['access', '/admin/access'],
  ...(withTranscript ? [['session', `/admin/sessions/${withTranscript.id}`]] : []),
  ...(mine ? [['shell', `/admin/workspaces/${mine.id}/shell`]] : []),
];
const results = [];
for (const [width, height] of [
  [390, 844],
  [1280, 800],
]) {
  for (const dark of [false, true]) {
    const b = await Browser.launch({ width, height, dark, mobile: width < 600 });
    await b.signedIn();
    for (const [name, path] of pages) {
      await b.goto(path, name === 'workspaces' ? 6500 : 3500);
      const audit = await b.eval(AUDIT);
      const file = await b.shot(`${prefix}-${name}-${width}-${dark ? 'dark' : 'light'}`);
      results.push({ name, width, dark, audit, file });
    }
    // The login page, signed out.
    await b.cookie('');
    await b.goto('/login', 2000);
    const audit = await b.eval(AUDIT);
    await b.shot(`${prefix}-login-${width}-${dark ? 'dark' : 'light'}`);
    results.push({ name: 'login', width, dark, audit });
    results.at(-1).errors = [...b.errors];
    await b.close();
  }
}
writeFileSync(`${SHOTS}/${prefix}-audit.json`, JSON.stringify(results, null, 1));
for (const r of results) {
  const a = r.audit;
  console.log(
    `${r.name.padEnd(15)} ${String(r.width).padEnd(5)} ${r.dark ? 'dark ' : 'light'} interactive=${a.interactive} small=${a.smallCount} hscroll=${a.hscroll ? JSON.stringify(a.hscroll) : '-'} overflow=${a.overflowing.length} unnamed=${a.unnamed.length} noLabel=${a.inputsNoLabel.length} dupIds=${a.dupIds.length} h1=${a.h1.length}`,
  );
}
