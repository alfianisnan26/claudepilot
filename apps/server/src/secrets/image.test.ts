import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HOOKS } from '../delivery/hooks.js';

const DOCKERFILE = new URL('../../../../images/workspace/Dockerfile', import.meta.url);

/** The Dockerfile's `RUN` instructions, continuation lines joined. */
function runs(dockerfile: string): string[] {
  return dockerfile
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((l) => l.startsWith('RUN '))
    .map((l) => l.slice(4));
}

test('A3: the image bakes the same shell hooks the portal writes into older workspaces (profile.d file, bash.bashrc line)', () => {
  const { files, lines } = HOOKS.shell;
  const paths = [...files.map((f) => f.path), ...lines.map((l) => l.path)];
  const run = runs(readFileSync(DOCKERFILE, 'utf8')).find((r) => paths.every((p) => r.includes(p)));
  assert.ok(run, 'one RUN in images/workspace/Dockerfile writes every shell hook');

  // Run it against stand-ins for the image's files: what lands must be byte for byte what hooks.ts delivers.
  const dir = mkdtempSync(join(tmpdir(), 'cp-hooks-'));
  try {
    const stand = new Map(paths.map((p, i) => [p, join(dir, `f${i}`)]));
    const bashrc = '# the base image’s own bash.bashrc\n';
    for (const l of lines) writeFileSync(stand.get(l.path)!, bashrc);
    let script = run;
    for (const [p, s] of stand) script = script.split(p).join(s);
    execFileSync('sh', ['-c', script]);
    for (const f of files) assert.equal(readFileSync(stand.get(f.path)!, 'utf8'), f.content, f.path);
    // Appended once, exactly as the portal appends it, so its `grep -qxF` finds it and adds no second copy.
    for (const l of lines) assert.equal(readFileSync(stand.get(l.path)!, 'utf8'), `${bashrc}${l.line}\n`, l.path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
