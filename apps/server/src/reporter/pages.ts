// UI reporter: the two pages the server answers itself, and the files it serves.
//   - The embed page (/reporter/v1/embed): the panel's HTML, built by the web app as a separate entry (apps/web/embed.html -> dist/embed.html),
//     served here with a CSP whose frame-ancestors is EXACTLY the requested origin when it is an allowed site of an enabled bucket. Anything
//     else gets a page that cannot be framed (frame-ancestors 'none', X-Frame-Options DENY) and says nothing useful.
//   - The connect popup (/reporter/v1/connect): a small server-rendered page; the signed-in person approves, its script POSTs same-origin
//     and hands the token to window.opener (the panel iframe, the portal's own origin) with targetOrigin = this page's origin.
//   - The vendored SDK (vendor/reporter.js, vendor/VERSION) and axe-core (vendor/axe.min.js, when vendored), with a short cache.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORTER_LIMITS } from '@portal/contracts';
import { inlineScriptHashes } from '../csp.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/* ---------- Vendored files ---------- */

/** Where the vendored files are: next to this source in development, copied beside the bundle in a build (`dist/reporter-vendor`). */
export function vendorDirs(root?: string): string[] {
  const here = fileURLToPath(new URL('./vendor/', import.meta.url));
  const dirs = [here, fileURLToPath(new URL('./reporter-vendor/', import.meta.url))];
  if (root) dirs.push(join(root, 'apps/server/src/reporter/vendor'), join(root, 'apps/server/dist/reporter-vendor'));
  return dirs;
}

interface Cached {
  path: string;
  mtimeMs: number;
  bytes: Buffer;
  etag: string;
}
const cache = new Map<string, Cached>();

/** A vendored file's bytes and an ETag, re-read when it changes on disk; null when it is not there. */
export function vendorFile(name: 'reporter.js' | 'axe.min.js' | 'VERSION', dirs: string[]): { bytes: Buffer; etag: string } | null {
  for (const d of dirs) {
    const path = join(d, name);
    if (!existsSync(path)) continue;
    const st = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit;
    const bytes = readFileSync(path);
    const c = { path, mtimeMs: st.mtimeMs, bytes, etag: `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"` };
    cache.set(path, c);
    return c;
  }
  return null;
}

export const sdkVersion = (dirs: string[]): string => vendorFile('VERSION', dirs)?.bytes.toString('utf8').trim().slice(0, 40) || '0.0.0';

/* ---------- The embed page ---------- */

const PLACEHOLDER_EMBED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Reporter</title></head>
<body style="margin:0;font:14px system-ui,sans-serif;background:Canvas;color:CanvasText"><p style="padding:16px">The reporter panel is not built on this portal yet.</p></body></html>`;

const BLANK = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reporter</title></head><body></body></html>';

/** The built panel page (dist/embed.html), or the placeholder when the web app has not been built with it. */
export function embedHtml(webDist: string | null): string {
  if (webDist) {
    const p = join(webDist, 'embed.html');
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return PLACEHOLDER_EMBED;
}

/** The CSP of the panel page when it may be framed by `origin`: the app's own rules, framed by exactly that origin. */
export function embedCsp(html: string, origin: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(html).join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${origin}`,
  ].join('; ');
}

export const REFUSED_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export const BLANK_PAGE = BLANK;

/* ---------- The connect popup ---------- */

export interface ConnectView {
  state: 'sign-in' | 'refused' | 'approve';
  bucketKey: string;
  bucketName: string;
  origin: string;
  environment: string;
  repo: string;
  person: string;
  nonce: string;
  /** Where the person signs in (this popup comes back after). */
  signInUrl: string;
}

/** A nonce for the page's one inline script. */
export const scriptNonce = (): string => randomBytes(16).toString('base64');

export function connectCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/** The pilot mark (apps/web/public/favicon.svg, components/LogoMark.tsx), inline: the page's CSP allows no other image source it needs. */
const MARK = `<svg class="mark" viewBox="0 0 32 32" width="40" height="40" aria-hidden="true"><rect width="32" height="32" rx="9" class="t"/><path d="M16 7.6 22.6 23.6 16 19.9 9.4 23.6Z" transform="rotate(45 16 16)" fill="none" class="s" stroke-width="2.6" stroke-linejoin="round"/><circle cx="23.6" cy="8.4" r="2.2" fill="#34d399"/></svg>`;

/** The few characters the popup and the panel both show, so the person can tell the window belongs to the panel they pressed. */
export const connectCode = (nonce: string): string => nonce.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();

/**
 * The popup's page. Its script posts the approval same-origin (JSON, so a cross-site form cannot). When `window.opener` is the panel (a
 * window of this origin) it hands the token over with targetOrigin = location.origin: only a window of the portal's own origin can receive
 * it. When the opener is gone (signing in here went through the portal's pages, whose Cross-Origin-Opener-Policy cuts the popup off), it
 * asks the server to HOLD the approval instead: no token comes back to this page, and the panel claims it with the verifier only it knows.
 * An opener of another origin means another page opened this window: it is refused.
 */
export function connectPage(v: ConnectView, scriptNonceValue: string): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Connect reporter</title>
<style>body{margin:0;font:15px/1.45 system-ui,sans-serif;background:Canvas;color:CanvasText;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:360px;padding:24px 16px;overflow-wrap:anywhere}h1{font-size:20px;margin:0 0 12px}dl{margin:12px 0}dt{opacity:.7;font-size:13px}dd{margin:0 0 8px}
.mark{display:block;margin:0 0 12px}.mark .t{fill:#161616}.mark .s{stroke:#fff}@media (prefers-color-scheme:dark){.mark .t{fill:#f2f2f3}.mark .s{stroke:#111112}}
.code{font:600 15px ui-monospace,monospace;letter-spacing:.12em}
.row{display:flex;gap:12px;margin-top:16px}button,a.b{min-height:44px;min-width:44px;padding:0 18px;border-radius:12px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit;cursor:pointer;display:inline-flex;align-items:center;text-decoration:none}
button.p{background:#2563eb;border-color:#2563eb;color:#fff}#msg{min-height:1.4em;margin-top:12px}</style></head><body><main>${MARK}`;
  if (v.state === 'sign-in')
    return `${head}<h1>Sign in first</h1><p>Sign in to ClaudePilot in this window, then come back to connect the reporter.</p><div class="row"><a class="b" href="${esc(v.signInUrl)}">Sign in</a></div></main></body></html>`;
  if (v.state === 'refused') return `${head}<h1>Not available</h1><p>The reporter is not enabled for this site.</p></main></body></html>`;
  const data = `data-bucket="${esc(v.bucketKey)}" data-origin="${esc(v.origin)}" data-nonce="${esc(v.nonce)}"`;
  return `${head}<h1>Connect reporter</h1><p>Let this site's reporter file tickets in <b>${esc(v.bucketName)}</b> as you, for ${REPORTER_LIMITS.tokenHours} hours.</p>
<dl><dt>Site</dt><dd>${esc(v.origin)}</dd><dt>Environment</dt><dd>${esc(v.environment)} · ${esc(v.repo)}</dd><dt>You</dt><dd>${esc(v.person)}</dd><dt>Code (the panel shows the same)</dt><dd class="code">${esc(connectCode(v.nonce))}</dd></dl>
<div class="row"><button class="p" id="ok" ${data}>Connect</button><button id="no">Cancel</button></div><p id="msg" role="status"></p>
<script nonce="${scriptNonceValue}">
(function(){var ok=document.getElementById('ok'),no=document.getElementById('no'),msg=document.getElementById('msg');
function opener(){var o=window.opener;if(!o||o.closed)return null;try{var x=o.location.origin;return x===location.origin?o:(x&&x!=='null'?false:null);}catch(e){return e&&e.name==='SecurityError'?false:null;}}
if(opener()===false){ok.disabled=true;msg.textContent='This window was not opened by the reporter.';return;}
no.onclick=function(){window.close();};
ok.onclick=function(){var o=opener();if(o===false)return;ok.disabled=true;msg.textContent='Connecting...';
fetch(location.pathname,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({bucket:ok.dataset.bucket,origin:ok.dataset.origin,nonce:ok.dataset.nonce,hold:!o})})
.then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error((j&&j.error&&j.error.message)||'Failed');return j.data;});})
.then(function(d){if(o){o.postMessage(d,location.origin);}msg.textContent=o?'Connected. You can close this window.':'Connected. Go back to the page; you can close this window.';setTimeout(function(){window.close();},o?400:1500);})
.catch(function(e){ok.disabled=false;msg.textContent=e.message;});};})();
</script></main></body></html>`;
}
