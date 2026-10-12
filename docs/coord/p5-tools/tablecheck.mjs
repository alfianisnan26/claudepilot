import { readFileSync } from 'node:fs';
let bad = 0;
for (const f of process.argv.slice(2)) {
  const lines = readFileSync(f, 'utf8').split('\n');
  let cols = null; let inCode = false;
  lines.forEach((line, i) => {
    if (line.startsWith('```')) { inCode = !inCode; cols = null; return; }
    if (inCode) return;
    if (!line.startsWith('|')) { cols = null; return; }
    // count cells: split on unescaped pipes, ignoring pipes inside backticks
    let n = 0, tick = false;
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      // GFM: a pipe inside a code span still splits a table cell unless escaped
      if (c === '\\') { k++; continue; }
      if (c === '|' && !tick) n++;
    }
    if (cols === null) cols = n;
    else if (n !== cols) { bad++; console.log(`${f}:${i + 1}: ${n} pipes, header has ${cols}: ${line.slice(0, 90)}`); }
  });
}
console.log(bad ? `${bad} table problems` : 'tables ok');
