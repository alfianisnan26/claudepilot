import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** The hash source of every inline script in a page (the theme script that runs before first paint). */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(m[1] ?? '') || !m[2]?.trim()) continue;
    hashes.push(`'sha256-${createHash('sha256').update(m[2]).digest('base64')}'`);
  }
  return hashes;
}

/**
 * The Content-Security-Policy of the built app: only its own scripts (plus the page's inline theme script, by
 * hash), nothing from other origins except this host's sockets, no plugins, no framing by others. It is a second
 * wall behind React's escaping and the Markdown renderer's rules, so an XSS that slips through can't load code or
 * send data elsewhere. Styles may be inline (React sets style attributes; the terminal injects its own).
 * A feature that needs another origin (an iframe, remote images) has to say so here.
 */
export function contentSecurityPolicy(indexHtmlPath: string): Record<string, string[]> | undefined {
  if (!existsSync(indexHtmlPath)) return undefined;
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", ...inlineScriptHashes(readFileSync(indexHtmlPath, 'utf8'))],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'", 'ws:', 'wss:'],
    workerSrc: ["'self'"],
    manifestSrc: ["'self'"],
    frameSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'self'"],
  };
}
