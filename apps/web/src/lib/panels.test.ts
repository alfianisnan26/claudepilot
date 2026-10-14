import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PANELS, PANEL_GAP, placePanels, RAIL_WIDTH, workbenchPage, type PanelSpec, type Placement } from './panels';
import { SIZE_CLASSES, type SizeClass } from './size';

/** The Tickets page's two panels: the queue (list or board) grows, the open ticket keeps a readable width. */
const QUEUE: PanelSpec = { id: 'queue', min: 300, grow: 1, priority: 0 };
const DETAIL: PanelSpec = { id: 'detail', min: 380, pref: 520, priority: 1 };
const TICKETS = [QUEUE, DETAIL];

const w = (p: Placement, id: string) => p.panels.find((x) => x.id === id)!;
const shownIds = (p: Placement) => p.panels.filter((x) => x.state === 'shown').map((x) => x.id);

test('a phone shows one panel at a time, the one the person is on, over the whole width, never pinned', () => {
  const list = placePanels(TICKETS, 358, { size: 'compact', pinAlone: true });
  assert.deepEqual(shownIds(list), ['queue']);
  assert.equal(w(list, 'queue').width, 358);
  assert.equal(w(list, 'detail').state, 'hidden');
  assert.equal(list.split, false);
  assert.equal(list.pinned, false);

  const open = placePanels(TICKETS, 358, { size: 'compact', focus: 'detail', pinAlone: true });
  assert.deepEqual(shownIds(open), ['detail']);
  assert.equal(w(open, 'detail').width, 358);
  // Even with room for both (a wide window reported as compact is still a phone layout).
  assert.deepEqual(shownIds(placePanels(TICKETS, 2000, { size: 'compact', focus: 'detail' })), ['detail']);
});

test('without a focus the most important panel shows', () => {
  assert.deepEqual(shownIds(placePanels([DETAIL, QUEUE], 358, { size: 'compact' })), ['queue']);
});

test('an HD desktop (1024 px window: 720 px of room) opens the ticket beside the queue', () => {
  const p = placePanels(TICKETS, 720, { size: 'expanded', focus: 'detail' });
  assert.equal(p.split, true);
  assert.equal(p.pinned, true);
  assert.deepEqual(shownIds(p), ['queue', 'detail']);
  // Both start at their minimum (680 + the gap), the 16 px left go toward the detail's preferred width.
  assert.equal(w(p, 'queue').width, 300);
  assert.equal(w(p, 'detail').width, 396);
});

test('with room to spare the detail gets its preferred width and the queue grows into the rest', () => {
  const p = placePanels(TICKETS, 1616, { size: 'large', focus: 'detail' });
  assert.equal(w(p, 'detail').width, 520);
  assert.equal(w(p, 'queue').width, 1616 - PANEL_GAP - 520);
});

test('too little room for both: the focused panel shows alone (the phone behaviour on a narrow tablet)', () => {
  const open = placePanels(TICKETS, 640, { size: 'medium', focus: 'detail' });
  assert.deepEqual(shownIds(open), ['detail']);
  assert.equal(open.split, false);
  assert.equal(open.pinned, false);
  assert.deepEqual(shownIds(placePanels(TICKETS, 640, { size: 'medium', focus: 'queue' })), ['queue']);
});

test('a lone panel is pinned on expanded and wider only when the page asks for it', () => {
  assert.equal(placePanels([QUEUE], 1616, { size: 'large' }).pinned, false);
  assert.equal(placePanels([QUEUE], 1616, { size: 'large', pinAlone: true }).pinned, true);
  assert.equal(placePanels([QUEUE], 720, { size: 'expanded', pinAlone: true }).pinned, true);
  assert.equal(placePanels([QUEUE], 640, { size: 'medium', pinAlone: true }).pinned, false);
});

test('the size class caps how many panels stand side by side', () => {
  const three: PanelSpec[] = [
    { id: 'a', min: 100, grow: 1, priority: 0 },
    { id: 'b', min: 100, priority: 1 },
    { id: 'c', min: 100, priority: 2 },
  ];
  assert.deepEqual(shownIds(placePanels(three, 900, { size: 'medium' })), ['a', 'b']);
  assert.deepEqual(shownIds(placePanels(three, 900, { size: 'expanded' })), ['a', 'b', 'c']);
  assert.ok(MAX_PANELS.compact === 1 && MAX_PANELS.medium === 2);
});

test('a less important panel never shows while a more important one has no room', () => {
  const specs: PanelSpec[] = [
    { id: 'main', min: 300, grow: 1, priority: 0 },
    { id: 'wide', min: 800, priority: 1 },
    { id: 'small', min: 100, priority: 2 },
  ];
  const p = placePanels(specs, 1000, { size: 'large' });
  assert.deepEqual(shownIds(p), ['main']);
  assert.equal(w(p, 'small').state, 'hidden');
});

test('a panel with a rail collapses to it when it has no room, and a rail counts as a split', () => {
  const specs: PanelSpec[] = [
    { id: 'main', min: 600, grow: 1, priority: 0 },
    { id: 'context', min: 400, priority: 1, rail: true },
  ];
  const p = placePanels(specs, 800, { size: 'expanded' });
  assert.equal(w(p, 'context').state, 'rail');
  assert.equal(w(p, 'context').width, RAIL_WIDTH);
  assert.equal(w(p, 'main').width, 800 - PANEL_GAP - RAIL_WIDTH);
  assert.equal(p.split, true);
  assert.equal(p.pinned, true);
  // No room even for the rail: hidden.
  assert.equal(w(placePanels(specs, 650, { size: 'expanded' }), 'context').state, 'hidden');
});

test('growers share by their weight up to their max; what a capped one cannot take goes to the others', () => {
  const specs: PanelSpec[] = [
    { id: 'a', min: 200, grow: 1, max: 300, priority: 0 },
    { id: 'b', min: 200, grow: 1, priority: 1 },
  ];
  const p = placePanels(specs, 1024, { size: 'expanded' });
  assert.equal(w(p, 'a').width, 300);
  assert.equal(w(p, 'b').width, 1024 - PANEL_GAP - 300);
  // Every grower capped: the rest stays empty, nothing goes past a max.
  const capped = placePanels([{ ...specs[0]! }, { ...specs[1]!, max: 250 }], 1024, { size: 'expanded' });
  assert.equal(w(capped, 'a').width, 300);
  assert.equal(w(capped, 'b').width, 250);
});

test('before the first measure (no room yet) the focused panel shows alone', () => {
  const p = placePanels(TICKETS, 0, { size: 'large', focus: 'detail' });
  assert.deepEqual(shownIds(p), ['detail']);
  assert.equal(w(p, 'detail').width, 0);
});

test('no panels: an empty placement', () => {
  assert.deepEqual(placePanels([], 1000).panels, []);
});

test('placements keep their promises on random panels and widths (focus shown, mins and maxes kept, never wider than the room)', () => {
  let seed = 158;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let i = 0; i < 2000; i++) {
    const count = 1 + rnd(5);
    const specs: PanelSpec[] = Array.from({ length: count }, (_, k) => {
      const min = 80 + rnd(500);
      return {
        id: `p${k}`,
        min,
        pref: rnd(2) ? min + rnd(300) : undefined,
        max: rnd(3) === 0 ? min + 300 + rnd(400) : undefined,
        grow: rnd(2),
        priority: rnd(4),
        rail: rnd(4) === 0,
      };
    });
    const width = rnd(4000);
    const size = SIZE_CLASSES[rnd(SIZE_CLASSES.length)] as SizeClass;
    const focus = rnd(2) ? `p${rnd(count)}` : undefined;
    const p = placePanels(specs, width, { size, focus });
    const label = JSON.stringify({ specs, width, size, focus });
    assert.deepEqual(p.panels.map((x) => x.id), specs.map((s) => s.id), `page order: ${label}`);
    const open = p.panels.filter((x) => x.state !== 'hidden');
    assert.ok(open.length >= 1, `something shows: ${label}`);
    if (focus) assert.equal(p.panels.find((x) => x.id === focus)!.state, 'shown', `focus shown: ${label}`);
    assert.ok(p.panels.filter((x) => x.state === 'shown').length <= MAX_PANELS[size], `size cap: ${label}`);
    if (size === 'compact') assert.equal(open.length, 1, `one at a time on a phone: ${label}`);
    assert.equal(p.split, open.length > 1, `split: ${label}`);
    if (p.split) {
      const total = open.reduce((n, x) => n + x.width, 0) + PANEL_GAP * (open.length - 1);
      assert.ok(total <= width, `fits: ${total} > ${width}: ${label}`);
      for (const x of open) {
        const s = specs.find((y) => y.id === x.id)!;
        assert.ok(Number.isInteger(x.width), `whole px: ${label}`);
        if (x.state === 'rail') assert.equal(x.width, RAIL_WIDTH);
        else {
          assert.ok(x.width >= s.min, `min kept: ${label}`);
          if (s.max !== undefined && (s.grow ?? 0) > 0) assert.ok(x.width <= Math.max(s.max, s.pref ?? s.min), `max kept: ${label}`);
          if (!(s.grow ?? 0)) assert.ok(x.width <= Math.max(s.min, s.pref ?? s.min), `a non-grower stops at pref: ${label}`);
        }
      }
    }
  }
});

test('the Workbench pages: the tickets list and every ticket under it, nothing else', () => {
  assert.equal(workbenchPage('/admin/tickets'), '/admin/tickets');
  assert.equal(workbenchPage('/admin/tickets/T-158'), '/admin/tickets');
  assert.equal(workbenchPage('/admin/ticketsx'), null);
  assert.equal(workbenchPage('/admin/sessions'), null);
  assert.equal(workbenchPage('/admin'), null);
});
