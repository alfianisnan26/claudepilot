// Knowledge: the graph canvas (Knowledge PRD §12, §16). A plain class that owns one <canvas>: the force layout (from
// @portal/contracts), drawing, and the gestures: drag to pan, wheel or pinch to zoom, tap to open, hold to pick, and for a
// mouse hover and drag-a-node. React only wires it up (GraphView.tsx), so nothing here re-renders while the layout moves.
// It draws only while something moves or changed, so a settled graph costs nothing.

import { ForceLayout, HitGrid, type GraphEdgeKind, type GraphNode, type GraphResponse } from '@portal/contracts';
import { colorOf, radiusOf, shapeOf } from './graphModel';

export interface EngineColors {
  ink: string;
  muted: string;
  line: string;
  bg: string;
  accent: string;
  dark: boolean;
}

export interface EngineCallbacks {
  /** A tap or click on a node. */
  tap(node: GraphNode): void;
  /** A press held on a node: pick it without leaving. */
  hold(node: GraphNode): void;
  /** A tap on nothing. */
  blank(): void;
}

interface View {
  x: number;
  y: number;
  k: number;
}

interface Remembered {
  pos: Map<string, [number, number]>;
  view: View | null;
}

/** Where nodes settled and the view, by query: coming back to a graph (or refreshing it) doesn't start over. */
const remembered = new Map<string, Remembered>();
const REMEMBER_MAX = 12;

const WRITES: ReadonlySet<GraphEdgeKind> = new Set(['created', 'edited', 'appended', 'deleted']);
const MIN_K = 0.03;
const MAX_K = 6;
const TAP_MS = 450;
const HOLD_MS = 480;
const MOVE_PX = 6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class GraphEngine {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #cb: EngineCallbacks;
  #w = 300;
  #h = 300;
  #dpr = 1;
  #colors: EngineColors = { ink: '#222', muted: '#888', line: '#ccc', bg: '#fff', accent: '#2563eb', dark: false };
  #compact = false;
  #reduced = false;

  #nodes: GraphNode[] = [];
  #index = new Map<string, number>();
  #edges: { s: number; t: number; w: number; kind: GraphEdgeKind }[] = [];
  #adj: number[][] = [];
  #radius = new Float32Array(0);
  #fill: string[] = [];
  #rank = new Int32Array(0);
  #layout: ForceLayout | null = null;
  #key = '';
  #center = -1;
  #selected = -1;
  #hover = -1;
  #focus: Set<number> | null = null;

  #view: View = { x: 0, y: 0, k: 1 };
  #userMoved = false;
  #grid: HitGrid | null = null;
  #gridStale = true;

  #raf = 0;
  #dirty = true;
  #destroyed = false;
  readonly #pointers = new Map<number, { x: number; y: number }>();
  #press: { x0: number; y0: number; t0: number; moved: boolean; held: boolean; node: number; drag: boolean; pinchD: number; type: string } | null = null;
  #holdTimer: ReturnType<typeof setTimeout> | undefined;
  #hoverAt: { x: number; y: number } | null = null;
  readonly #widths = new Map<string, number>();

  constructor(canvas: HTMLCanvasElement, cb: EngineCallbacks) {
    this.#canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser can’t draw the graph.');
    this.#ctx = ctx;
    this.#cb = cb;
    canvas.addEventListener('pointerdown', this.#down);
    canvas.addEventListener('pointermove', this.#move);
    canvas.addEventListener('pointerup', this.#up);
    canvas.addEventListener('pointercancel', this.#cancel);
    canvas.addEventListener('pointerleave', this.#leave);
    canvas.addEventListener('wheel', this.#wheel, { passive: false });
    canvas.addEventListener('dblclick', this.#dbl);
    canvas.addEventListener('keydown', this.#key_);
  }

  destroy(): void {
    this.#destroyed = true;
    this.#remember();
    cancelAnimationFrame(this.#raf);
    clearTimeout(this.#holdTimer);
    const c = this.#canvas;
    c.removeEventListener('pointerdown', this.#down);
    c.removeEventListener('pointermove', this.#move);
    c.removeEventListener('pointerup', this.#up);
    c.removeEventListener('pointercancel', this.#cancel);
    c.removeEventListener('pointerleave', this.#leave);
    c.removeEventListener('wheel', this.#wheel);
    c.removeEventListener('dblclick', this.#dbl);
    c.removeEventListener('keydown', this.#key_);
  }

  /* ---------- Setup ---------- */

  resize(width: number, height: number): void {
    const w = Math.max(40, Math.floor(width));
    const h = Math.max(40, Math.floor(height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === this.#w && h === this.#h && dpr === this.#dpr) return;
    const first = this.#w === 300 && this.#h === 300 && !this.#layout;
    this.#w = w;
    this.#h = h;
    this.#dpr = dpr;
    this.#canvas.width = Math.round(w * dpr);
    this.#canvas.height = Math.round(h * dpr);
    if (!this.#userMoved && !first) this.fit(false);
    this.#invalidate();
  }

  setColors(colors: EngineColors): void {
    this.#colors = colors;
    this.#fill = this.#nodes.map((n) => colorOf(n, colors.dark));
    this.#invalidate();
  }

  /** `compact`: a panel, not a page (labels only for the node asked about). `reduced`: no animation, the layout is settled before it is drawn. */
  setGraph(graph: GraphResponse, key: string, o: { compact?: boolean; reduced?: boolean } = {}): void {
    this.#remember();
    this.#compact = !!o.compact;
    this.#reduced = !!o.reduced;
    this.#key = key;
    this.#nodes = graph.nodes;
    this.#index = new Map(graph.nodes.map((n, i) => [n.id, i]));
    this.#edges = [];
    for (const e of graph.edges) {
      const s = this.#index.get(e.from);
      const t = this.#index.get(e.to);
      if (s !== undefined && t !== undefined && s !== t) this.#edges.push({ s, t, w: e.weight, kind: e.kind });
    }
    const n = graph.nodes.length;
    this.#adj = Array.from({ length: n }, () => []);
    for (const e of this.#edges) {
      this.#adj[e.s]!.push(e.t);
      this.#adj[e.t]!.push(e.s);
    }
    this.#radius = Float32Array.from(graph.nodes.map(radiusOf));
    this.#fill = graph.nodes.map((nd) => colorOf(nd, this.#colors.dark));
    this.#center = graph.center ? (this.#index.get(graph.center) ?? -1) : -1;
    // Who gets a label first: the most linked.
    this.#rank = Int32Array.from(graph.nodes.map((_, i) => i).sort((a, b) => graph.nodes[b]!.degree - graph.nodes[a]!.degree));
    this.#selected = -1;
    this.#hover = -1;
    this.#focus = null;

    const layout = new ForceLayout(
      n,
      this.#edges.map((e) => ({ s: e.s, t: e.t, w: e.w })),
    );
    const mem = remembered.get(key);
    let found = 0;
    if (mem) {
      for (let i = 0; i < n; i++) {
        const p = mem.pos.get(graph.nodes[i]!.id);
        if (!p) continue;
        layout.x[i] = p[0];
        layout.y[i] = p[1];
        found++;
      }
      // Nodes that are new start beside a neighbour that is known.
      if (found > 0 && found < n) {
        for (let i = 0; i < n; i++) {
          if (mem.pos.has(graph.nodes[i]!.id)) continue;
          const known = this.#adj[i]!.filter((j) => mem.pos.has(graph.nodes[j]!.id));
          if (!known.length) continue;
          const j = known[0]!;
          // Never exactly on it: two nodes on one spot have no direction to be pushed apart in.
          const a = i * 2.399963;
          layout.x[i] = layout.x[j]! + (6 + (i % 7)) * Math.cos(a);
          layout.y[i] = layout.y[j]! + (6 + (i % 5)) * Math.sin(a);
        }
      }
    }
    // A local graph keeps the note it is about in the middle.
    if (this.#center >= 0) {
      layout.x[this.#center] = 0;
      layout.y[this.#center] = 0;
      layout.fixed[this.#center] = 1;
    }
    layout.alpha = found >= n * 0.6 ? 0.22 : 1;
    this.#layout = layout;
    this.#gridStale = true;
    if (this.#reduced) layout.run(500);
    else layout.run(found >= n * 0.6 ? 0 : 24);
    if (mem?.view && found >= n * 0.6) {
      this.#view = { ...mem.view };
      this.#userMoved = true;
    } else {
      this.#userMoved = false;
      this.fit(false);
    }
    this.#fitAfterSettle = true;
    this.#invalidate();
  }

  setSelected(id: string | null): void {
    this.#selected = id ? (this.#index.get(id) ?? -1) : -1;
    this.#updateFocus();
    this.#invalidate();
  }

  #remember(): void {
    const l = this.#layout;
    if (!l || !this.#key || this.#nodes.length === 0) return;
    const pos = new Map<string, [number, number]>();
    for (let i = 0; i < this.#nodes.length; i++) pos.set(this.#nodes[i]!.id, [l.x[i]!, l.y[i]!]);
    remembered.delete(this.#key);
    remembered.set(this.#key, { pos, view: this.#userMoved ? { ...this.#view } : null });
    while (remembered.size > REMEMBER_MAX) remembered.delete(remembered.keys().next().value as string);
  }

  /* ---------- View ---------- */

  /**
   * The box around the nodes, leaving out the farthest few (a lone node drifting off would otherwise shrink everything): the
   * middle 98% of each axis, with room for what is cut.
   */
  #box(): [number, number, number, number] {
    const l = this.#layout!;
    if (l.n < 40) return l.bounds();
    const xs = Float64Array.from(l.x.subarray(0, l.n)).sort();
    const ys = Float64Array.from(l.y.subarray(0, l.n)).sort();
    const lo = Math.floor(l.n * 0.01);
    const hi = l.n - 1 - lo;
    return [xs[lo]!, ys[lo]!, xs[hi]!, ys[hi]!];
  }

  /** How far a fit may zoom in: a few nodes in a small panel can be drawn large. */
  #maxK(): number {
    return this.#nodes.length <= 12 ? 3 : 2.2;
  }

  /** Fits every node in view. */
  fit(animate = true): void {
    const l = this.#layout;
    if (!l || l.n === 0) return;
    const [x0, y0, x1, y1] = this.#box();
    const pad = this.#compact ? 18 : 36;
    const bw = Math.max(40, x1 - x0);
    const bh = Math.max(40, y1 - y0);
    const k = clamp(Math.min((this.#w - pad * 2) / bw, (this.#h - pad * 2) / bh), MIN_K, this.#maxK());
    const target = { k, x: this.#w / 2 - ((x0 + x1) / 2) * k, y: this.#h / 2 - ((y0 + y1) / 2) * k };
    if (animate && !this.#reduced) {
      this.#goal = target;
      this.#invalidate();
    } else {
      this.#view = target;
      this.#goal = null;
    }
    this.#userMoved = false;
    this.#invalidate();
  }

  #goal: View | null = null;

  zoomBy(factor: number): void {
    this.#zoomAt(this.#w / 2, this.#h / 2, factor);
  }

  #zoomAt(sx: number, sy: number, factor: number): void {
    const v = this.#view;
    const k = clamp(v.k * factor, MIN_K, MAX_K);
    const f = k / v.k;
    v.x = sx - (sx - v.x) * f;
    v.y = sy - (sy - v.y) * f;
    v.k = k;
    this.#userMoved = true;
    this.#goal = null;
    this.#invalidate();
  }

  /* ---------- Frame loop ---------- */

  #invalidate(): void {
    this.#dirty = true;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#raf || this.#destroyed) return;
    this.#raf = requestAnimationFrame(this.#frame);
  }

  readonly #frame = (): void => {
    this.#raf = 0;
    if (this.#destroyed) return;
    let moving = false;
    const l = this.#layout;
    if (l && !l.settled) {
      const ticks = l.n <= 200 ? 3 : l.n <= 700 ? 2 : 1;
      for (let i = 0; i < ticks && !l.settled; i++) l.tick();
      this.#gridStale = true;
      this.#dirty = true;
      moving = !l.settled;
      // While it unfolds the whole graph stays in view, unless the person took over.
      if (!this.#userMoved && !this.#goal) this.#follow();
    } else if (l && this.#fitAfterSettle && !this.#userMoved) {
      this.#fitAfterSettle = false;
      this.fit(true);
    }
    if (this.#goal) {
      const v = this.#view;
      const g = this.#goal;
      v.x += (g.x - v.x) * 0.2;
      v.y += (g.y - v.y) * 0.2;
      v.k += (g.k - v.k) * 0.2;
      if (Math.abs(g.x - v.x) < 0.4 && Math.abs(g.y - v.y) < 0.4 && Math.abs(g.k - v.k) < 0.002) {
        this.#view = { ...g };
        this.#goal = null;
      }
      this.#dirty = true;
      moving = true;
    }
    if (this.#dirty) {
      this.#dirty = false;
      this.#draw();
    }
    if (moving) this.#schedule();
  };

  #fitAfterSettle = true;

  /** Eases the view towards the box around the nodes as they move. */
  #follow(): void {
    const l = this.#layout;
    if (!l || l.n === 0) return;
    const [x0, y0, x1, y1] = this.#box();
    const pad = this.#compact ? 18 : 36;
    const k = clamp(Math.min((this.#w - pad * 2) / Math.max(40, x1 - x0), (this.#h - pad * 2) / Math.max(40, y1 - y0)), MIN_K, this.#maxK());
    const v = this.#view;
    v.k += (k - v.k) * 0.12;
    v.x += (this.#w / 2 - ((x0 + x1) / 2) * k - v.x) * 0.12;
    v.y += (this.#h / 2 - ((y0 + y1) / 2) * k - v.y) * 0.12;
  }

  /* ---------- Drawing ---------- */

  #updateFocus(): void {
    const i = this.#hover >= 0 ? this.#hover : this.#selected;
    if (i < 0) {
      this.#focus = null;
      return;
    }
    const set = new Set<number>([i]);
    for (const j of this.#adj[i] ?? []) set.add(j);
    this.#focus = set;
  }

  #textWidth(ctx: CanvasRenderingContext2D, text: string): number {
    let w = this.#widths.get(text);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      if (this.#widths.size > 4000) this.#widths.clear();
      this.#widths.set(text, w);
    }
    return w;
  }

  #draw(): void {
    const ctx = this.#ctx;
    const l = this.#layout;
    const { k, x: vx, y: vy } = this.#view;
    const c = this.#colors;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, this.#w, this.#h);
    if (!l || l.n === 0) return;
    const X = l.x;
    const Y = l.y;
    const w = this.#w;
    const h = this.#h;
    const focus = this.#focus;
    const dim = focus !== null;

    // Edges, in a few batches by look: what is drawn per edge is one segment.
    const batches = new Map<string, Path2D>();
    const hot = new Path2D();
    let hotAny = false;
    for (const e of this.#edges) {
      const ax = X[e.s]! * k + vx;
      const ay = Y[e.s]! * k + vy;
      const bx = X[e.t]! * k + vx;
      const by = Y[e.t]! * k + vy;
      if ((ax < -20 && bx < -20) || (ax > w + 20 && bx > w + 20) || (ay < -20 && by < -20) || (ay > h + 20 && by > h + 20)) continue;
      if (focus && focus.has(e.s) && focus.has(e.t) && (e.s === (this.#hover >= 0 ? this.#hover : this.#selected) || e.t === (this.#hover >= 0 ? this.#hover : this.#selected))) {
        hot.moveTo(ax, ay);
        hot.lineTo(bx, by);
        hotAny = true;
        continue;
      }
      const cls = WRITES.has(e.kind) ? 'w' : e.kind === 'read' ? 'r' : 'n';
      const width = e.w >= 5 ? 2 : e.w >= 2 ? 1.4 : 0.9;
      const key = `${cls}${width}`;
      let p = batches.get(key);
      if (!p) {
        p = new Path2D();
        batches.set(key, p);
      }
      p.moveTo(ax, ay);
      p.lineTo(bx, by);
    }
    for (const [key, path] of batches) {
      const cls = key[0]!;
      ctx.lineWidth = Number(key.slice(1));
      ctx.strokeStyle = cls === 'w' ? c.accent : cls === 'r' ? c.muted : c.ink;
      ctx.globalAlpha = (dim ? 0.07 : cls === 'n' ? 0.2 : 0.38) * (c.dark ? 1.25 : 1);
      ctx.stroke(path);
    }
    if (hotAny) {
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = c.accent;
      ctx.stroke(hot);
    }

    // Nodes.
    const sizes = this.#radius;
    for (let i = 0; i < l.n; i++) {
      const n = this.#nodes[i]!;
      const sx = X[i]! * k + vx;
      const sy = Y[i]! * k + vy;
      const r = clamp(sizes[i]! * Math.sqrt(k) * 1.15, n.kind === 'cluster' ? 7 : 2.4, 44);
      if (sx < -r || sx > w + r || sy < -r || sy > h + r) continue;
      const inFocus = !dim || focus!.has(i);
      ctx.globalAlpha = inFocus ? 1 : 0.16;
      const color = this.#fill[i]!;
      const shape = shapeOf(n.kind);
      ctx.beginPath();
      if (shape === 'circle') ctx.arc(sx, sy, r, 0, Math.PI * 2);
      else if (shape === 'diamond') {
        ctx.moveTo(sx, sy - r * 1.25);
        ctx.lineTo(sx + r * 1.25, sy);
        ctx.lineTo(sx, sy + r * 1.25);
        ctx.lineTo(sx - r * 1.25, sy);
        ctx.closePath();
      } else if (shape === 'square') {
        if (typeof ctx.roundRect === 'function') ctx.roundRect(sx - r, sy - r, r * 2, r * 2, Math.min(4, r * 0.35));
        else ctx.rect(sx - r, sy - r, r * 2, r * 2);
      } else ctx.arc(sx, sy, r, 0, Math.PI * 2);
      if (shape === 'ring') {
        if (n.kind === 'cluster') {
          ctx.fillStyle = color;
          ctx.globalAlpha *= 0.16;
          ctx.fill();
          ctx.globalAlpha = inFocus ? 1 : 0.16;
        }
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = color;
        ctx.setLineDash(n.kind === 'cluster' ? [4, 3] : [2, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (n.kind === 'cluster' && r >= 9) {
          ctx.fillStyle = c.ink;
          ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(n.count !== undefined && n.count > 999 ? `${Math.round(n.count / 100) / 10}k` : String(n.count ?? ''), sx, sy);
          ctx.textAlign = 'start';
        }
      } else {
        ctx.fillStyle = color;
        ctx.fill();
        if (n.state === 'gone') {
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = c.muted;
          ctx.setLineDash([2, 2]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      if (i === this.#selected || i === this.#hover || i === this.#center) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = i === this.#center ? 2.2 : 2;
        ctx.strokeStyle = i === this.#center ? c.ink : c.accent;
        ctx.beginPath();
        ctx.arc(sx, sy, r + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // Labels: the hovered, picked and central ones first, then the most linked as there is room (more as you zoom in).
    ctx.font = '11.5px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const placed: number[] = [];
    let shown = 0;
    const overlaps = (x: number, y: number, tw: number): boolean => {
      for (let p = 0; p < placed.length; p += 4) if (x < placed[p + 2]! && x + tw > placed[p]! && y - 7 < placed[p + 3]! && y + 7 > placed[p + 1]!) return true;
      return false;
    };
    const label = (i: number, force: boolean): void => {
      const n = this.#nodes[i]!;
      const sx = X[i]! * k + vx;
      const sy = Y[i]! * k + vy;
      if (sx < -10 || sx > w + 200 || sy < -10 || sy > h + 10) return;
      const r = clamp(sizes[i]! * Math.sqrt(k) * 1.15, 2.4, 44);
      const text = n.label;
      const tw = this.#textWidth(ctx, text);
      const x = sx + r + 4;
      if (!force && overlaps(x, sy, tw)) return;
      placed.push(x, sy - 7, x + tw, sy + 7);
      // A halo in the page's colour keeps the words legible over lines and nodes without hiding them.
      ctx.lineWidth = 3;
      ctx.strokeStyle = c.bg;
      ctx.globalAlpha = (dim && !focus!.has(i) ? 0.35 : 1) * 0.8;
      ctx.strokeText(text, x, sy);
      ctx.globalAlpha = dim && !focus!.has(i) ? 0.35 : 1;
      ctx.fillStyle = c.ink;
      ctx.fillText(text, x, sy);
      shown++;
    };
    const forced = new Set<number>();
    for (const i of [this.#hover, this.#selected, this.#center]) if (i >= 0) forced.add(i);
    for (const i of forced) label(i, true);
    if (focus) for (const j of focus) if (!forced.has(j) && shown < 40) label(j, false);
    // A panel labels only what is picked, unless there are so few nodes that all can be named.
    if (!this.#compact || l.n <= 14) {
      for (let q = 0; q < this.#rank.length && shown < 160; q++) {
        const i = this.#rank[q]!;
        if (forced.has(i) || (focus && focus.has(i))) continue;
        const show = q < 8 ? true : q < 30 ? k >= 0.4 : q < 90 ? k >= 0.7 : q < 260 ? k >= 1.1 : k >= 1.8;
        if (!show) break;
        label(i, false);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- Gestures ---------- */

  #at(e: PointerEvent): { x: number; y: number } {
    const r = this.#canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** The node under a point on screen, or -1: the nearest within its size, with a larger reach for a finger. */
  #hit(sx: number, sy: number, touch: boolean): number {
    const l = this.#layout;
    if (!l || l.n === 0) return -1;
    if (this.#gridStale || !this.#grid) {
      this.#grid = new HitGrid(l.x, l.y, l.n, 40);
      this.#gridStale = false;
    }
    const { k, x, y } = this.#view;
    const wx = (sx - x) / k;
    const wy = (sy - y) / k;
    const reachPx = touch ? 20 : 11;
    const sizes = this.#radius;
    return this.#grid.nearest(wx, wy, (i) => Math.max(clamp(sizes[i]! * Math.sqrt(k) * 1.15, 2.4, 44) / k, reachPx / k), Math.min(600, reachPx / k + 50));
  }

  readonly #down = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.#canvas.setPointerCapture(e.pointerId);
    const p = this.#at(e);
    this.#pointers.set(e.pointerId, p);
    if (this.#pointers.size === 1) {
      const node = this.#hit(p.x, p.y, e.pointerType !== 'mouse');
      this.#press = { x0: p.x, y0: p.y, t0: performance.now(), moved: false, held: false, node, drag: false, pinchD: 0, type: e.pointerType };
      clearTimeout(this.#holdTimer);
      if (node >= 0) {
        this.#holdTimer = setTimeout(() => {
          const pr = this.#press;
          if (!pr || pr.moved || pr.node < 0) return;
          pr.held = true;
          this.#cb.hold(this.#nodes[pr.node]!);
        }, HOLD_MS);
      }
    } else if (this.#press) {
      // A second finger: this is a pinch, not a tap.
      clearTimeout(this.#holdTimer);
      this.#press.moved = true;
      const [a, b] = [...this.#pointers.values()];
      this.#press.pinchD = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    }
  };

  readonly #move = (e: PointerEvent): void => {
    const p = this.#at(e);
    const before = this.#pointers.get(e.pointerId);
    if (!before) {
      // No button down: a mouse hovering.
      if (e.pointerType === 'mouse') this.#hoverTo(p.x, p.y);
      return;
    }
    this.#pointers.set(e.pointerId, p);
    const press = this.#press;
    if (!press) return;
    if (this.#pointers.size >= 2) {
      const [a, b] = [...this.#pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const mx = (a!.x + b!.x) / 2;
      const my = (a!.y + b!.y) / 2;
      if (press.pinchD > 0 && d > 0) {
        const lastMid = this.#lastMid ?? { x: mx, y: my };
        this.#view.x += mx - lastMid.x;
        this.#view.y += my - lastMid.y;
        this.#zoomAt(mx, my, d / press.pinchD);
      }
      press.pinchD = d;
      this.#lastMid = { x: mx, y: my };
      return;
    }
    this.#lastMid = null;
    const dx = p.x - before.x;
    const dy = p.y - before.y;
    if (!press.moved && Math.hypot(p.x - press.x0, p.y - press.y0) > MOVE_PX) {
      press.moved = true;
      clearTimeout(this.#holdTimer);
      // A mouse takes the node it is on; a finger always moves the view.
      press.drag = press.type === 'mouse' && press.node >= 0 && !this.#layout!.fixed[press.node];
      if (press.drag) this.#layout!.fixed[press.node] = 1;
    }
    if (!press.moved) return;
    if (press.drag && this.#layout) {
      const { k, x, y } = this.#view;
      this.#layout.x[press.node] = (p.x - x) / k;
      this.#layout.y[press.node] = (p.y - y) / k;
      this.#layout.reheat(0.25);
      this.#gridStale = true;
    } else {
      this.#view.x += dx;
      this.#view.y += dy;
      this.#userMoved = true;
      this.#goal = null;
    }
    this.#invalidate();
  };

  #lastMid: { x: number; y: number } | null = null;

  readonly #up = (e: PointerEvent): void => {
    const had = this.#pointers.delete(e.pointerId);
    clearTimeout(this.#holdTimer);
    const press = this.#press;
    this.#lastMid = null;
    if (!had || !press) return;
    if (this.#pointers.size > 0) {
      // A pinch ended with one finger still down: carry on as a pan from here.
      const rest = [...this.#pointers.values()][0]!;
      press.moved = true;
      press.pinchD = 0;
      press.x0 = rest.x;
      press.y0 = rest.y;
      return;
    }
    this.#press = null;
    if (press.drag && this.#layout) {
      this.#layout.fixed[press.node] = 0;
      return;
    }
    if (press.moved || press.held) return;
    if (performance.now() - press.t0 > TAP_MS) return;
    if (press.node >= 0) this.#cb.tap(this.#nodes[press.node]!);
    else this.#cb.blank();
  };

  readonly #cancel = (e: PointerEvent): void => {
    this.#pointers.delete(e.pointerId);
    clearTimeout(this.#holdTimer);
    if (this.#press?.drag && this.#layout) this.#layout.fixed[this.#press.node] = 0;
    if (this.#pointers.size === 0) this.#press = null;
    this.#lastMid = null;
  };

  readonly #leave = (): void => {
    if (this.#hover >= 0 && this.#pointers.size === 0) {
      this.#hover = -1;
      this.#updateFocus();
      this.#canvas.style.cursor = '';
      this.#invalidate();
    }
  };

  #hoverTo(sx: number, sy: number): void {
    this.#hoverAt = { x: sx, y: sy };
    if (this.#hoverRaf) return;
    this.#hoverRaf = requestAnimationFrame(() => {
      this.#hoverRaf = 0;
      const at = this.#hoverAt;
      if (!at || this.#destroyed) return;
      const i = this.#hit(at.x, at.y, false);
      if (i !== this.#hover) {
        this.#hover = i;
        this.#updateFocus();
        this.#canvas.style.cursor = i >= 0 ? 'pointer' : '';
        this.#invalidate();
      }
    });
  }

  #hoverRaf = 0;

  readonly #wheel = (e: WheelEvent): void => {
    e.preventDefault();
    const r = this.#canvas.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    this.#zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.012 : 0.0016)));
  };

  readonly #dbl = (e: MouseEvent): void => {
    const r = this.#canvas.getBoundingClientRect();
    if (this.#hit(e.clientX - r.left, e.clientY - r.top, false) >= 0) return;
    this.#zoomAt(e.clientX - r.left, e.clientY - r.top, 1.8);
  };

  readonly #key_ = (e: KeyboardEvent): void => {
    const step = 48;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        this.#view.x += step;
        break;
      case 'ArrowRight':
        this.#view.x -= step;
        break;
      case 'ArrowUp':
        this.#view.y += step;
        break;
      case 'ArrowDown':
        this.#view.y -= step;
        break;
      case '+':
      case '=':
        this.zoomBy(1.3);
        break;
      case '-':
      case '_':
        this.zoomBy(1 / 1.3);
        break;
      case '0':
        this.fit();
        break;
      case 'Enter':
        if (this.#selected >= 0) this.#cb.tap(this.#nodes[this.#selected]!);
        break;
      default:
        handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    this.#userMoved = true;
    this.#goal = null;
    this.#invalidate();
  };
}
