// QA check: lists any invisible or control character left in the given files (BOM, zero-width, bidi, NUL and other C0 except tab/newline).
import { readFileSync } from 'node:fs';
const bad = /[\u0000-\u0008\u000b-\u001f\u007f­​-‏‪-‮⁠-⁤﻿]/u;
let hits = 0;
for (const f of process.argv.slice(2)) {
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    const m = bad.exec(line);
    if (m) { hits++; console.log(`${f}:${i + 1} U+${m[0].codePointAt(0).toString(16).padStart(4, '0')}`); }
  });
}
console.log(`invisible characters found: ${hits}`);
