// Scans the added lines of a diff for token-shaped content with the portal's own redaction patterns.
// Usage: git diff --cached -U0 | npx tsx diff-scan.mts   (from /workspaces/claudepilot/apps/server). Prints file:line and the
// length of the match ONLY, never the value; exit code 1 when anything is found.
import { redact } from '/workspaces/claudepilot/apps/server/src/chat/redact.ts';
import { createInterface } from 'node:readline';
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
    if (redact(text) !== text) {
      found++;
      console.log(`SECRET-SHAPED: ${file}:${line} (${text.length} chars)`);
    }
  } else if (!l.startsWith('-')) line++;
});
rl.on('close', () => {
  console.log(found ? `scan: ${found} finding(s)` : 'scan: clean');
  process.exit(found ? 1 : 0);
});
