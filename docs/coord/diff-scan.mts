// Scans the added lines of a diff for token-shaped content with the portal's own redaction patterns.
// Usage: git diff --cached -U0 | npx tsx diff-scan.mts   (from /workspaces/claudepilot/apps/server). Prints file:line and the
// length of the match ONLY, never the value; exit code 1 when anything is found.
import { redact } from '/workspaces/claudepilot/apps/server/src/chat/redact.ts';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
// Spans (by SHA-256) the owner accepted as public, non-secret values (protocol test vectors): scan-allow.txt next to this file.
const ALLOW = new Set<string>();
const allowPath = new URL('./scan-allow.txt', import.meta.url).pathname;
if (existsSync(allowPath)) for (const l of readFileSync(allowPath, 'utf8').split('\n')) { const h = l.trim().split(/\s+/)[0]; if (/^[0-9a-f]{64}$/.test(h)) ALLOW.add(h); }
export const spanOf = (l: string, r: string): string => {
  let a = 0; while (a < l.length && a < r.length && l[a] === r[a]) a++;
  let b = 0; while (b < l.length - a && b < r.length - a && l[l.length - 1 - b] === r[r.length - 1 - b]) b++;
  return l.slice(a, l.length - b);
};
const allowed = (text: string): boolean => ALLOW.has(createHash('sha256').update(spanOf(text, redact(text))).digest('hex'));
let file = '';
let line = 0;
let found = 0;
const rl = createInterface({ input: process.stdin });
rl.on('line', (l) => {
  if (l.startsWith('+++ b/')) file = l.slice(6);
  else if (l.startsWith('@@')) {
    const m = /\+(\d+)/.exec(l);
    line = m ? Number(m[1]) - 1 : 0;
  } else if (l.startsWith('+') && !l.startsWith('+++')) {
    line++;
    const text = l.slice(1);
    if (redact(text) !== text && !allowed(text)) {
      found++;
      console.log(`SECRET-SHAPED: ${file}:${line} (${text.length} chars)`);
    }
  } else if (!l.startsWith('-')) line++;
});
rl.on('close', () => {
  console.log(found ? `scan: ${found} finding(s)` : 'scan: clean');
  process.exit(found ? 1 : 0);
});
