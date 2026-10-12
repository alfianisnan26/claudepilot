// Shows the flagged lines of the given files with the secret-shaped parts replaced by the portal's own redaction, plus the first 5 chars and the length of the matched span (never the value).
import { redact } from '/workspaces/claudepilot/apps/server/src/chat/redact.ts';
import { readFileSync } from 'node:fs';
for (const f of process.argv.slice(2)) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    const r = redact(l);
    if (r === l) return;
    let a = 0;
    while (a < l.length && a < r.length && l[a] === r[a]) a++;
    let b = 0;
    while (b < l.length - a && b < r.length - a && l[l.length - 1 - b] === r[r.length - 1 - b]) b++;
    const span = l.slice(a, l.length - b);
    console.log(`${f.replace('apps/server/src/', '')}:${i + 1} [span ${span.length}c starts "${span.slice(0, 5)}"] ${r.trim().slice(0, 130)}`);
  });
}
