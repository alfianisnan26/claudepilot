import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { BROWSER_POOL_DEFAULTS, type BrowserHeaderRule, type BrowserPoolContent } from '@portal/contracts';
import { extract } from 'tar-stream';
import { secretsHarness } from '../secrets/testkit.js';
import { tarOf } from './companion.js';
import { compileBrowser, mcpServers } from './compile.js';
import { coveredBy, envFileValue, extensionId, headersFile, headersSpec, headersSummary, resolveHeaders, type ResolvedHeader, type SecretLookup } from './headers.js';
import { browserHarness, supervisorStatus } from './testkit.js';
import { browserContainer, browserVolumes, configMapData, specOf, withBrowser, type KubePlan } from './kube.js';
import { chromePolicy } from './policy.js';

// Request headers from named secrets (browser PRD §24). Values are built at run time: nothing here is a real credential.

// The container's own code (dependency-free Node), imported the way kube.test.ts imports lib.mjs.
const ext = (await import(new URL('../../../../images/browser/cpb/headers-ext.mjs', import.meta.url).href)) as {
  buildExtension: (e: unknown) => { manifest: Record<string, unknown>; rules: { condition: { regexFilter: string }; action: { requestHeaders: { header: string; value: string }[] } }[]; dropped: string[]; count: number };
  extensionId: (dir?: string) => string;
  writeExtension: (e: unknown, dir: string) => { count: number };
  EXT_DIR: string;
};
const lib = (await import(new URL('../../../../images/browser/cpb/lib.mjs', import.meta.url).href)) as {
  chromeArgs: (cfg: unknown, o: { headless: boolean; profileDir: string; extensionDir?: string | null }) => string[];
  loadConfig: (p: string) => unknown;
};

const fresh = () => `v${randomBytes(14).toString('hex')}`;
const RULE: BrowserHeaderRule = { hosts: ['app.example.com', '*.stg.example.com'], name: 'CF-Access-Client-Secret', secret: 'CF_ACCESS_SECRET' };
const content = (over: Partial<BrowserPoolContent> = {}): BrowserPoolContent => ({ ...BROWSER_POOL_DEFAULTS, allowedSites: ['app.example.com', '*.example.com'], headers: [RULE], ...over });
const pool = { id: 'p1', name: 'Dev browser', revision: 3 };

/** Whether a URL is one the rule's regular expression would add the header to. */
const matches = (e: ReturnType<typeof ext.buildExtension>, url: string) => e.rules.some((r) => new RegExp(r.condition.regexFilter, 'i').test(url));

test('save: a header names a secret, goes only to allowed hosts, and a value is never accepted', async () => {
  const h = await browserHarness();
  try {
    const parsed = h.kind.parse({ allowedSites: ['*.example.com'], headers: [{ hosts: [' App.Example.com '], name: 'CF-Access-Client-Id', secret: 'CF_ID', value: 'ignored' }] }, null);
    assert.deepEqual(parsed.headers, [{ hosts: ['app.example.com'], name: 'CF-Access-Client-Id', secret: 'CF_ID' }]);
    assert.ok(!JSON.stringify(parsed).includes('ignored'), 'a `value` field is dropped, not stored');
    assert.deepEqual(h.kind.parse({}, null).headers, [], 'pools saved before this have none');
    assert.deepEqual(h.kind.parse({ display: '1024x768' }, parsed).headers, parsed.headers, 'an edit keeps them');

    const bad: [string, unknown][] = [
      ['a host the pool does not allow', { allowedSites: ['a.example.com'], headers: [{ hosts: ['b.example.com'], name: 'X-Edge', secret: 'S' }] }],
      ['no allowed sites at all', { headers: [{ hosts: ['a.example.com'], name: 'X-Edge', secret: 'S' }] }],
      ['a header the browser owns', { allowedSites: ['a.example.com'], headers: [{ hosts: ['a.example.com'], name: 'Cookie', secret: 'S' }] }],
      ['a name with a line break', { allowedSites: ['a.example.com'], headers: [{ hosts: ['a.example.com'], name: 'X-A\r\nX-B', secret: 'S' }] }],
      ['a secret that is not a name', { allowedSites: ['a.example.com'], headers: [{ hosts: ['a.example.com'], name: 'X-A', secret: 'not a name!' }] }],
      ['no hosts', { allowedSites: ['a.example.com'], headers: [{ hosts: [], name: 'X-A', secret: 'S' }] }],
      ['a wildcard that allowed sites do not cover', { allowedSites: ['a.example.com'], headers: [{ hosts: ['*.example.com'], name: 'X-A', secret: 'S' }] }],
      ['too many', { allowedSites: ['a.example.com'], headers: Array.from({ length: 11 }, (_, i) => ({ hosts: ['a.example.com'], name: `X-${i}`, secret: 'S' })) }],
    ];
    for (const [why, input] of bad) assert.throws(() => h.kind.parse(input, null), (e) => isAppError(e) && e.code === 'VALIDATION_FAILED', why);
    // Removing a site a header needs is refused, so a header can't outlive its allowance.
    assert.throws(() => h.kind.parse({ allowedSites: ['other.example.com'] }, parsed), /allowed sites/);
  } finally {
    h.done();
  }
});

test('coveredBy: the same host, any port of a bare entry, and *.domain for what is under it', () => {
  assert.ok(coveredBy('a.example.com', ['a.example.com']));
  assert.ok(coveredBy('a.example.com:8443', ['a.example.com']));
  assert.ok(!coveredBy('a.example.com', ['a.example.com:8443']));
  assert.ok(coveredBy('a.example.com', ['*.example.com']));
  assert.ok(coveredBy('*.stg.example.com', ['*.example.com']));
  assert.ok(coveredBy('*.example.com', ['*.example.com']));
  assert.ok(!coveredBy('example.com', ['*.example.com']));
  assert.ok(!coveredBy('evilexample.com', ['*.example.com']));
  assert.ok(!coveredBy('a.example.com.evil.net', ['*.example.com']));
  assert.ok(coveredBy('a.example.com', ['https://a.example.com/path']));
});

test('a matching host gets the header and a non-matching host does not', () => {
  const value = fresh();
  const built = ext.buildExtension([{ hosts: ['app.example.com', '*.stg.example.com', 'dev.example.com:8443'], name: 'CF-Access-Client-Secret', value }]);
  assert.equal(built.dropped.length, 0);
  for (const yes of ['https://app.example.com/', 'https://app.example.com/a/b?c=d', 'https://app.example.com:444/x', 'https://x.stg.example.com/', 'https://a.b.stg.example.com/z', 'https://dev.example.com:8443/']) assert.ok(matches(built, yes), yes);
  for (const no of [
    'http://app.example.com/', // not https
    'https://example.com/',
    'https://other.example.com/',
    'https://app.example.com.evil.net/',
    'https://evil.net/https://app.example.com/',
    'https://evil.net/?u=https://app.example.com/',
    'https://app.example.com@evil.net/',
    'https://xapp.example.com/',
    'https://stg.example.com/', // *.stg.example.com is the subdomains only
    'https://dev.example.com/',
    'https://dev.example.com:9000/',
    'https://evil.net/.app.example.com/',
  ])
    assert.ok(!matches(built, no), no);
  const rule = built.rules.find((r) => new RegExp(r.condition.regexFilter, 'i').test('https://app.example.com/'))!;
  assert.deepEqual(rule.action.requestHeaders.map((x) => [x.header, x.value]), [['CF-Access-Client-Secret', value]]);
});

test('the builder drops what could inject or override: bad names, owned headers, line breaks in values, bad hosts; it reports names only', () => {
  const value = fresh();
  const built = ext.buildExtension([
    { hosts: ['a.example.com'], name: 'Cookie', value },
    { hosts: ['a.example.com'], name: 'X-Ok', value: `${value}\r\nX-Evil: 1` },
    { hosts: ['a.example.com'], name: 'X Bad', value },
    { hosts: ['*'], name: 'X-Wide', value },
    { hosts: ['https://a.example.com/'], name: 'X-Url', value },
    { hosts: ['a.example.com'], name: 'X-Empty', value: '' },
    { hosts: ['a.example.com'], name: 'X-Fine', value },
  ]);
  assert.equal(built.count, 1);
  assert.deepEqual(built.dropped, ['Cookie', 'X-Ok', 'X Bad', 'X-Wide', 'X-Url', 'X-Empty']);
  assert.ok(!JSON.stringify(built.dropped).includes(value));
  assert.equal(ext.buildExtension('nonsense').count, 0);
});

test('the extension is written to a private folder, and a start without headers removes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'cpb-ext-'));
  const dir = join(root, 'cpb-ext');
  try {
    const value = fresh();
    assert.equal(ext.writeExtension([{ hosts: ['a.example.com'], name: 'X-Edge', value }], dir).count, 1);
    assert.deepEqual(readdirSync(dir).sort(), ['manifest.json', 'rules.json']);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o400, f);
    assert.ok(!readFileSync(join(dir, 'manifest.json'), 'utf8').includes(value), 'the value is only in the ruleset');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { manifest_version: number; permissions: string[] };
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ['declarativeNetRequest']);
    // The next start has no headers: the old extension, with its value, is gone.
    assert.equal(ext.writeExtension([], dir).count, 0);
    assert.ok(!existsSync(dir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Chromium loads the extension only when there is one, and the id the policy allows is the one the path gives', () => {
  const cfg = lib.loadConfig('/nonexistent/config.json');
  const none = lib.chromeArgs(cfg, { headless: true, profileDir: '/data/profile' });
  assert.ok(!none.some((a) => a.includes('load-extension')));
  const withExt = lib.chromeArgs(cfg, { headless: true, profileDir: '/data/profile', extensionDir: ext.EXT_DIR });
  assert.ok(withExt.includes(`--load-extension=${ext.EXT_DIR}`) && withExt.includes(`--disable-extensions-except=${ext.EXT_DIR}`));
  assert.ok(!withExt.includes('--disable-extensions'), 'it would switch the headers extension off too');
  assert.equal(withExt.filter((a) => a.startsWith('--disable-features=')).length, 1, 'a second --disable-features would replace the first');
  assert.equal(withExt.at(-1), 'about:blank');
  // Same algorithm in the container and in the portal, and the id is 32 letters a-p.
  assert.equal(extensionId(), ext.extensionId());
  assert.match(extensionId(), /^[a-p]{32}$/);
  assert.equal(extensionId('/dev/shm/other'), ext.extensionId('/dev/shm/other'));
  assert.notEqual(extensionId('/dev/shm/other'), extensionId());
  assert.equal(ext.EXT_DIR, '/dev/shm/cpb-ext');
});

test('a pool with headers whose start built no extension still runs with extensions off (T-1660 review)', () => {
  // With headers the policy has no blocked default, so the command line is the guard whenever the init built no extension: the file
  // not delivered yet (a new pod), unreadable, not JSON, or every entry dropped. Each of those ends in prepareHeaders() returning null.
  const cfg = lib.loadConfig('/nonexistent/config.json');
  assert.equal(ext.buildExtension([{ hosts: ['a.example.com'], name: 'Cookie', value: fresh() }]).count, 0, 'all entries dropped: nothing to load');
  const none = lib.chromeArgs(cfg, { headless: false, profileDir: '/data/profile', extensionDir: null });
  assert.ok(none.includes('--disable-extensions'), 'a planted extension in the persistent profile cannot load');
  assert.ok(!none.some((a) => /load-extension|disable-extensions-except/.test(a)));
  assert.ok(lib.chromeArgs(cfg, { headless: true, profileDir: '/p' }).includes('--disable-extensions'), 'the default is the guard too');
  // The init hands Chrome exactly what prepareHeaders() built, and prepareHeaders() returns a folder only when it holds rules.
  const init = readFileSync(new URL('../../../../images/browser/cpb/init.mjs', import.meta.url), 'utf8');
  assert.match(init, /const extensionDir = prepareHeaders\(\);/);
  assert.match(init, /chromeArgs\(cfg, \{ headless, profileDir, extensionDir \}\)/);
  assert.match(init, /return out\.count \? EXT_DIR : null;/);
});

test('a pool’s own Chrome flags can’t load an extension or change which ones run', () => {
  const base = lib.loadConfig('/nonexistent/config.json') as Record<string, unknown>;
  const own = ['--load-extension=/data/profile/evil', '--disable-extensions-except=/data/profile/evil', '--LOAD-EXTENSION=/x', '--extensions-on-chrome-urls', '--disable-features=Foo', '--enable-features=DisableLoadExtensionCommandLineSwitch', '--load-component-extension=/data/profile/evil'];
  for (const extensionDir of [null, ext.EXT_DIR]) {
    const args = lib.chromeArgs({ ...base, chromeFlags: [...own, '--lang=de'] }, { headless: true, profileDir: '/p', extensionDir });
    for (const f of own) assert.ok(!args.includes(f), f);
    assert.ok(!args.some((a) => a.includes('/data/profile/evil')));
    assert.ok(args.includes('--lang=de'), 'other flags still pass');
    assert.equal(args.filter((a) => a.startsWith('--disable-features=')).length, 1);
  }
});

test('the policy lets Chromium load the headers extension, and shuts every other way in, only when the pool has headers (T-1660)', () => {
  const plain = chromePolicy(content({ headers: [] }), { portalHosts: [] });
  assert.deepEqual(plain.ExtensionInstallBlocklist, ['*']);
  for (const k of ['ExtensionSettings', 'ExtensionAllowedTypes', 'BlockExternalExtensions', 'ExtensionDeveloperModeSettings', 'ExtensionInstallAllowlist']) assert.equal(plain[k], undefined, k);
  assert.ok(!(plain.URLBlocklist as string[]).includes('chrome-extension://*'));
  // A pool saved before headers existed has no field at all.
  assert.deepEqual(chromePolicy({ ...content(), headers: undefined as never }, { portalHosts: [] }).ExtensionInstallBlocklist, ['*']);

  for (const allowlistMode of [false, true]) {
    const p = JSON.parse(JSON.stringify(chromePolicy(content({ allowlistMode }), { portalHosts: ['172.17.0.1:3104'] }))) as Record<string, unknown>;
    // Chromium refuses every unpacked extension while the default is blocked, whatever an allowlist says, and a headed browser then
    // holds a modal "Error Loading Extension" dialog before CDP listens (the 2026-10-19 CrashLoopBackOff; seen in the image, Chromium 155).
    assert.equal(p.ExtensionInstallBlocklist, undefined, 'a blocked default refuses --load-extension');
    assert.equal(p.ExtensionInstallAllowlist, undefined, 'an allowlist means nothing without a blocked default');
    assert.deepEqual(p.ExtensionSettings, { 'update_url:https://clients2.google.com/service/update2/crx': { installation_mode: 'blocked' } }, 'the Web Store is shut by its update URL');
    assert.deepEqual(p.ExtensionAllowedTypes, ['extension']);
    assert.equal(p.BlockExternalExtensions, true);
    assert.equal(p.ExtensionDeveloperModeSettings, 1, 'no Load unpacked for a person in a take-over');
    const blocked = p.URLBlocklist as string[];
    // `file:///dev/shm`: the extension's rules.json holds the values (seen blocked in Chromium 154, a file elsewhere still opens).
    for (const u of ['chrome-extension://*', 'file://*', 'chrome://extensions', 'chromewebstore.google.com', 'chrome.google.com/webstore', '172.17.0.1:3104', 'cluster.local']) assert.ok(blocked.includes(u), u);
    assert.equal(blocked[0] === '*', allowlistMode, 'allowlist mode still blocks everything else first');
    assert.ok(!((p.URLAllowlist as string[] | undefined) ?? []).some((u) => u.startsWith('file:')), 'no allowlist entry reopens it');
    // Only policy names Chromium knows, each with the type it expects: a mistyped key is ignored, which would leave the browser looser.
    const types: Record<string, string> = {
      BrowserSignin: 'number', SyncDisabled: 'boolean', PasswordManagerEnabled: 'boolean', AutofillAddressEnabled: 'boolean', AutofillCreditCardEnabled: 'boolean',
      MetricsReportingEnabled: 'boolean', BackgroundModeEnabled: 'boolean', HighEfficiencyModeEnabled: 'boolean', DefaultBrowserSettingEnabled: 'boolean',
      TranslateEnabled: 'boolean', DownloadDirectory: 'string', PromptForDownloadLocation: 'boolean', DownloadRestrictions: 'number', URLBlocklist: 'array',
      URLAllowlist: 'array', ExtensionSettings: 'object', ExtensionAllowedTypes: 'array', BlockExternalExtensions: 'boolean', ExtensionDeveloperModeSettings: 'number',
    };
    for (const [k, v] of Object.entries(p)) assert.equal(Array.isArray(v) ? 'array' : typeof v, types[k], k);
  }
});

test('the incident’s pool (two headers on the same 12 hosts) builds one valid ruleset: a rule pair per host, both headers in each', () => {
  const hosts = Array.from({ length: 12 }, (_, i) => `stg-app${i}.example.com`);
  const id = fresh();
  const secret = fresh();
  const built = ext.buildExtension([{ hosts, name: 'CF-Access-Client-Id', value: id }, { hosts, name: 'CF-Access-Client-Secret', value: secret }]);
  assert.equal(built.count, 12);
  assert.deepEqual(built.dropped, []);
  const rules = built.rules as unknown as { id: number; action: { type: string; requestHeaders: { header: string; operation: string; value: string }[] }; condition: { regexFilter: string; resourceTypes: string[]; initiatorDomains?: string[] } }[];
  assert.deepEqual(rules.map((r) => r.id), Array.from({ length: 24 }, (_, i) => i + 1), 'ids are unique positive integers');
  for (const r of rules) {
    assert.equal(r.action.type, 'modifyHeaders');
    assert.deepEqual(r.action.requestHeaders.map((h) => [h.header, h.operation, h.value]), [['CF-Access-Client-Id', 'set', id], ['CF-Access-Client-Secret', 'set', secret]]);
    assert.ok(r.condition.regexFilter.length < 200, 'well under the regex size limit');
    assert.doesNotThrow(() => new RegExp(r.condition.regexFilter));
    assert.ok(r.condition.resourceTypes.length > 0);
  }
  assert.equal(rules.filter((r) => r.condition.initiatorDomains).length, 12);
  assert.deepEqual(built.manifest.declarative_net_request, { rule_resources: [{ id: 'headers', enabled: true, path: 'rules.json' }] });
  assert.equal(built.manifest.manifest_version, 3);
});

test('resolveHeaders: a removed, ambiguous or valueless secret leaves its header out, with the reason', () => {
  const v = fresh();
  const lookup: SecretLookup = (name) => (name === 'HERE' ? { ok: true, value: v, version: 'ver1' } : { ok: false, why: name === 'TWO' ? 'ambiguous' : 'not found' });
  const rules: BrowserHeaderRule[] = [
    { hosts: ['a.example.com'], name: 'X-One', secret: 'HERE' },
    { hosts: ['a.example.com'], name: 'X-Two', secret: 'GONE' },
    { hosts: ['a.example.com'], name: 'X-Three', secret: 'TWO' },
  ];
  const { entries, skipped } = resolveHeaders(rules, lookup);
  assert.deepEqual(entries.map((e) => e.name), ['X-One']);
  assert.deepEqual(skipped, [
    { name: 'X-Two', secret: 'GONE', why: 'not found' },
    { name: 'X-Three', secret: 'TWO', why: 'ambiguous' },
  ]);
  assert.ok(!JSON.stringify(skipped).includes(v));
  assert.deepEqual(resolveHeaders(rules, undefined).entries, [], 'without a lookup nothing is sent');
  assert.deepEqual(resolveHeaders(undefined, lookup), { entries: [], skipped: [] });
});

/** The pool and the delivery, built around one value: where may it appear? */
function world(value: string) {
  const entries: ResolvedHeader[] = [{ name: RULE.name, hosts: RULE.hosts, secret: RULE.secret, value, version: 'value-id-1' }];
  const c = content();
  const plan: KubePlan = { workspace: 'dev', poolId: 'p1', content: c, portalHosts: ['portal:3000'], image: 'img:1', headers: entries };
  return { entries, c, plan };
}

test('the value is in the headers file and nowhere else the portal or the agent can read: pool, plugin, config, policy, spec, template, audit', () => {
  const value = fresh();
  const { entries, c, plan } = world(value);
  assert.ok(headersFile(entries).includes(value), 'the file the container reads is the one place');
  // The pool as stored and as the view shows it: names only.
  assert.ok(!JSON.stringify(c).includes(value));
  // What is delivered into the workspace (plugin, gate, skill, drop-in): nothing of it, and the gate is told the header's name to redact.
  const compiled = compileBrowser({ pool, content: c });
  assert.ok(!JSON.stringify(compiled).includes(value));
  assert.ok(!JSON.stringify(mcpServers(c)).includes(value));
  assert.ok((mcpServers(c) as { browser: { args: string[] } }).browser.args.includes('CF-Access-Client-Secret'), 'the gate redacts the header by name');
  assert.ok(!JSON.stringify(mcpServers(content({ headers: [] }))).includes('--redact'), 'no headers, no flag: existing pools compile as before');
  // The gate masks the value too: it gets the secret's name (--redact-env) and Claude Code passes the variable through by reference.
  const servers = mcpServers(c) as { browser: { args: string[]; env?: Record<string, string> } };
  assert.ok(servers.browser.args.join(' ').includes('--redact-env CF_ACCESS_SECRET'));
  assert.deepEqual(servers.browser.env, { CF_ACCESS_SECRET: '${CF_ACCESS_SECRET:-}' });
  assert.equal(mcpServers(content({ headers: [] })).browser && (mcpServers(content({ headers: [] })).browser as { env?: unknown }).env, undefined);
  // The browser container's config files and the Kubernetes objects other than the Secret.
  assert.ok(!JSON.stringify(chromePolicy(c, { portalHosts: [] })).includes(value));
  assert.ok(!JSON.stringify(configMapData(plan)).includes(value));
  assert.ok(!JSON.stringify(browserContainer(plan)).includes(value));
  assert.ok(!JSON.stringify(browserVolumes('ws-dev', c)).includes(value));
  assert.ok(!specOf(plan, 'ws-dev').includes(value));
  const template = withBrowser({ metadata: { annotations: {} }, spec: { containers: [{ name: 'workspace', image: 'ws:1' }] } }, 'ws-dev', plan);
  assert.ok(!JSON.stringify(template).includes(value));
  // The spec hash input and the audit rows are names, secret names, hosts and value versions.
  assert.ok(!JSON.stringify(headersSpec(entries)).includes(value));
});

test('Kubernetes: the headers folder is a memory-backed emptyDir mounted into the browser container only, with or without headers; no Secret object', () => {
  const value = fresh();
  const { c, plan } = world(value);
  const bare: KubePlan = { ...plan, content: { ...c, headers: [] }, headers: [] };
  for (const p of [plan, bare]) {
    const template = withBrowser({ metadata: {}, spec: { containers: [{ name: 'workspace', image: 'ws:1' }] } }, 'ws-dev', p);
    const browser = template.spec!.containers.find((x) => x.name === 'browser')!;
    assert.deepEqual(browser.volumeMounts!.filter((m) => m.name === 'cpb-secrets'), [{ name: 'cpb-secrets', mountPath: '/etc/cpb-secrets' }]);
    assert.equal(template.spec!.containers.find((x) => x.name === 'workspace')!.volumeMounts, undefined, 'the workspace container never mounts it');
    const vol = template.spec!.volumes!.find((v) => v.name === 'cpb-secrets')!;
    assert.deepEqual(vol, { name: 'cpb-secrets', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } });
    assert.ok(!template.spec!.volumes!.some((v) => v.secret), 'no Secret volume');
  }
});

test('the spec does not follow the headers: a rotated, removed or added secret never restarts the pod', () => {
  const { entries, plan } = world(fresh());
  const base = specOf(plan, 'ws-dev');
  assert.equal(specOf({ ...plan, headers: entries.map((e) => ({ ...e, version: 'value-id-2', value: fresh() })) }, 'ws-dev'), base, 'rotated');
  assert.equal(specOf({ ...plan, headers: [] }, 'ws-dev'), base, 'removed');
});

test('the extension adds a header to a host’s own pages and to navigations only: other sites’ requests to it get none (m2)', () => {
  const built = ext.buildExtension([{ hosts: ['app.example.com', '*.stg.example.com', 'dev.example.com:8443'], name: 'X-Edge', value: fresh() }]);
  assert.equal(built.count, 3);
  const rules = built.rules as unknown as { condition: { regexFilter: string; resourceTypes: string[]; initiatorDomains?: string[] } }[];
  const navs = rules.filter((r) => r.condition.resourceTypes.join() === 'main_frame');
  const subs = rules.filter((r) => r.condition.resourceTypes.includes('xmlhttprequest'));
  assert.equal(navs.length + subs.length, rules.length);
  assert.ok(navs.every((r) => r.condition.initiatorDomains === undefined), 'a typed address has no initiator: it must match');
  assert.ok(subs.every((r) => !r.condition.resourceTypes.includes('main_frame') && r.condition.initiatorDomains?.length === 1), 'everything else needs an initiator');
  assert.deepEqual(subs.map((r) => r.condition.initiatorDomains![0]).sort(), ['app.example.com', 'dev.example.com', 'stg.example.com']);
  for (const type of ['sub_frame', 'xmlhttprequest', 'script', 'image', 'websocket', 'ping', 'other']) assert.ok(subs.every((r) => r.condition.resourceTypes.includes(type)), type);
});

test('Docker: headers.json is a private file in a private folder, and the config and policy stay world-readable', async () => {
  const value = fresh();
  const tar = await tarOf([
    { path: 'etc/cpb/config.json', content: '{}\n' },
    { path: 'etc/cpb-secrets/headers.json', content: headersFile(world(value).entries), private: true },
  ]);
  const seen = new Map<string, { mode: number; uid: number; gid: number; body: string }>();
  await new Promise<void>((resolve, reject) => {
    const x = extract();
    x.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (d) => chunks.push(d as Buffer));
      stream.on('end', () => {
        seen.set(header.name, { mode: (header.mode ?? 0) & 0o777, uid: header.uid ?? -1, gid: header.gid ?? -1, body: Buffer.concat(chunks).toString('utf8') });
        next();
      });
    });
    x.on('finish', resolve);
    x.on('error', reject);
    x.end(tar);
  });
  assert.equal(seen.get('etc/cpb-secrets/')?.mode, 0o700);
  assert.equal(seen.get('etc/cpb-secrets/headers.json')?.mode, 0o400);
  assert.equal(seen.get('etc/cpb-secrets/headers.json')?.uid, 0);
  assert.ok(seen.get('etc/cpb-secrets/headers.json')!.body.includes(value));
  assert.equal(seen.get('etc/cpb/')?.mode, 0o755);
  assert.equal(seen.get('etc/cpb/config.json')?.mode, 0o644);
  for (const [name, f] of seen) if (name !== 'etc/cpb-secrets/headers.json') assert.ok(!f.body.includes(value), name);
});

test('service: the value reaches the container plan, the audit names secrets and never values, and a removed secret stops the header at the next delivery', async () => {
  const value = fresh();
  let present = true;
  const lookup: SecretLookup = (name) => (name === RULE.secret && present ? { ok: true, value, version: 'value-id-1' } : { ok: false, why: 'not found' });
  const h = await browserHarness({ secretByName: lookup });
  try {
    h.target.addWorkspace('dev');
    const p = h.create('Dev browser', { allowedSites: ['app.example.com', '*.example.com'], headers: [RULE] });
    h.pools.setAssignments('docker/dev', 'browser', [{ poolId: p.id }]);
    await h.service.converge('docker/dev', 'test');
    assert.equal(h.target.state.created.length, 1);
    assert.deepEqual(h.target.state.created[0]!.headers.map((e) => [e.name, e.value]), [[RULE.name, value]], 'the plan carries the value to the container');

    // The audit: the header, its secret's name and hosts; never the value. One row per change, not per pass.
    await h.service.converge('docker/dev', 'again');
    const rows = () => h.store.db!.prepare("SELECT details FROM browser_events WHERE workspace_id = ? AND kind = 'headers' ORDER BY id").all('docker/dev') as { details: string }[];
    assert.equal(rows().length, 1);
    assert.deepEqual(JSON.parse(rows()[0]!.details), { headers: [{ name: RULE.name, secret: RULE.secret, hosts: RULE.hosts }], skipped: [] });
    const everything = JSON.stringify(h.store.db!.prepare('SELECT * FROM browser_events').all()) + JSON.stringify(h.store.db!.prepare('SELECT * FROM pool_revisions').all());
    assert.ok(!everything.includes(value), 'no event and no pool revision holds the value');

    // The secret is removed: the next delivery has no header (applied once the browser is idle), and the audit says why.
    present = false;
    h.target.state.supervisor = supervisorStatus({ activity: { at: Date.now() - 120_000, toolAt: Date.now() - 120_000, tool: null, session: null } });
    await h.service.converge('docker/dev', 'secret removed');
    assert.equal(h.target.state.created.length, 2, 'the container was recreated');
    assert.deepEqual(h.target.state.created[1]!.headers, [], 'without the header');
    const last = JSON.parse(rows().at(-1)!.details) as { headers: unknown[]; skipped: unknown[] };
    assert.deepEqual(last, { headers: [], skipped: [{ name: RULE.name, secret: RULE.secret, why: 'not found' }] });
    assert.ok(!JSON.stringify(h.store.db!.prepare('SELECT * FROM browser_events').all()).includes(value));
  } finally {
    h.done();
  }
});

test('secretByName: found by name in the current revision, and a removed secret stops being found at the next delivery', async () => {
  const h = await secretsHarness();
  try {
    const value = fresh();
    const p = h.service.create('secrets', { name: 'edge', content: { entries: [{ kind: 'secret', name: 'CF_ACCESS_SECRET', newValue: value }, { kind: 'variable', name: 'PLAIN', value: 'x' }, { kind: 'secret', name: 'NO_VALUE' }] } });
    const found = h.kind.secretByName('CF_ACCESS_SECRET');
    assert.ok(found.ok);
    if (found.ok) {
      assert.equal(found.value, value);
      assert.ok(found.version && !found.version.includes(value), 'the version is an id, not the value');
    }
    assert.deepEqual(h.kind.secretByName('PLAIN'), { ok: false, why: 'not found' }, 'a variable is not a secret');
    assert.deepEqual(h.kind.secretByName('NOPE'), { ok: false, why: 'not found' });
    assert.deepEqual(h.kind.secretByName('NO_VALUE'), { ok: false, why: 'has no value' });

    // The same name in a second set: not guessed.
    h.service.create('secrets', { name: 'other', content: { entries: [{ kind: 'secret', name: 'CF_ACCESS_SECRET', newValue: fresh() }] } });
    assert.deepEqual(h.kind.secretByName('CF_ACCESS_SECRET'), { ok: false, why: 'ambiguous' });

    // Removing the secret from its set: the lookup no longer finds it, so the header stops at the next delivery.
    const entries = (h.service.get(p.id).content as { entries: { name: string }[] }).entries;
    h.service.update(p.id, { content: { entries: entries.filter((e) => e.name !== 'CF_ACCESS_SECRET') } });
    const other = h.kind.secretByName('CF_ACCESS_SECRET');
    assert.ok(other.ok, 'the other set still has its own');
    h.service.delete(h.service.list('secrets').find((s) => s.name === 'other')!.id);
    assert.deepEqual(h.kind.secretByName('CF_ACCESS_SECRET'), { ok: false, why: 'not found' });
    assert.deepEqual(resolveHeaders([RULE], (n) => h.kind.secretByName(n)), { entries: [], skipped: [{ name: RULE.name, secret: RULE.secret, why: 'not found' }] });
  } finally {
    h.done();
  }
});

// T-623 S2: a header rule may name a variable inside an env-file entry (`{ hosts, name, secret, key }`). Values are built at run time.
const ENV_RULE = (key: string): BrowserHeaderRule => ({ hosts: ['app.example.com'], name: 'CF-Access-Client-Id', secret: 'u__.stg-handoff__cf-access.env', key });

test('T-623 envFileValue: KEY=VALUE lines, export, quotes stripped, comments and blanks skipped, the last line wins, a missing or empty key is null', () => {
  const a = fresh(), d = fresh(), b = fresh(), c = fresh();
  const text = ['# a comment', '', `CF_ID=${a}`, `export CF_SECRET="${b}"`, `QUOTED='${c}'`, `OTHER=${d}\r`, 'EMPTY=', `CF_ID=${d}`, `  SPACED  =  ${a}  `].join('\n');
  assert.equal(envFileValue(text, 'CF_ID'), d, 'the last line wins');
  assert.equal(envFileValue(text, 'CF_SECRET'), b);
  assert.equal(envFileValue(text, 'QUOTED'), c);
  assert.equal(envFileValue(text, 'OTHER'), d, 'CRLF');
  assert.equal(envFileValue(text, 'SPACED'), a);
  assert.equal(envFileValue(text, 'EMPTY'), null);
  assert.equal(envFileValue(text, 'MISSING'), null);
  assert.equal(envFileValue(`# CF_ID=${a}`, 'CF_ID'), null, 'a commented line is not a value');
  assert.equal(envFileValue(`XCF_ID=${a}`, 'CF_ID'), null, 'a longer name is not the key');
});

test('T-623 S2c envFileValue: a key that is a prefix of another variable matches only its own line, in either order', () => {
  const a = fresh(), b = fresh();
  for (const text of [`CF_ID_2=${b}\nCF_ID=${a}\nCF_ID_2=${b}`, `CF_ID=${a}\nCF_ID_2=${b}`, `CF_ID_2=${b}\nCF_ID=${a}`]) {
    assert.equal(envFileValue(text, 'CF_ID'), a);
    assert.equal(envFileValue(text, 'CF_ID_2'), b);
  }
  assert.equal(envFileValue(`CF_ID_2=${b}`, 'CF_ID'), null, 'a key that only prefixes another variable is absent');
});

test('T-623 S2c envFileValue: an inline “# note” is dropped, a # without a space before it stays, a quoted value keeps its #, a BOM does not hide the first key', () => {
  const a = fresh(), b = fresh();
  assert.equal(envFileValue(`K=${a} # note`, 'K'), a);
  assert.equal(envFileValue(`K=${a}\t#note`, 'K'), a);
  assert.equal(envFileValue(`K="${a}" # note`, 'K'), a);
  assert.equal(envFileValue(`K='${a}'  # it's "x"`, 'K'), a);
  assert.equal(envFileValue(`K="${a} # kept"`, 'K'), `${a} # kept`);
  assert.equal(envFileValue(`K=${a}#${b}`, 'K'), `${a}#${b}`, 'a # inside a value is part of it');
  assert.equal(envFileValue('K= # only a note', 'K'), null);
  const bom = String.fromCharCode(0xfeff); // written as an escape: the character itself is invisible in an editor
  assert.equal(envFileValue(`${bom}FIRST=${a}\nSECOND=${b}`, 'FIRST'), a, 'a BOM does not hide the first key');
  assert.equal(envFileValue(`${bom}FIRST=${a}\nSECOND=${b}`, 'SECOND'), b);
});

test('T-623 resolveHeaders: a key from an env entry reaches headers.json; a missing key is left out with a reason that holds no value', () => {
  const id = fresh(), secret = fresh(), other = fresh();
  const entry = `CF_ID=${id}\nCF_SECRET="${secret}"\nUNRELATED=${other}\n`;
  const lookup: SecretLookup = (n) => (n === ENV_RULE('x').secret ? { ok: true, value: entry, version: 'entry-v1' } : { ok: false, why: 'not found' });
  const { entries, skipped } = resolveHeaders([ENV_RULE('CF_ID'), { ...ENV_RULE('CF_SECRET'), name: 'CF-Access-Client-Secret' }, { ...ENV_RULE('CF_NOPE'), name: 'X-Missing' }], lookup);
  assert.deepEqual(entries.map((e) => [e.name, e.value, e.key]), [['CF-Access-Client-Id', id, 'CF_ID'], ['CF-Access-Client-Secret', secret, 'CF_SECRET']]);
  const file = JSON.parse(headersFile(entries)) as { name: string; value: string }[];
  assert.deepEqual(file.map((f) => [f.name, f.value]), [['CF-Access-Client-Id', id], ['CF-Access-Client-Secret', secret]], 'headers.json holds the key’s value, not the entry');
  assert.ok(!headersFile(entries).includes(other), 'the other variables of the entry are not delivered');
  assert.deepEqual(skipped, [{ name: 'X-Missing', secret: ENV_RULE('x').secret, key: 'CF_NOPE', why: 'the entry has no CF_NOPE' }]);
  for (const v of [id, secret, other]) assert.ok(!JSON.stringify(skipped).includes(v), 'the skip reason never holds a value');
});

test('T-623: the key’s value never lands in argv, the pool, the view, the audit, the spec hash or an error', async () => {
  const id = fresh(), secret = fresh();
  const entry = `CF_ID=${id}\nCF_SECRET=${secret}\n`;
  const rules = [ENV_RULE('CF_ID'), { ...ENV_RULE('CF_SECRET'), name: 'CF-Access-Client-Secret' }, { ...ENV_RULE('CF_NOPE'), name: 'X-Missing' }];
  const lookup: SecretLookup = () => ({ ok: true, value: entry, version: 'entry-v1' });
  const { entries, skipped } = resolveHeaders(rules, lookup);
  const c = content({ headers: rules });
  const plan: KubePlan = { workspace: 'dev', poolId: 'p1', content: c, portalHosts: ['portal:3000'], image: 'img:1', headers: entries };
  const where: [string, unknown][] = [
    ['pool content', c], ['compiled plugin', compileBrowser({ pool, content: c })], ['gate argv and env', mcpServers(c)], ['policy', chromePolicy(c, { portalHosts: [] })],
    ['container args', browserContainer(plan)], ['config map', configMapData(plan)], ['spec hash input', specOf(plan, 'ws-dev')], ['spec headers', headersSpec(entries)],
    ['audit summary', headersSummary(entries, skipped)], ['skips', skipped],
  ];
  for (const v of [id, secret, entry]) for (const [what, data] of where) assert.ok(!(typeof data === 'string' ? data : JSON.stringify(data)).includes(v), `${what} holds no value`);
  assert.ok(headersFile(entries).includes(id) && headersFile(entries).includes(secret), 'the file the container reads is the one place');
  assert.deepEqual(headersSpec(entries).map((e) => e.key), ['CF_ID', 'CF_SECRET'], 'the key name is in the spec: a rule that changes key changes the hash');
  // The gate masks by the key's own variable name (the workspace has the env file's variables), not by the entry's name.
  assert.deepEqual((mcpServers(c) as { browser: { env?: Record<string, string> } }).browser.env, { CF_ID: '${CF_ID:-}', CF_NOPE: '${CF_NOPE:-}', CF_SECRET: '${CF_SECRET:-}' });
  // An error from saving never holds a value either.
  const h = await browserHarness();
  try {
    for (const key of ['bad key', '1X', 'A'.repeat(129)]) {
      assert.throws(() => h.kind.parse({ allowedSites: ['app.example.com'], headers: [{ hosts: ['app.example.com'], name: 'X-A', secret: 'S', key }] }, null), (e) => isAppError(e) && e.code === 'VALIDATION_FAILED' && !String((e as Error).message).includes(id));
    }
    assert.throws(() => h.kind.parse({ allowedSites: ['app.example.com'], headers: [{ hosts: ['app.example.com'], name: 'X-A', secret: 'S', key: 7 }] }, null), (e) => isAppError(e));
    const ok = h.kind.parse({ allowedSites: ['app.example.com'], headers: [{ hosts: ['app.example.com'], name: 'X-A', secret: 'S', key: ' CF_ID ' }, { hosts: ['app.example.com'], name: 'X-B', secret: 'S' }, { hosts: ['app.example.com'], name: 'X-C', secret: 'S', key: null }] }, null);
    assert.deepEqual(ok.headers, [{ hosts: ['app.example.com'], name: 'X-A', secret: 'S', key: 'CF_ID' }, { hosts: ['app.example.com'], name: 'X-B', secret: 'S' }, { hosts: ['app.example.com'], name: 'X-C', secret: 'S' }]);
    // T-623 S2c: a blank or whitespace key is refused with its reason (a 400), never saved as a rule that delivers the whole entry.
    for (const key of ['', '   ', '\t', '\n ']) {
      assert.throws(() => h.kind.parse({ allowedSites: ['app.example.com'], headers: [{ hosts: ['app.example.com'], name: 'X-A', secret: 'S', key }] }, null),
        (e) => isAppError(e) && e.code === 'VALIDATION_FAILED' && /key can’t be blank/.test((e as Error).message));
    }
  } finally {
    h.done();
  }
});

test('T-623 service: a keyed header is delivered, a missing key is audited and left out, and the audit never holds a value', async () => {
  const id = fresh(), secret = fresh();
  let text = `CF_ID=${id}\nCF_SECRET=${secret}\n`;
  const rule = ENV_RULE('CF_ID');
  const lookup: SecretLookup = (n) => (n === rule.secret ? { ok: true, value: text, version: `v-${text.length}` } : { ok: false, why: 'not found' });
  const h = await browserHarness({ secretByName: lookup });
  try {
    h.target.addWorkspace('dev');
    const p = h.create('Dev browser', { allowedSites: ['app.example.com'], headers: [rule] });
    h.pools.setAssignments('docker/dev', 'browser', [{ poolId: p.id }]);
    await h.service.converge('docker/dev', 'test');
    assert.deepEqual(h.target.state.created[0]!.headers.map((e) => [e.name, e.value]), [[rule.name, id]]);
    const rows = () => h.store.db!.prepare("SELECT details FROM browser_events WHERE workspace_id = ? AND kind = 'headers' ORDER BY id").all('docker/dev') as { details: string }[];
    assert.deepEqual(JSON.parse(rows()[0]!.details), { headers: [{ name: rule.name, secret: rule.secret, key: 'CF_ID', hosts: rule.hosts }], skipped: [] });
    // The variable leaves the entry: the header goes at the next delivery, and the audit says which key was missing.
    text = `CF_SECRET=${secret}\n`;
    h.target.state.supervisor = supervisorStatus({ activity: { at: Date.now() - 120_000, toolAt: Date.now() - 120_000, tool: null, session: null } });
    await h.service.converge('docker/dev', 'key removed');
    assert.deepEqual(h.target.state.created.at(-1)!.headers, []);
    assert.deepEqual(JSON.parse(rows().at(-1)!.details), { headers: [], skipped: [{ name: rule.name, secret: rule.secret, key: 'CF_ID', why: 'the entry has no CF_ID' }] });
    const everything = JSON.stringify(h.store.db!.prepare('SELECT * FROM browser_events').all()) + JSON.stringify(h.store.db!.prepare('SELECT * FROM pool_revisions').all());
    for (const v of [id, secret]) assert.ok(!everything.includes(v), 'no event and no pool revision holds a value');
  } finally {
    h.done();
  }
});
