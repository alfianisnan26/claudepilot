// Local pages for driving a browser through MCP in tests and by hand: every tool class the browser pool
// promises (navigation, forms, scrolling, iframes, dialogs, downloads, uploads, console and network, drag)
// against pages served from the workspace's own loopback, so nothing needs the internet.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const page = (title: string, body: string, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1">${head}</head><body>${body}</body></html>`;

const INDEX = page(
  'CP Test Home',
  `<h1>CP Test Home</h1>
<nav><a href="/second">Second page</a> · <a href="/scroll">Scroll page</a> · <a href="/frames">Frames</a> · <a href="/dialogs">Dialogs</a> · <a href="/downloads">Downloads</a> · <a href="/upload">Upload</a> · <a href="/console">Console</a> · <a href="/drag">Drag</a> · <a href="/cookies">Cookies</a></nav>
<p id="counter">Count: 0</p>
<button id="count" onclick="n++;document.getElementById('counter').textContent='Count: '+n">Count up</button>
<button id="hoverme" onmouseover="document.getElementById('hovered').textContent='Hovered: yes'">Hover me</button> <span id="hovered">Hovered: no</span>
<form id="signup" method="post" action="/submit">
  <label>Name <input id="name" name="name" autocomplete="off"></label>
  <label>Email <input id="email" name="email" type="email" autocomplete="off"></label>
  <label>Colour <select id="colour" name="colour"><option value="red">Red</option><option value="green">Green</option><option value="blue">Blue</option></select></label>
  <label><input id="agree" type="checkbox" name="agree" value="yes"> I agree</label>
  <label>Notes <textarea id="notes" name="notes"></textarea></label>
  <button type="submit">Send form</button>
</form>
<p id="keys">Keys: </p>
<script>
var n=0;
document.addEventListener('keydown',function(e){document.getElementById('keys').textContent+=e.key+' '});
</script>`,
);

const SCROLL = page(
  'CP Scroll',
  `<h1>CP Scroll</h1><p id="pos">scrollY: 0</p>${'<p>Filler line for scrolling.</p>'.repeat(120)}<p id="bottom">The very bottom</p>
<script>addEventListener('scroll',function(){document.getElementById('pos').textContent='scrollY: '+Math.round(scrollY)});</script>`,
);

const FRAMES = page(
  'CP Frames',
  `<h1>CP Frames</h1><iframe id="inner" title="inner frame" src="/frame" width="400" height="160"></iframe>`,
);
const FRAME = page('CP Frame', `<p id="msg">Frame idle</p><button id="inframe" onclick="document.getElementById('msg').textContent='Frame clicked'">Click inside frame</button>`);

const DIALOGS = page(
  'CP Dialogs',
  `<h1>CP Dialogs</h1><p id="result">no dialog yet</p>
<button id="alert" onclick="alert('Hello alert');document.getElementById('result').textContent='alert closed'">Alert</button>
<button id="confirm" onclick="document.getElementById('result').textContent='confirm: '+confirm('Proceed?')">Confirm</button>
<button id="prompt" onclick="document.getElementById('result').textContent='prompt: '+prompt('Your name?','nobody')">Prompt</button>`,
);

const DOWNLOADS = page('CP Downloads', `<h1>CP Downloads</h1><a id="csv" href="/file.csv" download>report.csv</a> <a id="txt" href="/file.txt">notes.txt (attachment)</a>`);

const UPLOAD = page(
  'CP Upload',
  `<h1>CP Upload</h1><input id="file" type="file"><p id="info">no file</p>
<script>document.getElementById('file').addEventListener('change',function(e){var f=e.target.files[0];document.getElementById('info').textContent=f?('file: '+f.name+' ('+f.size+' bytes)'):'no file'});</script>`,
);

const CONSOLE = page(
  'CP Console',
  `<h1>CP Console</h1><p id="out">waiting</p>
<script>
console.log('cp-log hello');console.warn('cp-warn careful');console.error('cp-error broken');
fetch('/api/ping?x=1').then(function(r){return r.json()}).then(function(j){document.getElementById('out').textContent='ping '+j.pong});
fetch('/api/missing').catch(function(){});
</script>`,
);

const DRAG = page(
  'CP Drag',
  `<h1>CP Drag</h1><div id="src" draggable="true" style="width:90px;height:40px;background:#cde;margin:8px">Drag me</div>
<div id="dst" style="width:200px;height:80px;border:2px dashed #888;margin:8px">Drop here</div><p id="state">not dropped</p>
<script>
var dst=document.getElementById('dst');
dst.addEventListener('dragover',function(e){e.preventDefault()});
dst.addEventListener('drop',function(e){e.preventDefault();document.getElementById('state').textContent='dropped'});
</script>`,
);

/** For the proxy view: elements at fixed positions, and a title that says what the page last saw. */
const VIEW = page(
  'view-ready',
  `<button id="b" style="position:fixed;left:10px;top:10px;width:100px;height:40px" onclick="document.title='clicked'">go</button>
<input id="i" style="position:fixed;left:10px;top:70px;width:200px;height:30px" oninput="document.title='typed:'+this.value" autocomplete="off">
<button id="a" style="position:fixed;left:10px;top:120px;width:100px;height:40px" onclick="alert('hello from the page');document.title='alert closed'">alert</button>
<div style="height:4000px"></div>
<script>addEventListener('scroll',function(){document.title='scroll:'+Math.round(scrollY)});addEventListener('contextmenu',function(e){document.title='context'});</script>`,
);

const SECOND = page('CP Second', `<h1>CP Second</h1><p>This is the second page.</p><a href="/">Home</a>`);

const COOKIES = page(
  'CP Cookies',
  `<h1>CP Cookies</h1><p id="c"></p><form method="post" action="/login"><label>User <input id="user" name="user" autocomplete="off"></label><label>Password <input id="pass" name="pass" type="password" autocomplete="off"></label><button>Sign in</button></form>
<script>document.getElementById('c').textContent='cookie: '+document.cookie</script>`,
);

export interface TestPages {
  server: Server;
  port: number;
  url: (path?: string) => string;
  /** Requests received, for what a page's own network calls and submitted forms did. */
  requests: { method: string; path: string; body: string }[];
  close: () => Promise<void>;
}

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

/** Serves the pages on 127.0.0.1 (`port` 0 picks one). */
export async function serveTestPages(port = 0): Promise<TestPages> {
  const requests: TestPages['requests'] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const body = req.method === 'POST' ? await readBody(req) : '';
      requests.push({ method: req.method ?? 'GET', path, body });
      const html = (text: string, extra: Record<string, string> = {}) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra });
        res.end(text);
      };
      switch (path) {
        case '/':
          return html(INDEX);
        case '/second':
          return html(SECOND);
        case '/view':
          return html(VIEW);
        case '/scroll':
          return html(SCROLL);
        case '/frames':
          return html(FRAMES);
        case '/frame':
          return html(FRAME);
        case '/dialogs':
          return html(DIALOGS);
        case '/downloads':
          return html(DOWNLOADS);
        case '/upload':
          return html(UPLOAD);
        case '/console':
          return html(CONSOLE);
        case '/drag':
          return html(DRAG);
        case '/cookies':
          return html(COOKIES);
        case '/login':
          return html(page('CP Signed in', `<h1>Signed in</h1><p id="who">welcome</p>`), { 'set-cookie': 'cp_session=abc123; Path=/; HttpOnly' });
        case '/submit':
          return html(page('CP Submitted', `<h1>Submitted</h1><pre id="posted">${body.replace(/</g, '&lt;')}</pre>`));
        case '/slow':
          await new Promise((r) => setTimeout(r, 1500));
          return html(page('CP Slow', '<h1>Slow page</h1>'));
        case '/api/ping':
          res.writeHead(200, { 'content-type': 'application/json' });
          return void res.end('{"pong":"ok"}');
        case '/file.csv':
          res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' });
          return void res.end('id,name\n1,alpha\n2,beta\n');
        case '/file.txt':
          res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="notes.txt"' });
          return void res.end('hello from the download\n');
        default:
          res.writeHead(404, { 'content-type': 'text/plain' });
          return void res.end('not found');
      }
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = (server.address() as AddressInfo).port;
  return {
    server,
    port: actual,
    url: (p = '/') => `http://127.0.0.1:${actual}${p}`,
    requests,
    close: () => new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections())),
  };
}
