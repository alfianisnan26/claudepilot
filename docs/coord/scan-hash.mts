// Prints the SHA-256 of the flagged span of FILE:LINE (never the span itself), for scan-allow.txt.
import { redact } from '/workspaces/claudepilot/apps/server/src/chat/redact.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
for (const a of process.argv.slice(2)) {
  const [f, n] = a.split(':'); const l = readFileSync(f, 'utf8').split('\n')[Number(n) - 1] ?? ''; const r = redact(l);
  let i = 0; while (i < l.length && i < r.length && l[i] === r[i]) i++;
  let j = 0; while (j < l.length - i && j < r.length - i && l[l.length - 1 - j] === r[r.length - 1 - j]) j++;
  console.log(`${createHash('sha256').update(l.slice(i, l.length - j)).digest('hex')} ${f.split('/').pop()}:${n}`);
}
