// The Agents panel's command labels (ticket T-149): a short name for a background command, never the whole command line, never a credential.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandLabel, elidePath, LABEL_MAX, looksLikeCommand, looksSecret } from './commandLabel';

describe('commandLabel: real command lines from this repository’s sessions', () => {
  // [command line, label]. The first is the ticket's screenshot: ten lines of a phone before.
  const table: [string, string][] = [
    ['cd /workspaces/claudepilot/apps/server && timeout 300 node --import tsx --test src/ci/imageBuild.test.ts 2>&1 | grep -E "^# (pass|fail)"', 'node test: imageBuild.test.ts'],
    ['git push origin dev/t149-1', 'git push origin'],
    ['scripts/image-build.sh', 'scripts/image-build.sh'],
    ['scripts/image-build.sh portal 2026.10.14-4', 'scripts/image-build.sh portal'],
    ['flock /tmp/heavy.lock nice -n 10 npm run typecheck -w @portal/web', 'npm run typecheck'],
    ['cd apps/server && npm test 2>&1 | tail -30', 'npm test'],
    ['PORTAL_SERVER_CODE=00000000 /workspaces/claudepilot/tools/coordinator/ph.sh GET /api/tickets/T-149', '/workspaces/…/coordinator/ph.sh GET'],
    ['PORTAL_LOCAL_ENABLED=true scripts/scratch-portal.sh start 3451', 'scripts/scratch-portal.sh start'],
    ['node --import tsx --disable-warning=ExperimentalWarning --test src/features/chat/agentFold.test.ts src/features/chat/commandLabel.test.ts', 'node test: agentFold.test.ts +1'],
    ['SA_PORT=3451 SA_CODE=24681372 SA_CDP=9651 node tools/qa/subagents.mjs --shots /tmp/t149-shots', 'node tools/qa/subagents.mjs'],
    ["python3 -c \"import json,sys; d=json.load(open('/tmp/t.json')); print(d['data'])\"", 'python3 -c'],
    ['python3 -m http.server 8000', 'python3 -m http.server'],
    ["bash -lc 'cd /work && make build'", 'make build'],
    ['sleep 30 && curl -fsS -m 2 http://localhost:3451/healthz', 'curl localhost:3451/healthz'],
    ['sleep 30', 'sleep 30'],
    ["cat > /tmp/t149-notes.md <<'EOF'\nline one with token=abc\nline two\nEOF", 'cat > /tmp/t149-notes.md'],
    ['for f in a b c; do echo "$f"; done', 'echo $f'],
    ['kubectl -n claudepilot get pods -o wide', 'kubectl get pods'],
    ['docker compose -f deploy/compose.yaml up -d portal', 'docker compose up'],
    ['gh pr view 42 --json title', 'gh pr view'],
    ['npx tsc --noEmit -p apps/web', 'tsc apps/web'],
    ['timeout 600 npm ci', 'npm ci'],
    ['(cd apps/web && npm run build) > /tmp/build.log 2>&1', 'npm run build'],
    ['export NODE_OPTIONS=--max-old-space-size=4096; npm run build -w @portal/web', 'npm run build'],
    ['if [ -f package.json ]; then npm install; fi', 'npm install'],
    ['docker run --rm \\\n  -e FOO=1 \\\n  node:22 node -v', 'docker run node:22'],
    ['exit 3', 'exit 3'],
  ];
  for (const [cmd, want] of table) {
    it(`${cmd.split('\n')[0]!.slice(0, 70)} → ${want}`, () => assert.equal(commandLabel(cmd), want));
  }

  it('git with -C and a long path argument: the subcommand and the path, its middle elided', () => {
    assert.equal(commandLabel('git -C /workspaces/claudepilot log --oneline -5 -- apps/web/src/features/chat/AgentsPanel.tsx'), 'git log apps/…/chat/AgentsPanel.tsx');
  });

  it('is never the whole long command line, and never longer than the cap', () => {
    const long = `cd /workspaces/claudepilot && ${'node --test a.test.ts && '.repeat(20)}echo done`;
    const label = commandLabel(long);
    assert.ok(label.length <= LABEL_MAX, label);
    assert.notEqual(label, long);
    assert.equal(commandLabel(`ls ${'x'.repeat(200)}`).length <= LABEL_MAX, true);
  });

  it('an empty line has no label; a lone setup command is its own label', () => {
    assert.equal(commandLabel(''), '');
    assert.equal(commandLabel('cd /tmp'), 'cd /tmp');
  });

  it('keeps a disguising character visible', () => {
    assert.equal(commandLabel('rm evil‮txt.sh'), 'rm evil⟦U+202E⟧txt.sh');
  });
});

describe('commandLabel: nothing secret reaches a label', () => {
  // Fixtures are built at run time (no token-shaped literal in the repository).
  const pw = ['Xk9', 'pL2', 'qR7', 'vB4', 'mN8', 'zT1'].join('');
  const cases: [string, string][] = [
    [`curl -s -u admin:${pw} https://api.example.com/v1/items?page=2`, 'curl api.example.com/v1/items'],
    [`curl -H "Authorization: Bearer ${pw}${pw}" https://api.example.com/`, 'curl api.example.com'],
    [`mysql -u root -p${pw} portal`, 'mysql portal'],
    [`DB_PASSWORD=${pw} node scripts/migrate.mjs`, 'node scripts/migrate.mjs'],
    [`node scripts/seed.mjs --password ${pw}`, 'node scripts/seed.mjs'],
    [`node scripts/seed.mjs --password=${pw}`, 'node scripts/seed.mjs'],
    [`./create-user.sh ${pw}`, './create-user.sh'],
    [`git clone https://user:${pw}@github.com/o/r.git`, 'git clone'],
    [`echo token=${pw} > /tmp/x`, 'echo > /tmp/x'],
    ['node tests/login.test.mjs [redacted]', 'node tests/login.test.mjs'],
  ];
  for (const [cmd, want] of cases) {
    it(`${want}`, () => {
      const label = commandLabel(cmd);
      assert.equal(label, want);
      assert.ok(!label.includes(pw), label);
    });
  }
});

describe('the helpers', () => {
  it('elidePath keeps the head and the end of a long path', () => {
    assert.equal(elidePath('apps/web/src/a.ts'), 'apps/web/src/a.ts');
    assert.equal(elidePath('/workspaces/claudepilot/tools/coordinator/ph.sh'), '/workspaces/…/coordinator/ph.sh');
    assert.equal(elidePath(`/x/${'n'.repeat(80)}.ts`).length <= 32, true);
  });

  it('looksSecret: credentials, assignments and quoted scripts; not paths, hosts or names', () => {
    for (const s of ['admin:hunter2pass', 'a=b', 'two words', 'https://u:p@h/x', '[redacted]', ['Ab3', 'Cd4', 'Ef5', 'Gh6', 'Ij7', 'Kl8'].join('')]) assert.equal(looksSecret(s), true, s);
    for (const s of ['localhost:3451', 'src/features/chat/agentFold.test.ts', 'origin', 'imageBuild.test.ts', 'dev/t149-1', 'node:22']) assert.equal(looksSecret(s), false, s);
  });

  it('looksLikeCommand tells a command line from a description', () => {
    for (const c of ['cd x && make', 'npm test | tail', 'FOO=1 node a', 'git push --force-with-lease', './run.sh', 'cat <<EOF\nx\nEOF']) assert.equal(looksLikeCommand(c), true, c);
    for (const d of ['Run the unit tests', 'QA sleeper', 'Build & push the image', 'sleep 30']) assert.equal(looksLikeCommand(d), false, d);
  });
});
