// Guards of the UI standard (docs/coord/UI-STANDARD.md; owner, 2026-11-01: "UI/UX should be consistent, standardized"). A page draws tabs,
// dialogs and page scrolling through the shared components only. The files that still hand-roll one are listed below by name: the list
// may only shrink (migrate a file, then delete its line); a new file that hand-rolls one fails here.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
// The portal and the reporter panel (embed/). Another entry of its own (the Admin console) is guarded by its own test, which also forbids
// the portal to name it.
const entries = readdirSync(src, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'embed').map((d) => d.name).filter((d) => readdirSync(join(src, d)).includes('main.tsx'));
const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => f.split('\\').join('/'))
  .filter((f) => !entries.some((d) => f.startsWith(`${d}/`)))
  .sort();
const read = (f: string) => readFileSync(join(src, f), 'utf8');
const hits = (re: RegExp) => files.filter((f) => re.test(read(f)));

test('tab bars: only the shared TabBar draws a tablist (and the kit’s PageTabs is not used)', () => {
  // Not yet migrated (docs/coord/UI-STANDARD.md §9): the reporter panel's own tabs, its evidence tabs, the browser app view's tabs.
  const legacy = ['embed/Panel.tsx', 'features/reporter/Evidence.tsx', 'features/browser/AppView.tsx'];
  assert.deepEqual(hits(/role="tablist"/).filter((f) => !legacy.includes(f)), ['components/TabBar.tsx']);
  assert.deepEqual(hits(/import \{[^}]*\bPageTabs\b[^}]*\} from '@isnanme\/ui'/), [], 'use RoutedTabs (a portal page) or TabBar');
});

test('dialogs: a page uses the kit’s Dialog, Sheet or ConfirmDialog, not a hand-rolled role="dialog"', () => {
  // Popovers and panels that are dialogs by role (menus with text, the switcher, viewers) and the reporter panel's sheets, not yet migrated.
  const allowed = [
    'components/AccountMenu.tsx',
    'components/Popover.tsx',
    'embed/Annotator.tsx',
    'embed/ContextSheet.tsx',
    'embed/RuntimeSheet.tsx',
    'embed/TicketsTab.tsx',
    'embed/Viewer.tsx',
    'features/chat/AgentsPanel.tsx',
    'features/chat/FilesPanel.tsx',
    'features/chat/ImageViewer.tsx',
    'features/chat/TrustSheet.tsx',
    'features/chat/artifacts/FileViewer.tsx',
    'features/glance/Popover.tsx',
    'features/glance/widgets/shortcuts/Palette.tsx',
    'features/orgs/ContextSwitcher.tsx',
    // Reads dialogs (the sheet-drag guard finds them by role), draws none.
    'lib/sheetDrag.ts',
  ];
  assert.deepEqual(hits(/role="dialog"/).filter((f) => !allowed.includes(f)), []);
});

test('page scrolling: only lib/pane.ts scrolls the page, and only the app frames make a page-level scroll container', () => {
  assert.deepEqual(hits(/window\.scrollTo\(/), ['lib/pane.ts'], 'use scrollPageTo / pageScrollTop (lib/pane.ts)');
  // A <main> that scrolls itself, or a whole-height box that scrolls, is a second page frame: the content pane is AppShell's (and the console's).
  assert.deepEqual(hits(/<main[^>]*overflow-y-(auto|scroll)/).filter((f) => f !== 'embed/Panel.tsx'), []);
  assert.deepEqual(
    // The reporter panel (embed/) is a whole window of its own inside an iframe: its frame scrolls its body.
    hits(/h-dvh[^'"`]*overflow-y-(auto|scroll)|overflow-y-(auto|scroll)[^'"`]*h-dvh/).filter((f) => f !== 'embed/Panel.tsx'),
    [],
    'a page does not scroll itself: the content pane does (docs/coord/UI-STANDARD.md §1)',
  );
});

test('the frame: the portal scrolls one content pane on a desktop (the console checks its own frame in its own test)', () => {
  assert.match(read('components/AppShell.tsx'), /id=\{PANE_ID\}[^>]*lg:overflow-y-auto/);
  assert.match(read('components/AppShell.tsx'), /lg:h-dvh[^'"]*lg:overflow-hidden/);
});
