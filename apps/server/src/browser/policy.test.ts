import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIPv6 } from 'node:net';
import { BROWSER_POOL_DEFAULTS, type BrowserPoolContent } from '@portal/contracts';
import { chromePolicy, chromeUrlPattern, METADATA_HOSTS } from './policy.js';
import { coveredBy } from './headers.js';

const content = (over: Partial<BrowserPoolContent> = {}): BrowserPoolContent => ({ ...BROWSER_POOL_DEFAULTS, ...over });

/**
 * The host part of a Chrome URL pattern (`[scheme://][.]host[:port][/path]`), as Chrome's URLBlocklist parser takes it: a host label
 * list, `*`, or a bracketed IPv6 literal. Null for what Chrome logs as "Invalid pattern" (an unbracketed IPv6 address, a `*.` prefix).
 */
function chromeHost(pattern: string): string | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(\.?)(\[[0-9a-f:.]+\]|[a-z0-9.*-]+)(?::\d{1,5})?(?:\/.*)?$/i.exec(pattern);
  if (!m) return null;
  const host = m[2]!;
  if (host.startsWith('[')) return isIPv6(host.slice(1, -1)) ? host : null;
  if (host !== '*' && host.includes('*')) return null;
  return host;
}

test('T-1715: every metadata address is blocked in a form Chrome accepts (IPv6 bracketed)', () => {
  for (const allowlistMode of [false, true]) {
    const blocked = chromePolicy(content({ allowlistMode, allowedSites: ['example.com'] }), { portalHosts: ['172.17.0.1:3104'] }).URLBlocklist as string[];
    for (const host of METADATA_HOSTS) {
      const want = isIPv6(host) ? `[${host}]` : host;
      assert.ok(blocked.includes(want), `${host} blocked as ${want}`);
      assert.ok(!blocked.includes(host) || !isIPv6(host), `${host} not written unbracketed`);
    }
    for (const entry of blocked.filter((e) => !e.includes('://') || /^https?:\/\//.test(e))) assert.notEqual(chromeHost(entry), null, `${entry} is a valid Chrome pattern`);
  }
  assert.ok((chromePolicy(content(), { portalHosts: [] }).URLBlocklist as string[]).includes('[fd00:ec2::254]'));
});

test('T-1715: IPv6 literals are bracketed anywhere in a pattern; IPv4, hosts and other entries stay as written', () => {
  assert.equal(chromeUrlPattern('fd00:ec2::254'), '[fd00:ec2::254]');
  assert.equal(chromeUrlPattern('::1'), '[::1]');
  assert.equal(chromeUrlPattern('http://fd00:ec2::254/latest'), 'http://[fd00:ec2::254]/latest');
  for (const same of ['[fd00:ec2::254]', '[::1]:8080', '169.254.169.254', '172.17.0.1:3104', 'metadata.google.internal', 'cluster.local', 'localhost:5173', '*', 'about:blank', 'file://*', 'chrome://extensions', 'chrome-extension://*', 'chrome.google.com/webstore', '.example.com']) {
    assert.equal(chromeUrlPattern(same), same, same);
  }
  const blocked = chromePolicy(content({ blockedSites: ['2001:db8::1', 'http://[2001:db8::2]:8080'] }), { portalHosts: [] }).URLBlocklist as string[];
  assert.ok(blocked.includes('[2001:db8::1]'));
  assert.ok(blocked.includes('http://[2001:db8::2]:8080'));
});

test('T-1716: a *.domain site becomes the domain (Chrome matches it and every subdomain), in the allowlist and the blocklist', () => {
  assert.equal(chromeUrlPattern('*.example.com'), 'example.com');
  assert.equal(chromeUrlPattern('https://*.example.com:8443/app'), 'https://example.com:8443/app');
  assert.equal(chromeUrlPattern(' *.example.com '), 'example.com');
  assert.equal(chromeUrlPattern('example.com'), 'example.com', 'a plain host already includes subdomains in Chrome');
  assert.equal(chromeUrlPattern('.example.com'), '.example.com', 'a leading dot keeps that host only');

  const p = chromePolicy(content({ allowlistMode: true, allowedSites: ['*.example.com', 'example.com', 'localhost:5173'], blockedSites: ['*.evil.test'] }), { portalHosts: [] });
  assert.deepEqual(p.URLAllowlist, ['about:blank', 'example.com', 'localhost:5173'], 'normalised and deduplicated');
  assert.ok((p.URLBlocklist as string[]).includes('evil.test'));
  for (const entry of [...(p.URLAllowlist as string[]).slice(1), ...(p.URLBlocklist as string[])]) {
    if (!entry.includes('://')) assert.notEqual(chromeHost(entry), null, `${entry} is a valid Chrome pattern`);
  }
});

test('T-1716: header hosts are covered by allowed sites with the same matching Chrome uses', () => {
  // `*.example.com` and plain `example.com` allow the domain and every subdomain (the stg-app0 case).
  for (const site of ['*.example.com', 'example.com', 'https://example.com/', 'example.com/path']) {
    for (const host of ['stg-app0.example.com', 'example.com', 'a.b.example.com', '*.example.com', '*.stg.example.com', 'app.example.com:8443']) assert.ok(coveredBy(host, [site]), `${site} covers ${host}`);
    for (const host of ['example.org', 'badexample.com', 'example.com.evil.test']) assert.ok(!coveredBy(host, [site]), `${site} does not cover ${host}`);
  }
  // `.example.com` is that host only.
  assert.ok(coveredBy('example.com', ['.example.com']));
  assert.ok(!coveredBy('stg-app0.example.com', ['.example.com']));
  assert.ok(!coveredBy('*.example.com', ['.example.com']));
  // An IP address has no subdomains; a port narrows the entry.
  assert.ok(coveredBy('10.0.0.5', ['10.0.0.5']));
  assert.ok(!coveredBy('x.10.0.0.5', ['10.0.0.5']));
  assert.ok(coveredBy('app.example.com:8443', ['example.com:8443']));
  assert.ok(!coveredBy('app.example.com:9000', ['example.com:8443']));
  // A narrower site never covers a wider header host.
  assert.ok(!coveredBy('*.example.com', ['a.example.com']));
  assert.ok(!coveredBy('example.com', ['a.example.com']));
});
