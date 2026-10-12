import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BROWSER_POOL_DEFAULTS } from '@portal/contracts';
import Docker from 'dockerode';
import { build } from 'esbuild';
import { Reconciler } from '../delivery/reconciler.js';
import { WorkspaceSteps } from '../delivery/steps.js';
import { PoolService } from '../pools/service.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { DockerRuntime } from '../workspaces/docker.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Companions } from './companion.js';
import { compileBrowser } from './compile.js';
import { BrowserModule } from './index.js';
import { McpClient, type McpTransport } from './mcpclient.js';
import { companionName, workspaceContainer } from './spec.js';
import { config } from '../config.js';

/**
 * The browser pool end to end on the real Docker-in-Docker daemon (CLAUDEPILOT_DOCKER_TESTS=1): a workspace
 * container, the delivery engine writing the plugin, the gate and the installer, the browser container beside it,
 * and an MCP client driving every tool class through the gate against pages served inside the workspace. Then real
 * Claude Code 2.1.296 (`claude mcp list`, and a scripted stand-in for the Anthropic API calling a browser tool).
 *
 * Needs the browser image (PORTAL_BROWSER_IMAGE, default claudepilot-browser:br: build it with
 * `docker build -t claudepilot-browser:br images/browser`) and the workspace image. Everything it makes is named
 * `br-it-…` and removed at the end.
 */
const enabled = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const opts = { skip: enabled ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 to run against Docker' };
const socket = '/var/run/docker.sock';
const BROWSER_IMAGE = process.env.PORTAL_BROWSER_IMAGE ?? 'claudepilot-browser:br';
const docker = new Docker({ socketPath: socket });
const runtime = new DockerRuntime({ id: 'docker', label: 'Docker', socket }, config.workspaces.dockerImage, config.workspaces.imageContext);
const d = runtime.delivery;
const name = `br-it-${randomBytes(3).toString('hex')}`;
const WS = `docker/${name}`;
const PAGES = 8123;
const here = fileURLToPath(new URL('.', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dataDir: string;
let store: Store;
let pools: PoolService;
let reconciler: Reconciler;
let steps: WorkspaceSteps;
let mod: BrowserModule;

/**
 * Runs `command` in the workspace as `node` (what Claude Code does for a stdio server) and speaks MCP to it, with
 * stdout and stderr kept apart as they are for a real client.
 */
async function mcpIn(command: string): Promise<McpClient> {
  const exec = await docker.getContainer(workspaceContainer(name)).exec({
    Cmd: ['sh', '-c', `exec ${command}`],
    User: 'node',
    WorkingDir: '/home/node',
    Env: ['HOME=/home/node'],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  const out = new PassThrough();
  const err = new PassThrough();
  docker.modem.demuxStream(stream, out, err);
  const transport: McpTransport = {
    write: (line) => void stream.write(line),
    onData: (fn) => void out.on('data', (b: Buffer) => fn(b.toString('utf8'))),
    onStderr: (fn) => void err.on('data', (b: Buffer) => fn(b.toString('utf8'))),
    close: () => stream.destroy(),
  };
  return new McpClient(transport);
}

/**
 * TCP listeners that belong to the browser container's own processes (the network namespace is shared, so the
 * workspace's dev servers show in /proc/net/tcp too): matched by socket inode, as the PRD's exposed-listener check
 * does (§13). A user can read only its own processes' descriptors, so each of the container's users looks in turn.
 */
async function ownListeners(): Promise<string[]> {
  const inodes = new Set<string>();
  for (const user of ['1001', '1000']) {
    const r = await inBrowser(['sh', '-c', 'ls -l /proc/[0-9]*/fd/* 2>/dev/null | grep -o "socket:\\[[0-9]*\\]" | tr -d "socket:[]"'], user);
    for (const i of r.stdout.split('\n')) if (i) inodes.add(i);
  }
  const table = await inBrowser(['sh', '-c', 'cat /proc/net/tcp /proc/net/tcp6'], '0');
  return table.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f[3] === '0A' && inodes.has(f[9] ?? ''))
    .map((f) => f[1]!)
    .sort();
}

const sh = (script: string, user: 'root' | 'node' = 'node') => d.run(name, script, { user });
const inBrowser = (cmd: string[], user = '1001') => mod.companions.get('docker')!.exec(name, cmd, { user });

/** The command Claude Code runs for a plugin's stdio server: `.mcp.json`'s command and arguments, `${CLAUDE_PLUGIN_ROOT}` expanded. */
async function serverCommand(plugin: { dir: string }, server: string): Promise<string> {
  const json = JSON.parse((await d.read(name, `${plugin.dir}/.mcp.json`)) ?? '{}') as { mcpServers: Record<string, { command: string; args: string[] }> };
  const s = json.mcpServers[server]!;
  const quote = (a: string) => `'${a.replace('${CLAUDE_PLUGIN_ROOT}', plugin.dir).replace(/'/g, `'\\''`)}'`;
  return [s.command, ...s.args.map(quote)].join(' ');
}

let plugin: { dir: string; name: string };

before(async () => {
  if (!enabled) return;
  await runtime.create({ name, cpus: 2, memoryMb: 2048 }, () => undefined);
  dataDir = mkdtempSync(join(tmpdir(), 'cp-browser-it-'));
  store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: ConstructorParameters<typeof Reconciler>[3] = [];
  pools = new PoolService(store, { providers });
  steps = new WorkspaceSteps(store, () => runtime.delivery);
  mod = new BrowserModule({ store, pools, steps, runtimes: [runtime], notify: () => undefined });
  mod.companions.set('docker', new Companions('docker', socket, BROWSER_IMAGE, config.browser.imageContext, () => store.portalId));
  // The module registered its kind on this pool service; its fragment provider is the reconciler's.
  reconciler = new Reconciler(store, () => runtime, () => [runtime], providers);
  pools.reconciler = reconciler;
  mod.guard(runtime);

  const pool = pools.create('browser', { name: 'it', content: { ...BROWSER_POOL_DEFAULTS, idleMinutes: 1, devtools: true, toolRules: { browser_run_code_unsafe: 'default' } } });
  pools.setAssignments(WS, 'browser', [{ poolId: pool.id }]);
  const assigned = pools.assignedPools(WS, 'browser')[0]!;
  plugin = compileBrowser({ pool: assigned.pool, content: assigned.content as typeof BROWSER_POOL_DEFAULTS }).plugin;
  await reconciler.request(WS, 'test');
  assert.equal(reconciler.row(WS)?.status, 'synced', reconciler.row(WS)?.reason ?? '');
  await mod.service.converge(WS, 'test');
  await steps.idle(WS);
  assert.equal(mod.service.configuration(WS).container, 'running', mod.service.configuration(WS).error ?? '');

  // The test pages, served from the workspace's own loopback.
  const bundled = await build({
    stdin: { contents: `import { serveTestPages } from './testpages.ts'; serveTestPages(${PAGES}).then(() => console.log('up'));`, resolveDir: here, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  await d.put(name, [{ path: '/tmp/pages.mjs', type: 'file', content: bundled.outputFiles[0]!.text, mode: 0o644, uid: 1000, gid: 1000 }]);
  await sh('(nohup node /tmp/pages.mjs >/tmp/pages.log 2>&1 &); sleep 1');
});

after(async () => {
  if (!enabled) return;
  if (process.env.BR_KEEP === '1') return void console.log(`kept: ${name}`);
  try {
    await runtime.remove(name); // through the guard: the browser container goes first, or the volume would be in use
  } catch (e) {
    console.error('cleanup:', (e as Error).message);
  }
  await docker.getContainer(companionName(name)).remove({ force: true }).catch(() => undefined);
  store?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const page = (path = '/') => `http://127.0.0.1:${PAGES}${path}`;

describe('the browser container, on real Docker', opts, () => {
  test('it joins the workspace’s network namespace and is built as the PRD says: no published ports, dropped capabilities, no new privileges', async () => {
    const ws = await docker.getContainer(workspaceContainer(name)).inspect();
    const c = await docker.getContainer(companionName(name)).inspect();
    assert.equal(c.HostConfig.NetworkMode, `container:${ws.Id}`);
    assert.deepEqual(c.HostConfig.CapDrop, ['ALL']);
    assert.deepEqual([...(c.HostConfig.CapAdd ?? [])].sort(), ['SETGID', 'SETUID']);
    assert.ok((c.HostConfig.SecurityOpt ?? []).some((o: string) => o === 'no-new-privileges' || o === 'no-new-privileges:true'));
    assert.ok((c.HostConfig.SecurityOpt ?? []).some((o: string) => o.startsWith('seccomp=')), 'a seccomp profile, not unconfined');
    assert.ok(!(c.HostConfig.SecurityOpt ?? []).some((o: string) => /unconfined/.test(o)));
    assert.equal(c.HostConfig.Privileged, false);
    assert.deepEqual(c.HostConfig.PortBindings ?? {}, {}, 'nothing published on a host port');
    assert.equal(c.HostConfig.Memory, 3072 * 1024 * 1024);
    assert.equal(c.HostConfig.PidsLimit, 1024);
    assert.equal(c.HostConfig.ShmSize, 1024 * 1024 * 1024);
    assert.equal(c.HostConfig.RestartPolicy?.Name, 'no');
    assert.deepEqual(
      (c.Mounts ?? []).map((m) => m.Destination).sort(),
      ['/data/profile', '/home/node/Downloads'],
      'only the profile and ~/Downloads of the home volume (PRD §13 Mounts)',
    );
    assert.equal(c.Config.Labels['claudepilot.browser.portal'], store.portalId);
    assert.equal(c.Config.Labels['claudepilot.managed'], undefined, 'never shown as a workspace');
  });

  test('users: init holds only SETUID and SETGID, the supervisor and display are uid 1001, Chrome (once awake) is uid 1000', async () => {
    const ps = await inBrowser(['ps', '-eo', 'user:12,uid,args'], '0');
    const line = (re: RegExp) => ps.stdout.split('\n').find((l) => re.test(l)) ?? '';
    assert.match(line(/cpb\/init\.mjs/), /^root\s+0\s/);
    assert.match(line(/cpb\/supervisor\.mjs/), /^cpb\s+1001\s/);
    assert.match(line(/Xtigervnc/), /^cpb\s+1001\s/);
    assert.match(line(/openbox/), /^cpb\s+1001\s/);
    const caps = await inBrowser(['sh', '-c', 'grep -E "^Cap(Eff|Bnd)" /proc/$(pgrep -f cpb/init.mjs | head -1)/status'], '0');
    // SETGID is bit 6 and SETUID bit 7: 0x00c0.
    assert.match(caps.stdout, /CapEff:\s+00000000000000c0/);
    assert.match(caps.stdout, /CapBnd:\s+00000000000000c0/);
  });

  test('CDP, the supervisor and nothing else listen, all on loopback; VNC and X are on unix sockets only', async () => {
    // Before Chrome wakes: only the supervisor, 127.0.0.1:9220.
    assert.deepEqual(await ownListeners(), ['0100007F:2404']);
    const unix = await inBrowser(['cat', '/proc/net/unix'], '0');
    assert.ok(!/@\/tmp\/\.X11-unix/.test(unix.stdout), 'no abstract X socket: a second container in the namespace can’t drive the display (Q9)');
    assert.match(unix.stdout, /\/run\/cpb\/vnc\.sock/);
    const modes = await inBrowser(['stat', '-c', '%a %U %n', '/run/cpb/vnc.sock', '/run/cpb/ctl.sock', '/run/cpb/vnc-full.pw', '/run/cpb/vnc-view.pw'], '0');
    assert.match(modes.stdout, /^600 cpb \/run\/cpb\/vnc\.sock$/m);
    assert.match(modes.stdout, /^600 cpb \/run\/cpb\/ctl\.sock$/m);
    assert.match(modes.stdout, /^600 cpb \/run\/cpb\/vnc-full\.pw$/m);
  });

  test('Chrome’s uid can’t open the control socket, the VNC socket or the VNC passwords; the workspace can’t see them at all', async () => {
    for (const path of ['/run/cpb/ctl.sock', '/run/cpb/vnc.sock']) {
      const r = await inBrowser(['sh', '-c', `socat -t 1 - UNIX-CONNECT:${path} </dev/null 2>&1; echo "exit $?"`], '1000');
      assert.match(r.stdout, /Permission denied|exit [1-9]/, path);
    }
    const pw = await inBrowser(['sh', '-c', 'cat /run/cpb/vnc-full.pw 2>&1; echo "exit $?"'], '1000');
    assert.match(pw.stdout, /Permission denied/);
    const fromWorkspace = await sh('ls /run/cpb 2>&1; echo "exit $?"');
    assert.match(fromWorkspace.stdout, /No such file/);
  });

  test('from the workspace: the supervisor needs its header, refuses an Origin, and CDP answers on loopback', async () => {
    const get = (extra: string) => sh(`curl -s -o /dev/null -w '%{http_code}' ${extra} http://127.0.0.1:9220/status`);
    assert.equal((await get('')).stdout, '403', 'no X-CPB');
    assert.equal((await get("-H 'X-CPB: 1' -H 'Origin: https://evil.example'")).stdout, '403');
    assert.equal((await get("-H 'X-CPB: 1'")).stdout, '200');
    await mod.service.ctl(WS, 'wake');
    const cdp = await sh('curl -s http://127.0.0.1:9222/json/version');
    assert.match(cdp.stdout, /"Browser": "Chrome\/\d+/);
    const hostHeader = await sh("curl -s -o /dev/null -w '%{http_code}' -H 'Host: attacker.example' http://127.0.0.1:9222/json/version");
    assert.notEqual(hostHeader.stdout, '200', 'Chrome refuses a name in Host (DNS rebinding)');
  });

  test('Chrome runs as uid 1000 with its sandbox, and CDP and the supervisor are the only listeners', async () => {
    const ps = await inBrowser(['ps', '-eo', 'uid,args'], '0');
    const main = ps.stdout.split('\n').find((l) => /chromium --user-data-dir|chromium .*--remote-debugging-port=9222/.test(l) && !/--type=/.test(l)) ?? '';
    assert.match(main, /^\s*1000\s/);
    assert.ok(!/--no-sandbox/.test(main), 'sandbox on');
    assert.ok(ps.stdout.split('\n').some((l) => /^\s*1000\s.*--type=zygote/.test(l)), 'a sandboxed zygote');
    assert.deepEqual(await ownListeners(), ['0100007F:2404', '0100007F:2406']);
  });

  test('another container on the Docker network cannot reach CDP or the supervisor of the workspace', async () => {
    const ws = await docker.getContainer(workspaceContainer(name)).inspect();
    const ip = Object.values(ws.NetworkSettings.Networks)[0]?.IPAddress;
    assert.ok(ip, 'the workspace has an address');
    const probe = await docker.createContainer({
      name: `${name}-probe`,
      Image: config.workspaces.dockerImage,
      User: 'node',
      Entrypoint: ['node', '-e'],
      Cmd: [
        `const net=require('net');const r=[];let n=0;for(const p of [9222,9220,5900,6099]){const s=net.connect({host:'${ip}',port:p,timeout:2000});s.on('connect',()=>{r.push(p+':open');s.destroy()});s.on('timeout',()=>{r.push(p+':timeout');s.destroy()});s.on('error',(e)=>{r.push(p+':'+e.code)});s.on('close',()=>{if(++n===4){console.log(r.sort().join(' '));process.exit(0)}})}`,
      ],
    });
    try {
      await probe.start();
      await probe.wait();
      const out = (await probe.logs({ stdout: true, stderr: true })).toString('utf8');
      assert.ok(!/:open/.test(out), `reachable from outside the namespace: ${out}`);
      assert.match(out, /9222:/);
    } finally {
      await probe.remove({ force: true }).catch(() => undefined);
    }
  });
});

describe('MCP through the gate, against a real Chrome', opts, () => {
  let g: McpClient;
  let text: (r: { text: string }) => string;
  before(async () => {
    if (!enabled) return;
    g = await mcpIn(await serverCommand(plugin, 'browser'));
    await g.init(true);
    text = (r) => r.text;
  });
  after(() => g?.close());

  /** A call that must succeed: the error text says what went wrong. */
  const must = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await g.call(tool, args);
    assert.equal(r.isError, false, `${tool} ${JSON.stringify(args)}: ${r.text.slice(0, 600)}`);
    return r;
  };
  const ref = (snapshot: string, re: string) => new RegExp(`${re}[^\\n]*\\[ref=(\\w+)\\]`).exec(snapshot)?.[1] ?? assert.fail(`no ${re} in the snapshot`);
  const evalIn = async (fn: string) => text(await g.call('browser_evaluate', { function: fn }));

  test('a session start lists the tools and does not wake Chrome', async () => {
    await mod.service.ctl(WS, 'chrome', { action: 'stop' });
    const tools = await g.tools();
    for (const t of ['browser_navigate', 'browser_click', 'browser_snapshot', 'browser_tabs', 'browser_take_screenshot', 'browser_handoff', 'browser_status', 'browser_navigate_forward', 'browser_reload', 'browser_mouse_wheel']) assert.ok(tools.includes(t), t);
    const status = await mod.service.supervisor(WS, { fresh: true });
    assert.equal(status?.chrome.state, 'asleep');
    assert.match(text(await g.call('browser_status')), /Browser: asleep/);
  });

  test('navigate: the first call wakes Chrome; snapshot, tabs, back, forward and reload work', async () => {
    const nav = await g.call('browser_navigate', { url: page('/') });
    assert.equal(nav.isError, false, nav.text);
    assert.equal((await mod.service.supervisor(WS, { fresh: true }))?.chrome.state, 'up');
    const snap = text(await g.call('browser_snapshot'));
    assert.match(snap, /heading "CP Test Home"/);
    await g.call('browser_navigate', { url: page('/second') });
    assert.match(await evalIn('() => document.title'), /CP Second/);
    await g.call('browser_navigate_back');
    assert.match(await evalIn('() => document.title'), /CP Test Home/);
    const fwd = await g.call('browser_navigate_forward');
    assert.equal(fwd.isError, false, fwd.text);
    assert.match(await evalIn('() => document.title'), /CP Second/);
    await g.call('browser_navigate', { url: page('/') });
    await evalIn('() => { window.__marker = 1; return 1 }');
    const reload = await g.call('browser_reload');
    assert.equal(reload.isError, false, reload.text);
    assert.match(await evalIn('() => String(window.__marker)'), /undefined/, 'a real reload clears page state');
  });

  test('clicks, hover, typing, select, check boxes, forms and key presses change the page', async () => {
    await must('browser_navigate', { url: page('/') });
    const snap = text(await must('browser_snapshot'));
    await must('browser_click', { element: 'Count up', target: ref(snap, 'button "Count up"') });
    await must('browser_click', { element: 'Count up', target: ref(snap, 'button "Count up"') });
    await must('browser_hover', { element: 'Hover me', target: ref(snap, 'button "Hover me"') });
    await must('browser_type', { element: 'Name', target: ref(snap, 'textbox "Name"'), text: 'Ada Lovelace' });
    await must('browser_select_option', { element: 'Colour', target: ref(snap, 'combobox "Colour"'), values: ['blue'] });
    await must('browser_fill_form', {
      fields: [
        { name: 'Email', type: 'textbox', target: ref(snap, 'textbox "Email"'), value: 'ada@example.test' },
        { name: 'I agree', type: 'checkbox', target: ref(snap, 'checkbox "I agree"'), value: 'true' },
      ],
    });
    await must('browser_press_key', { key: 'x' });
    const state = await evalIn('() => [document.getElementById("counter").textContent, document.getElementById("hovered").textContent, document.getElementById("name").value, document.getElementById("colour").value, document.getElementById("email").value, document.getElementById("agree").checked, document.getElementById("keys").textContent.trim()].join(" | ")');
    assert.match(state, /Count: 2 \| Hovered: yes \| Ada Lovelace \| blue \| ada@example\.test \| true \| Keys: x/);
    await must('browser_click', { element: 'Send form', target: ref(snap, 'button "Send form"') });
    assert.match(await evalIn('() => document.title'), /CP Submitted/);
    assert.match(await evalIn('() => document.getElementById("posted").textContent'), /name=Ada\+Lovelace&email=ada%40example\.test&colour=blue&agree=yes/);
  });

  test('scrolling by wheel and by coordinates, drag, iframes and viewport resize', async () => {
    await must('browser_navigate', { url: page('/scroll') });
    await must('browser_mouse_move_xy', { x: 300, y: 300 });
    await must('browser_mouse_wheel', { deltaX: 0, deltaY: 700 });
    await sleep(600);
    assert.ok(Number(/\d+/.exec(await evalIn('() => String(Math.round(scrollY))'))?.[0]) > 300, 'the wheel scrolled the page');
    await must('browser_navigate', { url: page('/frames') });
    const frames = text(await must('browser_snapshot'));
    await must('browser_click', { element: 'button inside the frame', target: ref(frames, 'button "Click inside frame"') });
    assert.match(text(await must('browser_snapshot')), /Frame clicked/);
    await must('browser_navigate', { url: page('/drag') });
    const drag = text(await must('browser_snapshot'));
    const byText = (t: string) => new RegExp(`\\[ref=(\\w+)\\]: ${t}`).exec(drag)?.[1] ?? assert.fail(`no "${t}" in ${drag}`);
    const dragged = await g.call('browser_drag', { startElement: 'Drag me', startTarget: byText('Drag me'), endElement: 'Drop here', endTarget: byText('Drop here') });
    assert.equal(dragged.isError, false, dragged.text);
    assert.match(await evalIn('() => document.getElementById("state").textContent'), /dropped/);
    await must('browser_resize', { width: 700, height: 500 });
    assert.match(await evalIn('() => innerWidth + "x" + innerHeight'), /700x\d+/);
  });

  test('dialogs, console and network inspection, waits', async () => {
    await must('browser_navigate', { url: page('/dialogs') });
    const snap = text(await must('browser_snapshot'));
    const opened = await g.call('browser_click', { element: 'Confirm', target: ref(snap, 'button "Confirm"') });
    assert.match(opened.text, /confirm.*dialog.*Proceed\?/i);
    await must('browser_handle_dialog', { accept: true });
    assert.match(await evalIn('() => document.getElementById("result").textContent'), /confirm: true/);
    await must('browser_navigate', { url: page('/console') });
    const waited = await must('browser_wait_for', { text: 'ping ok' });
    assert.equal(waited.isError, false, waited.text);
    const consoleMessages = text(await must('browser_console_messages', { level: 'info' }));
    assert.match(consoleMessages, /cp-log hello/);
    assert.match(consoleMessages, /cp-warn careful/);
    assert.match(consoleMessages, /cp-error broken/);
    const network = text(await must('browser_network_requests', { static: true }));
    assert.match(network, /\/api\/ping\?x=1 => \[200\]/);
    assert.match(network, /\/api\/missing => \[404\]/);
  });

  test('file upload, downloads, screenshots as images, and a second tab', async () => {
    await sh('printf "upload me\\n" > /home/node/Downloads/upload-me.txt');
    await must('browser_navigate', { url: page('/upload') });
    const snap = text(await must('browser_snapshot'));
    const chooser = await g.call('browser_click', { element: 'Choose File', target: ref(snap, 'button "Choose File"') });
    assert.match(chooser.text, /File chooser|file chooser|modal/i);
    const upload = await must('browser_file_upload', { paths: ['/home/node/Downloads/upload-me.txt'] });
    assert.equal(upload.isError, false, upload.text);
    assert.match(await evalIn('() => document.getElementById("info").textContent'), /file: upload-me\.txt \(10 bytes\)/);

    const shot = await must('browser_take_screenshot', { type: 'png' });
    assert.ok(shot.raw.result?.content?.some((c) => c.type === 'image'), 'an image comes back');

    await must('browser_navigate', { url: page('/downloads') });
    const downloads = text(await must('browser_snapshot'));
    await must('browser_click', { element: 'report.csv', target: ref(downloads, 'link "report.csv"') });
    await sleep(1500);
    const saved = await sh('ls /home/node/Downloads');
    // PRD Q3: where a download lands depends on how Playwright over CDP and the policy interact; record what happens.
    assert.match(saved.stdout, /report\.csv/, `downloads folder: ${saved.stdout}`);

    const tab = await must('browser_tabs', { action: 'new', url: page('/second') });
    assert.match(tab.text, /CP Second/);
    assert.match(text(await must('browser_tabs', { action: 'list' })), /CP Downloads[\s\S]*CP Second/);
    await must('browser_tabs', { action: 'close' });
  });

  test('credential headers never reach the transcript', async () => {
    await g.call('browser_navigate', { url: page('/cookies') });
    const snap = text(await g.call('browser_snapshot'));
    await g.call('browser_type', { element: 'User', target: ref(snap, 'textbox "User"'), text: 'ada' });
    await g.call('browser_click', { element: 'Sign in', target: ref(snap, 'button "Sign in"') });
    await g.call('browser_navigate', { url: page('/second') });
    const list = text(await g.call('browser_network_requests', { static: true }));
    const detail = await g.call('browser_network_request', { index: 1, part: 'request-headers' }).catch(() => ({ text: '' }));
    assert.ok(!/cp_session=abc123/.test(list + detail.text), 'the session cookie value stays out of what the agent reads');
  });

  test('while a person has control the tools wait, with a message; when they hand back the next call works', async () => {
    await mod.service.ctl(WS, 'control', { on: true, holder: 'device-1', label: 'Alfian’s iPhone', ttl: 60 });
    await sleep(1100); // the gate caches the supervisor's answer for a second
    const refused = await g.call('browser_click', { element: 'x', target: 'e1' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /A person has control of the browser since \d\d:\d\d UTC \(Alfian’s iPhone\)/);
    const s = text(await g.call('browser_status'));
    assert.match(s, /A person has control/);
    await mod.service.ctl(WS, 'control', { off: true });
    await sleep(1100);
    assert.equal((await g.call('browser_navigate', { url: page('/') })).isError, false);
  });

  test('a handoff reaches the portal, and the person’s answer returns to the agent', async () => {
    const asked = g.call('browser_handoff', { reason: 'Sign in to the test site' }, 30_000);
    let waiting;
    for (let i = 0; i < 40 && !waiting; i++) {
      await sleep(250);
      waiting = (await mod.service.supervisor(WS, { fresh: true }))?.handoffs.find((h) => h.state === 'waiting');
    }
    assert.ok(waiting, 'the handoff is visible in the portal');
    assert.equal(waiting.reason, 'Sign in to the test site');
    assert.equal(waiting.origin, `http://127.0.0.1:${PAGES}`, 'the origin comes from the tab, not from the agent');
    assert.equal((await mod.service.status(WS, { secure: true })).state, 'needs_input');
    await mod.service.ctl(WS, 'handoff-answer', { id: waiting.id, state: 'handed_back', note: 'signed in' });
    const result = await asked;
    assert.equal(result.text, 'Handed back: signed in. Check with browser_snapshot, not a screenshot.');
  });

  test('chrome-devtools-mcp: console, network, pages and a Lighthouse-free evaluate through its own gate', async () => {
    const dt = await mcpIn(await serverCommand(plugin, 'devtools'));
    try {
      await dt.init(true);
      assert.ok((await dt.tools()).includes('list_console_messages'));
      const pagesList = await dt.call('list_pages');
      assert.equal(pagesList.isError, false, pagesList.text);
      const id = /^(\d+): .*127\.0\.0\.1:8123/m.exec(pagesList.text)?.[1] ?? assert.fail(`no test page in ${pagesList.text}`);
      const network = await dt.call('list_network_requests', { pageId: Number(id) });
      assert.equal(network.isError, false, network.text);
      const consoleList = await dt.call('list_console_messages', { pageId: Number(id) });
      assert.equal(consoleList.isError, false, consoleList.text);
      const shot = await dt.call('evaluate_script', { pageId: Number(id), function: '() => document.title' });
      assert.equal(shot.isError, false, shot.text);
      assert.match(shot.text, /CP /);
    } finally {
      dt.close();
    }
  });

  test('Chrome closes after the idle time and the next call wakes it again', async () => {
    // The pool says 1 minute; the supervisor was told so at creation.
    const before = await mod.service.supervisor(WS, { fresh: true });
    assert.ok(before?.idle.stopAt, 'an idle stop is scheduled');
    assert.ok(before!.idle.stopAt! - Date.now() <= 60_000 + 1000);
    await mod.service.ctl(WS, 'chrome', { action: 'stop' });
    assert.equal((await mod.service.supervisor(WS, { fresh: true }))?.chrome.state, 'asleep');
    await sleep(1100);
    const again = await g.call('browser_navigate', { url: page('/second') });
    assert.equal(again.isError, false, again.text);
    const after = await mod.service.supervisor(WS, { fresh: true });
    assert.equal(after?.chrome.state, 'up');
    assert.ok(after!.chrome.starts >= 2);
  });
});

describe('real Claude Code 2.1.296', opts, () => {
  test('`claude mcp list` shows the browser server connected, and listing it does not wake Chrome', async () => {
    await mod.service.ctl(WS, 'chrome', { action: 'stop' });
    // Claude Code only knows the marketplace after a session has registered it: a first call settles that.
    const r = await sh('cd /home/node && timeout 90 claude mcp list 2>&1', 'node');
    assert.match(r.stdout, /cpb-browser/, r.stdout);
    assert.match(r.stdout, /cpb-browser[^\n]*(✓|Connected)/i, r.stdout);
    assert.equal((await mod.service.supervisor(WS, { fresh: true }))?.chrome.state, 'asleep', 'a session start never wakes Chrome');
  });

  test('a scripted stand-in Anthropic API has Claude call a browser tool and read the page', async () => {
    const tool = (n: string) => `mcp__plugin_cpb-browser_browser__${n}`;
    const steps = [
      { tool: tool('browser_navigate'), input: { url: page('/') } },
      { tool: tool('browser_evaluate'), input: { function: '() => document.title' } },
      { text: 'done' },
    ];
    await d.put(name, [
      { path: '/tmp/mock', type: 'directory', mode: 0o755, uid: 1000, gid: 1000 },
      { path: '/tmp/mock/api.js', type: 'file', content: MOCK_API, mode: 0o644, uid: 1000, gid: 1000 },
      { path: '/tmp/mock/steps.json', type: 'file', content: JSON.stringify(steps), mode: 0o644, uid: 1000, gid: 1000 },
    ]);
    const env = 'ANTHROPIC_BASE_URL=http://127.0.0.1:4599 ANTHROPIC_API_KEY=fake-mock-key CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1';
    await sh(
      `cd /tmp/mock && rm -f log.jsonl && (nohup node api.js /tmp/mock >api.out 2>&1 &) && sleep 1 && (cd /home/node && nohup env ${env} timeout 150 claude -p go --allowedTools '${tool('browser_navigate')}' '${tool('browser_evaluate')}' --model claude-sonnet-4-5 >/tmp/mock/claude.out 2>&1; echo "exit $?" >>/tmp/mock/claude.out) >/dev/null 2>&1 &`,
    );
    const log = async () =>
      ((await d.read(name, '/tmp/mock/log.jsonl')) ?? '')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { error: boolean; content: string });
    for (let i = 0; i < 400 && (await log()).length < 2; i++) await sleep(300);
    const results = await log();
    assert.equal(results.length >= 2, true, `Claude Code output: ${await d.read(name, '/tmp/mock/claude.out')}`);
    assert.equal(results[0]!.error, false, results[0]!.content);
    assert.match(results[0]!.content, /Page Title: CP Test Home/);
    assert.match(results[1]!.content, /CP Test Home/);
    assert.equal(results[1]!.error, false);
    for (let i = 0; i < 100 && !/exit 0/.test((await d.read(name, '/tmp/mock/claude.out')) ?? ''); i++) await sleep(300);
    await sh('pkill -f "node api.js" || true');
  });
});

describe('removal', opts, () => {
  test('removing the workspace takes the browser container away first (the volume is otherwise in use)', async () => {
    assert.ok(await docker.getContainer(companionName(name)).inspect().then(() => true, () => false));
    await runtime.remove(name);
    assert.equal(await docker.getContainer(companionName(name)).inspect().then(() => true, () => false), false, 'the browser container is gone');
    assert.equal(await docker.getContainer(workspaceContainer(name)).inspect().then(() => true, () => false), false);
    assert.equal(await docker.getVolume(`claudepilot-${name}-home`).inspect().then(() => true, () => false), false, 'and so is the volume');
  });
});

/**
 * The Messages API as Claude Code streams it: a request that offers tools gets the next scripted step (a tool call
 * or text), and every tool result it sends back is appended to log.jsonl (the pattern of secrets/claude.integration.test.ts).
 */
const MOCK_API = String.raw`
const http=require('http'),fs=require('fs'),dir=process.argv[2],steps=JSON.parse(fs.readFileSync(dir+'/steps.json','utf8'));let next=0;
function sse(res,block,stop){res.writeHead(200,{'content-type':'text/event-stream'});const s=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
s('message_start',{message:{id:'msg_'+Date.now(),type:'message',role:'assistant',model:'mock',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}});
if(block.text!==undefined){s('content_block_start',{index:0,content_block:{type:'text',text:''}});s('content_block_delta',{index:0,delta:{type:'text_delta',text:block.text}})}
else{s('content_block_start',{index:0,content_block:{type:'tool_use',id:'toolu_'+next,name:block.tool,input:{}}});s('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}})}
s('content_block_stop',{index:0});s('message_delta',{delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:1}});s('message_stop',{});res.end()}
http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',async()=>{let j={};try{j=JSON.parse(b||'{}')}catch{}
if(req.url.includes('count_tokens'))return res.end('{"input_tokens":1}');
for(const c of [].concat((j.messages||[]).at(-1)?.content||[]))if(c&&c.type==='tool_result')fs.appendFileSync(dir+'/log.jsonl',JSON.stringify({error:!!c.is_error,content:JSON.stringify(c.content)})+'\n');
if(!(j.tools||[]).some(t=>t.name==='Bash')){if(!j.stream)return res.end(JSON.stringify({id:'m',type:'message',role:'assistant',model:'mock',content:[{type:'text',text:'ok'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}));return sse(res,{text:'ok'},'end_turn')}
const step=steps[next++]||{text:'done'};
sse(res,step,step.text!==undefined?'end_turn':'tool_use')})}).listen(4599,'127.0.0.1');`;
