// The annotation editor's model (PILOT-1111, owner 2026-10-31): marks, history, hit test, move and resize, simplification, the blur that
// changes real pixels, the flatten at the screenshot's own size, and what a shot uploads (with a blur: never the original).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPORTER_LIMITS, type ReporterAnnotation } from '@portal/contracts';
import {
  addMark,
  canAnnotate,
  canRedo,
  canUndo,
  clearAll,
  editorSource,
  emptyDoc,
  handles,
  hitTest,
  isMeaningful,
  moveMark,
  nextStep,
  pixelate,
  redo,
  removeMark,
  renderFlat,
  replaceMark,
  resizeMark,
  simplify,
  toWire,
  toolForKey,
  undo,
  unitOf,
  uploadPlan,
  widthFor,
  withAnnotations,
  type FlatCanvas,
  type Mark,
} from './annotate';

const RED = '#ef233c' as const;
const pen = (id = 'a'): Mark => ({ id, type: 'pen', points: [0, 0, 10, 10, 20, 0], color: RED, width: 4 });
const rectOf = (m: Mark) => (m as Mark & { rect: { x: number; y: number; w: number; h: number } }).rect;
const ptsOf = (m: Mark) => (m as Mark & { points: number[] }).points;
const rect = (id = 'r'): Mark => ({ id, type: 'rect', rect: { x: 10, y: 10, w: 100, h: 50 }, color: RED, width: 4 });

test('history: add, move, undo, redo; a new change drops the redo branch; clear all is one undoable step', () => {
  let d = emptyDoc();
  d = addMark(d, pen());
  d = addMark(d, rect());
  assert.equal(d.marks.length, 2);
  d = replaceMark(d, moveMark(d.marks[1]!, 5, -5));
  assert.deepEqual(rectOf(d.marks[1]!), { x: 15, y: 5, w: 100, h: 50 });
  d = undo(d);
  assert.deepEqual(rectOf(d.marks[1]!), { x: 10, y: 10, w: 100, h: 50 });
  assert.ok(canRedo(d));
  d = redo(d);
  assert.equal(rectOf(d.marks[1]!).x, 15);
  d = undo(d);
  d = removeMark(d, 'a');
  assert.equal(canRedo(d), false, 'a change after undo drops redo');
  d = clearAll(d);
  assert.equal(d.marks.length, 0);
  d = undo(d);
  assert.equal(d.marks.length, 1);
  assert.equal(undo(emptyDoc()).marks.length, 0);
  assert.equal(canUndo(emptyDoc()), false);
});

test('marks are capped at the server limit', () => {
  let d = emptyDoc();
  for (let i = 0; i < REPORTER_LIMITS.annotations + 5; i++) d = addMark(d, pen(String(i)));
  assert.equal(d.marks.length, REPORTER_LIMITS.annotations);
});

test('hit test finds the topmost mark, near strokes and inside boxes; handles resize boxes, lines and strokes', () => {
  const marks = [rect(), pen()];
  assert.equal(hitTest(marks, { x: 10, y: 11 }, 2)?.id, 'a', 'the stroke on top');
  assert.equal(hitTest(marks, { x: 60, y: 30 }, 2)?.id, 'r');
  assert.equal(hitTest(marks, { x: 500, y: 500 }, 2), null);
  const r = rect();
  assert.equal(handles(r).length, 4);
  const bigger = resizeMark(r, 2, { x: 210, y: 110 });
  assert.deepEqual(rectOf(bigger), { x: 10, y: 10, w: 200, h: 100 });
  const flipped = resizeMark(r, 2, { x: 0, y: 0 });
  assert.deepEqual(rectOf(flipped), { x: 0, y: 0, w: 10, h: 10 }, 'dragged past the corner: still a positive box');
  const line: Mark = { id: 'l', type: 'arrow', points: [0, 0, 10, 0], color: RED, width: 3 };
  assert.deepEqual(ptsOf(resizeMark(line, 1, { x: 50, y: 5 })), [0, 0, 50, 5]);
  const s = resizeMark(pen(), 2, { x: 40, y: 20 });
  assert.deepEqual(ptsOf(s), [0, 0, 20, 20, 40, 0], 'a stroke scales with its box');
  assert.equal(handles({ id: 't', type: 'text', points: [0, 0], color: RED, width: 20, text: 'x' }).length, 0);
});

test('a tap with a box tool makes nothing; steps count up; tools have their keys', () => {
  assert.equal(isMeaningful({ id: 'x', type: 'rect', rect: { x: 0, y: 0, w: 1, h: 1 }, color: RED, width: 2 }, 1), false);
  assert.equal(isMeaningful(rect(), 1), true);
  assert.equal(nextStep([pen(), { id: 's', type: 'step', points: [1, 1], color: RED, width: 10, n: 3 }]), 4);
  assert.equal(nextStep([]), 1);
  assert.equal(toolForKey('B'), 'blur');
  assert.equal(toolForKey('v'), 'select');
  assert.equal(toolForKey('q'), null);
  assert.ok(widthFor('pen', 'l', unitOf({ w: 1170, h: 2532 })) > widthFor('pen', 's', unitOf({ w: 1170, h: 2532 })));
  assert.ok(widthFor('pen', 'm', unitOf({ w: 1170, h: 2532 })) > widthFor('pen', 'm', unitOf({ w: 390, h: 844 })), 'thicker on a 3x shot');
});

test('simplify keeps the ends and the shape, drops points on a straight run, and stays under the wire cap', () => {
  const straight = Array.from({ length: 100 }, (_, i) => [i, i * 2]).flat();
  assert.deepEqual(simplify(straight, 0.5), [0, 0, 99, 198]);
  const corner = [0, 0, 5, 0, 10, 0, 10, 5, 10, 10];
  assert.deepEqual(simplify(corner, 0.5), [0, 0, 10, 0, 10, 10]);
  const zigzag = Array.from({ length: 5000 }, (_, i) => [i, i % 2 ? 50 : 0]).flat();
  const s = simplify(zigzag, 0.5);
  assert.ok(s.length <= REPORTER_LIMITS.annotationPoints && s.length % 2 === 0);
  assert.deepEqual(s.slice(-2), [4999, 50]);
});

test('toWire drops ids and rounds to one decimal', () => {
  const w = toWire([{ id: 'x', type: 'line', points: [0.123, 1.26, 2, 3], color: RED, width: 2 }]);
  assert.deepEqual(w, [{ type: 'line', points: [0.1, 1.3, 2, 3], color: RED, width: 2 }]);
});

test('pixelate changes the real pixels inside the area and nothing outside', () => {
  const w = 40;
  const h = 20;
  const data = new Uint8ClampedArray(w * h * 4);
  // A checkerboard: every pixel differs from its neighbour.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * w + x) * 4);
  const before = data.slice();
  pixelate(data, w, h, { x: 0, y: 0, w: 20, h: 20 }, 10);
  const at = (x: number, y: number) => [...data.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];
  assert.deepEqual(at(0, 0), at(1, 0), 'one block is one colour');
  assert.deepEqual(at(0, 0).slice(0, 3), [128, 128, 128], 'the average');
  let changed = 0;
  for (let i = 0; i < 20 * 4; i++) if (data[i] !== before[i]) changed++;
  assert.ok(changed > 0);
  for (let y = 0; y < h; y++) for (let x = 20; x < w; x++) assert.deepEqual(at(x, y), [...before.slice((y * w + x) * 4, (y * w + x) * 4 + 4)], 'outside untouched');
});

/** A canvas with real pixel storage for getImageData / putImageData, and a log of drawing calls. */
function fakeCanvas() {
  const calls: string[] = [];
  let pixels = new Uint8ClampedArray(0);
  const c = {
    width: 0,
    height: 0,
    calls,
    pixels: () => pixels,
    getContext: () => {
      const ctx: Record<string, unknown> = {
        drawImage: (_i: unknown, _x: number, _y: number, w: number, h: number) => {
          calls.push(`drawImage ${w}x${h}`);
          pixels = new Uint8ClampedArray(c.width * c.height * 4);
          for (let i = 0; i < pixels.length; i += 4) pixels.set(((i / 4) % 2 ? [250, 10, 10, 255] : [10, 10, 250, 255]), i);
        },
        getImageData: (x: number, y: number, w: number, h: number) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let r = 0; r < h; r++) data.set(pixels.slice(((y + r) * c.width + x) * 4, ((y + r) * c.width + x + w) * 4), r * w * 4);
          return { data, width: w, height: h };
        },
        putImageData: (img: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number) => {
          calls.push('putImageData');
          for (let r = 0; r < img.height; r++) pixels.set(img.data.slice(r * img.width * 4, (r + 1) * img.width * 4), ((y + r) * c.width + x) * 4);
        },
        measureText: (s: string) => ({ width: s.length * 8 }),
      };
      return new Proxy(ctx, {
        get: (t, k: string) => (k in t ? t[k] : typeof k === 'string' && /^[a-z]/.test(k) && !['strokeStyle', 'fillStyle', 'lineWidth', 'lineCap', 'lineJoin', 'globalAlpha', 'font', 'textBaseline', 'textAlign'].includes(k) ? () => calls.push(k) : undefined),
        set: (t, k: string, v) => ((t[k] = v), true),
      });
    },
  };
  return c;
}

test('flatten: the canvas is the screenshot size, blur pixels change, every other mark is drawn on top', () => {
  const c = fakeCanvas();
  const size = { w: 64, h: 32 };
  const before = (() => {
    const f = fakeCanvas();
    renderFlat(f as unknown as FlatCanvas, {} as CanvasImageSource, size, []);
    return f.pixels().slice();
  })();
  const marks: ReporterAnnotation[] = [
    { type: 'blur', rect: { x: 0, y: 0, w: 32, h: 32 } },
    { type: 'arrow', points: [1, 1, 30, 30], color: RED, width: 3 },
    { type: 'text', points: [40, 2], color: RED, width: 12, text: 'Here' },
    { type: 'step', points: [50, 20], color: RED, width: 8, n: 1 },
  ];
  renderFlat(c as unknown as FlatCanvas, {} as CanvasImageSource, size, marks);
  assert.equal(c.width, 64);
  assert.equal(c.height, 32);
  assert.equal(c.calls[0], 'drawImage 64x32');
  assert.ok(c.calls.includes('putImageData'), 'the blur wrote pixels back');
  const px = c.pixels();
  let changedIn = 0;
  let changedOut = 0;
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      const diff = px[i] !== before[i] || px[i + 2] !== before[i + 2];
      if (diff && x < 32) changedIn++;
      if (diff && x >= 32) changedOut++;
    }
  assert.ok(changedIn > 900, `most pixels under the blur changed (${changedIn})`);
  assert.equal(changedOut, 0, 'pixels outside the blur stay');
  assert.ok(c.calls.includes('fillText') && c.calls.includes('arc') && c.calls.includes('fill'), 'text, step and arrow head drawn');
  assert.equal(canAnnotate({ w: 1170, h: 20000 }), false, 'over the canvas area browsers allow');
  assert.equal(canAnnotate({ w: 1170, h: 2532 }), true);
});

test('a shot after Done: without blur both images go, with blur only the flattened one (as the screenshot); no marks restores it', () => {
  const orig = new Blob(['o'], { type: 'image/png' });
  const flat = new Blob(['f'], { type: 'image/png' });
  const shot: { screenshot: Blob; previewUrl: string; annotations?: ReporterAnnotation[]; annotated?: Blob; original?: { blob: Blob; url: string } } = { screenshot: orig, previewUrl: 'blob:orig' };
  let n = 0;
  const url = () => `blob:new${++n}`;
  const marked = withAnnotations(shot, [{ type: 'pen', points: [0, 0], color: RED, width: 2 }], flat, url);
  assert.equal(marked.next.screenshot, orig);
  assert.equal(marked.next.annotated, flat);
  assert.equal(marked.next.previewUrl, 'blob:new1');
  assert.deepEqual(marked.revoke, []);
  assert.deepEqual(uploadPlan(marked.next).map((p) => [p.kind, p.blob]), [['screenshot', orig], ['annotated', flat]]);
  assert.deepEqual(editorSource(marked.next), { url: 'blob:orig', marks: marked.next.annotations });

  const flat2 = new Blob(['b'], { type: 'image/png' });
  const blurred = withAnnotations(marked.next, [{ type: 'blur', rect: { x: 0, y: 0, w: 10, h: 10 } }], flat2, url);
  assert.equal(blurred.next.screenshot, flat2, 'the blurred image IS the screenshot');
  assert.equal(blurred.next.annotated, undefined);
  assert.deepEqual(blurred.revoke, ['blob:new1']);
  const plan = uploadPlan(blurred.next);
  assert.deepEqual(plan.map((p) => [p.kind, p.blob]), [['screenshot', flat2]], 'the original never goes');
  assert.ok(!plan.some((p) => p.blob === orig));
  assert.equal(editorSource(blurred.next).url, 'blob:orig', 'the original stays in the panel to edit again');

  const cleared = withAnnotations(blurred.next, [], null, url);
  assert.equal(cleared.next.screenshot, orig);
  assert.equal(cleared.next.previewUrl, 'blob:orig');
  assert.equal('annotations' in cleared.next, false);
  assert.equal('original' in cleared.next, false);
  assert.deepEqual(uploadPlan(cleared.next).length, 1);
});
