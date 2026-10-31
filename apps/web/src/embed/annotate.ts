import { REPORTER_ANNOTATION_COLORS, REPORTER_LIMITS, type ReporterAnnotation, type ReporterAnnotationColor } from '@portal/contracts';

/*
 * The annotation editor's model (PILOT-1111, owner 2026-10-31): marks as vector data in the SCREENSHOT's pixel coordinates, an undo/redo
 * history of immutable snapshots, hit testing, move and resize, pen simplification, drawing onto any 2D context, the pixelation that a blur
 * applies to the real pixels, and the flatten to a PNG of the screenshot's own size. No DOM here beyond the 2D context it is handed: tested
 * directly with a fake context.
 */

export type Tool = 'select' | 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'highlight' | 'blur' | 'step';
export type SizeClass = 's' | 'm' | 'l';
export type Mark = ReporterAnnotation & { id: string };
type Rect = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };

export const COLORS = REPORTER_ANNOTATION_COLORS;
export const DEFAULT_COLOR: ReporterAnnotationColor = COLORS[0];

/** The keyboard shortcut of each tool (and the order of the tool row). */
export const TOOLS: { tool: Tool; key: string; label: string }[] = [
  { tool: 'select', key: 'v', label: 'Select' },
  { tool: 'pen', key: 'p', label: 'Pen' },
  { tool: 'arrow', key: 'a', label: 'Arrow' },
  { tool: 'rect', key: 'r', label: 'Rectangle' },
  { tool: 'ellipse', key: 'o', label: 'Ellipse' },
  { tool: 'line', key: 'l', label: 'Line' },
  { tool: 'text', key: 't', label: 'Text' },
  { tool: 'highlight', key: 'h', label: 'Highlight' },
  { tool: 'blur', key: 'b', label: 'Blur' },
  { tool: 'step', key: 'n', label: 'Number' },
];
export const toolForKey = (key: string): Tool | null => TOOLS.find((t) => t.key === key.toLowerCase())?.tool ?? null;

/**
 * What a pointer-down does while a text box is open: with the Text tool it only ends the text (a tap elsewhere finishes it, it does not
 * start another); with any other tool it ends the text AND starts that tool's mark, so the first drag after Text is never swallowed.
 */
export const downWhileTyping = (tool: Tool): 'finish' | 'finish-and-draw' => (tool === 'text' ? 'finish' : 'finish-and-draw');

/** One unit of thickness for an image: about 1/420 of its long side, so marks look the same on a 1x and a 3x screenshot. */
export const unitOf = (img: { w: number; h: number }) => Math.max(1, Math.max(img.w, img.h) / 420);
const SIZE: Record<SizeClass, number> = { s: 1.5, m: 3, l: 6 };
const FONT: Record<SizeClass, number> = { s: 9, m: 12, l: 18 };
/** Stroke width (or font size for text, radius for a step) of a size class, in image pixels. */
export function widthFor(tool: Tool, size: SizeClass, unit: number): number {
  if (tool === 'text') return Math.round(FONT[size] * unit);
  if (tool === 'step') return Math.round((size === 's' ? 7 : size === 'm' ? 9 : 13) * unit);
  if (tool === 'highlight') return Math.round(SIZE[size] * unit * 4);
  return Math.max(1, Math.round(SIZE[size] * unit * 10) / 10);
}

/* ---------- History ---------- */

export interface Doc {
  marks: Mark[];
  past: Mark[][];
  future: Mark[][];
}
const HISTORY = 100;
export const emptyDoc = (marks: Mark[] = []): Doc => ({ marks, past: [], future: [] });
export const commit = (d: Doc, marks: Mark[]): Doc => ({ marks, past: [...d.past, d.marks].slice(-HISTORY), future: [] });
export const addMark = (d: Doc, m: Mark): Doc => (d.marks.length >= REPORTER_LIMITS.annotations ? d : commit(d, [...d.marks, m]));
export const replaceMark = (d: Doc, m: Mark): Doc => commit(d, d.marks.map((x) => (x.id === m.id ? m : x)));
export const removeMark = (d: Doc, id: string): Doc => (d.marks.some((x) => x.id === id) ? commit(d, d.marks.filter((x) => x.id !== id)) : d);
export const clearAll = (d: Doc): Doc => (d.marks.length ? commit(d, []) : d);
export const canUndo = (d: Doc) => d.past.length > 0;
export const canRedo = (d: Doc) => d.future.length > 0;
export const undo = (d: Doc): Doc => (d.past.length ? { marks: d.past.at(-1)!, past: d.past.slice(0, -1), future: [d.marks, ...d.future] } : d);
export const redo = (d: Doc): Doc => (d.future.length ? { marks: d.future[0]!, past: [...d.past, d.marks], future: d.future.slice(1) } : d);
export const nextStep = (marks: readonly Mark[]) => marks.reduce((n, m) => (m.type === 'step' ? Math.max(n, m.n) : n), 0) + 1;

/** The marks as the wire carries them (no ids, numbers rounded to one decimal). */
export function toWire(marks: readonly Mark[]): ReporterAnnotation[] {
  const r = (v: number) => Math.round(v * 10) / 10;
  return marks.map(({ id: _id, ...m }) => {
    if ('points' in m) return { ...m, points: m.points.map(r) } as ReporterAnnotation;
    if ('rect' in m) return { ...m, rect: { x: r(m.rect.x), y: r(m.rect.y), w: r(m.rect.w), h: r(m.rect.h) } } as ReporterAnnotation;
    return m as ReporterAnnotation;
  });
}
export const fromWire = (marks: readonly ReporterAnnotation[] | undefined, id: () => string): Mark[] => (marks ?? []).map((m) => ({ ...m, id: id() }) as Mark);
export const hasBlur = (marks: readonly { type: string }[] | undefined) => !!marks?.some((m) => m.type === 'blur');

/* ---------- Geometry ---------- */

/**
 * A pointer's position in the SCREENSHOT's pixels, from where the image is drawn right now: `box` is the image element's
 * getBoundingClientRect() read at this very event (it already holds the stage's place after any layout shift, the zoom and pan transform
 * and any scroll), `size` the image's own pixels. Client coordinates and the rect are both CSS pixels, so the device pixel ratio cancels
 * out. Never a cached rect or a remembered view: the editor once mapped through a stale one and a blur landed off its drag (2026.10.31-6).
 */
export function clientToImage(client: Pt, box: { left: number; top: number; width: number; height: number }, size: { w: number; h: number }): Pt {
  if (!(box.width > 0) || !(box.height > 0)) return { x: 0, y: 0 };
  return { x: ((client.x - box.left) * size.w) / box.width, y: ((client.y - box.top) * size.h) / box.height };
}

/** Screen pixels per image pixel of the image as drawn now (for touch slop and handle reach). */
export const drawnScale = (box: { width: number }, size: { w: number }) => (size.w > 0 && box.width > 0 ? box.width / size.w : 1);

export const normRect = (a: Pt, b: Pt): Rect =>({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

/** Ramer-Douglas-Peucker on a flat x,y list: a pen stroke keeps its shape with far fewer points (and stays under the server's cap). */
export function simplify(points: number[], tolerance: number): number[] {
  const n = points.length / 2;
  if (n <= 2) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const t2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(points[i * 2]!, points[i * 2 + 1]!, points[a * 2]!, points[a * 2 + 1]!, points[b * 2]!, points[b * 2 + 1]!);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > t2 && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i * 2]!, points[i * 2 + 1]!);
  // Still too long for the wire (a very long scribble): thin it evenly.
  const max = REPORTER_LIMITS.annotationPoints;
  if (out.length <= max) return out;
  const step = Math.ceil(out.length / 2 / (max / 2 - 1));
  const thin: number[] = [];
  for (let i = 0; i < out.length / 2; i += step) thin.push(out[i * 2]!, out[i * 2 + 1]!);
  thin.push(out.at(-2)!, out.at(-1)!);
  return thin;
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  const x = ax + t * dx - px;
  const y = ay + t * dy - py;
  return x * x + y * y;
}

/** A text mark's box: measured when a context is given, else estimated (0.6 em per character). */
export function textBox(m: Extract<Mark, { type: 'text' }>, measure?: (s: string, size: number) => number): Rect {
  const lines = m.text.split('\n');
  const w = Math.max(...lines.map((l) => (measure ? measure(l, m.width) : l.length * m.width * 0.6)), m.width);
  return { x: m.points[0]!, y: m.points[1]!, w, h: lines.length * m.width * 1.25 };
}

export function bounds(m: Mark, measure?: (s: string, size: number) => number): Rect {
  if ('rect' in m) return m.rect;
  if (m.type === 'text') return textBox(m, measure);
  if (m.type === 'step') return { x: m.points[0]! - m.width, y: m.points[1]! - m.width, w: m.width * 2, h: m.width * 2 };
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (let i = 0; i < m.points.length; i += 2) {
    x1 = Math.min(x1, m.points[i]!);
    x2 = Math.max(x2, m.points[i]!);
    y1 = Math.min(y1, m.points[i + 1]!);
    y2 = Math.max(y2, m.points[i + 1]!);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** The topmost mark under a point (`slop` in image pixels: a finger is wide), or null. */
export function hitTest(marks: readonly Mark[], p: Pt, slop: number, measure?: (s: string, size: number) => number): Mark | null {
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i]!;
    if (m.type === 'pen' || m.type === 'highlight' || m.type === 'line' || m.type === 'arrow') {
      const tol = (m.width / 2 + slop) ** 2;
      const pts = m.points;
      if (pts.length === 2 && (pts[0]! - p.x) ** 2 + (pts[1]! - p.y) ** 2 <= tol) return m;
      for (let j = 0; j + 3 < pts.length; j += 2) if (segDist2(p.x, p.y, pts[j]!, pts[j + 1]!, pts[j + 2]!, pts[j + 3]!) <= tol) return m;
      continue;
    }
    const b = bounds(m, measure);
    if (p.x >= b.x - slop && p.x <= b.x + b.w + slop && p.y >= b.y - slop && p.y <= b.y + b.h + slop) return m;
  }
  return null;
}

export function moveMark(m: Mark, dx: number, dy: number): Mark {
  if ('rect' in m) return { ...m, rect: { ...m.rect, x: m.rect.x + dx, y: m.rect.y + dy } };
  return { ...m, points: m.points.map((v, i) => v + (i % 2 ? dy : dx)) };
}

/** The resize handles of a mark: a line's or arrow's two ends; a box's (or a stroke's bounding box's) four corners; none for text and steps. */
export function handles(m: Mark): Pt[] {
  if (m.type === 'text' || m.type === 'step') return [];
  if (m.type === 'line' || m.type === 'arrow') return [{ x: m.points[0]!, y: m.points[1]! }, { x: m.points[2]!, y: m.points[3]! }];
  const b = bounds(m);
  return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }];
}

/** Drags handle `h` of the mark as it was when the drag began (`from`) to point `p`. */
export function resizeMark(from: Mark, h: number, p: Pt): Mark {
  if (from.type === 'line' || from.type === 'arrow') {
    const pts = from.points.slice();
    pts[h * 2] = p.x;
    pts[h * 2 + 1] = p.y;
    return { ...from, points: pts };
  }
  const b = bounds(from);
  const corners = handles(from);
  const opposite = corners[(h + 2) % 4];
  if (!opposite) return from;
  const r = normRect(opposite, p);
  if ('rect' in from) return { ...from, rect: r };
  if (from.type === 'pen' || from.type === 'highlight') {
    // A stroke scales with its box.
    const sx = b.w ? r.w / b.w : 1;
    const sy = b.h ? r.h / b.h : 1;
    return { ...from, points: from.points.map((v, i) => (i % 2 ? r.y + (v - b.y) * sy : r.x + (v - b.x) * sx)) };
  }
  return from;
}

/** A mark worth keeping: a box or a line with some size, a stroke with a point; a tap with a box tool makes nothing. */
export function isMeaningful(m: Mark, unit: number): boolean {
  if ('rect' in m) return m.rect.w >= 2 * unit && m.rect.h >= 2 * unit;
  if (m.type === 'line' || m.type === 'arrow') return Math.hypot(m.points[2]! - m.points[0]!, m.points[3]! - m.points[1]!) >= 3 * unit;
  if (m.type === 'text') return m.text.trim().length > 0;
  return m.points.length >= 2;
}

/* ---------- Drawing ---------- */

/** The 2D context calls drawing uses: a CanvasRenderingContext2D fits; tests pass a fake. */
export type Ctx = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'fill'
  | 'closePath'
  | 'arc'
  | 'ellipse'
  | 'strokeRect'
  | 'fillText'
  | 'strokeText'
  | 'measureText'
  | 'setLineDash'
  | 'fillRect'
> & {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
};

const FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const fontOf = (size: number) => `700 ${size}px ${FONT_FAMILY}`;
/** The outline around text and numbers: dark for light colours, light for dark ones, so a mark reads on any screenshot. */
export const haloOf = (color: string) => (color === '#ffffff' || color === '#ffd60a' || color === '#2dc653' ? '#111111' : '#ffffff');

function strokePath(ctx: Ctx, pts: number[]) {
  ctx.beginPath();
  ctx.moveTo(pts[0]!, pts[1]!);
  if (pts.length === 2) ctx.lineTo(pts[0]! + 0.01, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
  ctx.stroke();
}

/** Draws one mark (blur marks are pixels, see pixelate: here only their outline while editing, when `blurOutline` is set). */
export function drawMark(ctx: Ctx, m: Mark | ReporterAnnotation, opts: { blurOutline?: number } = {}): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 1;
  switch (m.type) {
    case 'blur':
      if (opts.blurOutline) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = opts.blurOutline;
        ctx.setLineDash([opts.blurOutline * 3, opts.blurOutline * 2]);
        ctx.strokeRect(m.rect.x, m.rect.y, m.rect.w, m.rect.h);
      }
      break;
    case 'pen':
    case 'line':
      ctx.strokeStyle = m.color;
      ctx.lineWidth = m.width;
      strokePath(ctx, m.points);
      break;
    case 'highlight':
      ctx.globalAlpha = 0.38;
      ctx.lineCap = 'square';
      ctx.strokeStyle = m.color;
      ctx.lineWidth = m.width;
      strokePath(ctx, m.points);
      break;
    case 'arrow': {
      const [x1, y1, x2, y2] = m.points as [number, number, number, number];
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(m.width * 3.5, 8);
      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color;
      ctx.lineWidth = m.width;
      // The shaft stops inside the head so its round cap does not poke out of the tip.
      strokePath(ctx, [x1, y1, x2 - Math.cos(ang) * head * 0.6, y2 - Math.sin(ang) * head * 0.6]);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 7), y2 - head * Math.sin(ang - Math.PI / 7));
      ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 7), y2 - head * Math.sin(ang + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'rect':
      ctx.strokeStyle = m.color;
      ctx.lineWidth = m.width;
      ctx.strokeRect(m.rect.x, m.rect.y, m.rect.w, m.rect.h);
      break;
    case 'ellipse':
      ctx.strokeStyle = m.color;
      ctx.lineWidth = m.width;
      ctx.beginPath();
      ctx.ellipse(m.rect.x + m.rect.w / 2, m.rect.y + m.rect.h / 2, m.rect.w / 2, m.rect.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'text': {
      ctx.font = fontOf(m.width);
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.lineWidth = Math.max(2, m.width / 5);
      ctx.strokeStyle = haloOf(m.color);
      ctx.fillStyle = m.color;
      m.text.split('\n').forEach((line, i) => {
        const y = m.points[1]! + i * m.width * 1.25;
        ctx.strokeText(line, m.points[0]!, y);
        ctx.fillText(line, m.points[0]!, y);
      });
      break;
    }
    case 'step': {
      const [x, y] = m.points as [number, number];
      ctx.fillStyle = m.color;
      ctx.strokeStyle = haloOf(m.color);
      ctx.lineWidth = Math.max(1.5, m.width / 6);
      ctx.beginPath();
      ctx.arc(x, y, m.width, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = haloOf(m.color);
      ctx.font = fontOf(Math.round(m.width * (m.n > 9 ? 0.95 : 1.15)));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(m.n), x, y + m.width * 0.06);
      break;
    }
  }
  ctx.restore();
}

/* ---------- Blur: real pixels ---------- */

/** The block size a blur uses: big enough that text under it cannot be read back. */
export const blockOf = (unit: number) => Math.max(10, Math.round(unit * 8));

/**
 * Pixelates a rectangle of RGBA pixels in place: every block becomes the average of its pixels. Applied to the image's own pixels before it
 * is exported, so the uploaded file holds no trace of what was under it (an overlay could be peeled off; this cannot).
 */
export function pixelate(data: Uint8ClampedArray, width: number, height: number, r: Rect, block: number): void {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.w));
  const y1 = Math.min(height, Math.ceil(r.y + r.h));
  for (let by = y0; by < y1; by += block) {
    for (let bx = x0; bx < x1; bx += block) {
      const ex = Math.min(bx + block, x1);
      const ey = Math.min(by + block, y1);
      let rs = 0;
      let gs = 0;
      let bs = 0;
      let as = 0;
      let n = 0;
      for (let y = by; y < ey; y++)
        for (let x = bx; x < ex; x++) {
          const i = (y * width + x) * 4;
          rs += data[i]!;
          gs += data[i + 1]!;
          bs += data[i + 2]!;
          as += data[i + 3]!;
          n++;
        }
      if (!n) continue;
      const R = rs / n;
      const G = gs / n;
      const B = bs / n;
      const A = as / n;
      for (let y = by; y < ey; y++)
        for (let x = bx; x < ex; x++) {
          const i = (y * width + x) * 4;
          data[i] = R;
          data[i + 1] = G;
          data[i + 2] = B;
          data[i + 3] = A;
        }
    }
  }
}

/** What flatten needs of a canvas: a CanvasRenderingContext2D with image data, and the export. */
export interface FlatCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): (Ctx & Pick<CanvasRenderingContext2D, 'drawImage' | 'getImageData' | 'putImageData'>) | null;
}

/** Draws the image, applies the blurs to its pixels, then draws every other mark on top: the annotated picture, at the image's own size. */
export function renderFlat(canvas: FlatCanvas, image: CanvasImageSource, size: { w: number; h: number }, marks: readonly (Mark | ReporterAnnotation)[]): void {
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the annotations.');
  ctx.drawImage(image, 0, 0, size.w, size.h);
  const unit = unitOf(size);
  for (const m of marks) {
    if (m.type !== 'blur') continue;
    const x = Math.max(0, Math.floor(m.rect.x));
    const y = Math.max(0, Math.floor(m.rect.y));
    const w = Math.min(size.w, Math.ceil(m.rect.x + m.rect.w)) - x;
    const h = Math.min(size.h, Math.ceil(m.rect.y + m.rect.h)) - y;
    if (w <= 0 || h <= 0) continue;
    const px = ctx.getImageData(x, y, w, h);
    pixelate(px.data, w, h, { x: 0, y: 0, w, h }, blockOf(unit));
    ctx.putImageData(px, x, y);
  }
  for (const m of marks) if (m.type !== 'blur') drawMark(ctx, m);
}

/** Browsers cap a canvas's area (iOS Safari at 16.7 megapixels); a bigger shot cannot be annotated. */
export const MAX_CANVAS_AREA = 16_777_216;
export const canAnnotate = (size: { w: number; h: number }) => size.w > 0 && size.h > 0 && size.w * size.h <= MAX_CANVAS_AREA;

/* ---------- The panel's shot ---------- */

type Shot = {
  screenshot: Blob;
  previewUrl: string;
  annotations?: ReporterAnnotation[];
  annotated?: Blob;
  original?: { blob: Blob; url: string };
};

/**
 * A shot after the editor's Done: the marks and the flattened image. Without a blur the original stays the screenshot and the flattened one
 * goes beside it; with a blur the flattened image BECOMES the screenshot (what is uploaded, and what a chat message attaches) and the
 * original stays in the panel only, to annotate again. No marks: back to the original. `revoke`: object URLs no longer shown.
 */
export function withAnnotations<T extends Shot>(c: T, marks: ReporterAnnotation[], image: Blob | null, url: (b: Blob) => string): { next: T; revoke: string[] } {
  const original = c.original ?? { blob: c.screenshot, url: c.previewUrl };
  const { annotations: _a, annotated: _b, original: _o, ...rest } = c;
  const revoke = c.previewUrl !== original.url ? [c.previewUrl] : [];
  if (!marks.length || !image) return { next: { ...rest, screenshot: original.blob, previewUrl: original.url } as T, revoke };
  const blurred = hasBlur(marks);
  const next = { ...rest, original, annotations: marks, previewUrl: url(image), screenshot: blurred ? image : original.blob, ...(blurred ? {} : { annotated: image }) } as T;
  return { next, revoke };
}

/** What a shot uploads, in order: the screenshot (the original, or the blurred image), then the annotated image when there is one. */
export function uploadPlan(c: Shot): { kind: 'screenshot' | 'annotated'; blob: Blob }[] {
  const out: { kind: 'screenshot' | 'annotated'; blob: Blob }[] = [{ kind: 'screenshot', blob: c.screenshot }];
  if (c.annotated && c.annotations?.length && !hasBlur(c.annotations)) out.push({ kind: 'annotated', blob: c.annotated });
  return out;
}

/** The source the editor opens on (the un-annotated screenshot) and the marks it starts with. */
export const editorSource = (c: Shot) => ({ url: c.original?.url ?? c.previewUrl, marks: c.annotations ?? [] });

/** Frees every object URL a shot holds. */
export function revokeShot(c: Shot): void {
  URL.revokeObjectURL(c.previewUrl);
  if (c.original && c.original.url !== c.previewUrl) URL.revokeObjectURL(c.original.url);
}
