// RunsTab wiring guard (QA 9691 gap 1, mutant d, T-382 S5). NOT a mounted test: RunsTab needs a router, the UI kit's providers and a DOM, and
// apps/web has no DOM test library (a mounted test needs a devDependency such as react-test-renderer or jsdom: for the coordinator). The paging
// rules themselves are mounted-tested through useChatList (chat/useChatList.test.ts) and unit-tested in chat/listPaging.test.ts; this file only
// pins how RunsTab calls ListPager, so replacing `applyHead(list)` with `head = list` (or dropping the restart) goes red.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'RunsTab.tsx'), 'utf8');
const squash = (s: string) => s.replace(/\s+/g, ' ');
const code = squash(src);

test('RunsTab: a loaded first page goes through the pager seam rule, after the stale-load check', () => {
  assert.match(code, /if \(mine !== seq\.current\) return; pager\.current\.applyHead\(list\);/);
  assert.doesNotMatch(code, /pager\.current\.head\s*=/, 'never assign the head by hand: it skips the seam rule');
  assert.doesNotMatch(code, /\.items\s*=\s*list/, 'nor the items');
});

test('RunsTab: a filter change restarts the pager before it loads', () => {
  assert.match(code, /useEffect\(\(\) => \{ pager\.current\.restart\(\); void load\(\); \}, \[load\]\);/);
});

test('RunsTab: a refused cursor restarts the pager and loads page 1 again; any other failure only toasts', () => {
  assert.match(code, /if \(what === 'restart'\) \{ pager\.current\.restart\(\); void load\(\); \} else if \(what === 'retry'\) toast\(/);
});

test('RunsTab: a page that lands late is refused by finishMore', () => {
  assert.match(code, /if \(pager\.current\.finishMore\(ticket, page\)\) setTick/);
});
