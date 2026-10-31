// T-713, T-980: the ClaudePilot lane allow list (.claude/settings.json) read the way Claude Code reads a Bash rule: * spans words, a
// rule ending in :* (with no * before it) is a prefix, a command is split on && || ; | and every part must be allowed, and a deny on
// the whole command or on any part wins. The same matcher as Konfersi's scripts/check-allowlist.mjs. The rule guard
// (ruleGuard.test.ts) holds what text cannot: the folder a plain line runs in, and a tab between words.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.claude', 'settings.json');
const { permissions } = JSON.parse(readFileSync(SETTINGS, 'utf8')) as { permissions: { allow?: string[]; deny?: string[] } };
const bashRules = (list: string[] = []) =>
  list
    .map((r) => /^Bash\(([\s\S]*)\)$/.exec(r))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => m[1] ?? '');
const ALLOW = bashRules(permissions.allow);
const DENY = bashRules(permissions.deny);

function globToRegExp(pattern: string) {
  return new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s\\S]*') +
      '$',
  );
}
function ruleMatches(rule: string, cmd: string, optionalTail: boolean) {
  if (rule.endsWith(':*')) {
    const prefix = rule.slice(0, -2);
    if (prefix.includes('*')) return false;
    return cmd === prefix || cmd.startsWith(prefix + ' ');
  }
  if (globToRegExp(rule).test(cmd)) return true;
  return optionalTail && rule.endsWith(' *') && cmd === rule.slice(0, -2);
}
function splitCompound(cmd: string) {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}
function decide(command: string) {
  const parts = splitCompound(command);
  if ([command, ...parts].some((c) => DENY.some((r) => ruleMatches(r, c, true)))) return 'deny';
  return parts.length > 0 && parts.every((p) => ALLOW.some((r) => ruleMatches(r, p, false))) ? 'allow' : 'unmatched';
}

test('T-713, T-980: ClaudePilot lanes may merge origin/integration, start a branch and revert a commit; every wider form stays refused', () => {
  const ALLOWED = ['git merge --no-edit origin/integration', 'git checkout -b ticket/T-713-merge-allow', 'git revert --no-edit abc1234'];
  const REFUSED = [
    'git merge --no-edit origin/stg',
    'git merge --no-edit origin/integration-evil',
    'git merge --no-edit origin/integration origin/main',
    'git merge --no-edit origin/integration; rm -rf src',
    'git merge --no-edit origin/integration && git push --force origin HEAD',
    'git merge origin/integration',
    'git merge -X theirs origin/integration',
    'git merge --no-edit -X theirs origin/integration',
    'git merge --no-edit -s ours origin/integration',
    'git merge --no-edit -m x origin/integration',
    'git merge --no-verify --no-edit origin/integration',
    'git -C /home/node/work/claudepilot merge --no-edit origin/integration',
    'git -C /home/node/work/claudepilot.worktrees/x merge --no-edit origin/integration',
    'git checkout main',
    'git checkout ticket/T-1-x',
    'git checkout -- src/app.ts',
    'git checkout .',
    'git checkout -b x origin/main',
    'git checkout -b x -f',
    'git checkout -b -f',
    'git checkout -B x',
    'git checkout -b x; rm -rf src',
    'git revert abc1234',
    'git revert --no-edit abc1234 def5678',
    'git revert --no-edit -m 1 abc1234',
    'git revert --no-edit --abort',
    'git revert --no-edit abc1234 --no-verify',
  ];
  const misses = [
    ...ALLOWED.filter((c) => decide(c) !== 'allow').map((c) => `allowed: ${c} -> ${decide(c)}`),
    ...REFUSED.filter((c) => decide(c) === 'allow').map((c) => `refused: ${c} -> allow`),
  ];
  assert.equal(misses.join('\n'), '');
});
