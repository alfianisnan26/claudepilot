// The Chat view's page, as a string: pure, so the tests check its CSP. No data from the portal is ever part of it.

import { VSCODE_SEND_MAX } from '../../../packages/contracts/src/vscode.js';

/** 128 random bits, base64: the script's nonce, new for every page. */
export function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}

/** The page's HTML: no data from the portal in it at all (that arrives by postMessage and is set as text). */
export function chatHtml(o: { cspSource: string; nonce: string; script: string; style: string }): string {
  const csp = [`default-src 'none'`, `style-src ${o.cspSource}`, `img-src ${o.cspSource}`, `font-src ${o.cspSource}`, `script-src 'nonce-${o.nonce}'`, `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${o.style}">
<title>Chat</title>
</head>
<body>
<header id="head"><span id="title">No agent</span><span id="state"></span></header>
<main id="log" aria-live="polite"></main>
<form id="form">
<textarea id="text" rows="3" maxlength="${VSCODE_SEND_MAX}" placeholder="Message" aria-label="Message" disabled></textarea>
<button id="send" type="submit" disabled>Send</button>
</form>
<script nonce="${o.nonce}" src="${o.script}"></script>
</body>
</html>`;
}
