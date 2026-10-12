// Knowledge: the force layout behind the graph views (Knowledge PRD §12). A small one written for this page, with
// no dependency: link springs, a Barnes-Hut approximation of repulsion (a quadtree, so a thousand nodes cost a few
// milliseconds a tick, not a million pair checks), a pull to the centre, and cooling. It is deterministic (nodes
// start on a spiral by index) so the same graph always settles the same way, and framework-free so the server's
// tests can measure it. The browser runs it on the main thread and stops when it settles.

export interface LayoutOptions {
  /** Distance links want to be, before the degree adjustment. */
  linkDistance?: number;
  /** How hard nodes push each other apart. */
  repulsion?: number;
  /** Pull towards the centre, against drifting apart. */
  gravity?: number;
  /** Barnes-Hut accuracy: higher is faster and rougher. */
  theta?: number;
  /** Per-tick velocity kept (damping). */
  friction?: number;
}

export interface LayoutEdge {
  /** Indexes into the node list. */
  s: number;
  t: number;
  /** How many links it stands for. */
  w?: number;
}

const ALPHA_MIN = 0.003;
/** The most a node moves in one tick, in layout units (a link is about 30 long). */
const MAX_STEP = 40;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300);

/** A pool of quadtree cells, reused every tick so a tick allocates nothing. */
class QuadTree {
  // Per cell: centre of mass, mass, square bounds (corner and half size), the four children, and the point it holds when a leaf.
  cx: Float64Array;
  cy: Float64Array;
  mass: Float64Array;
  x0: Float64Array;
  y0: Float64Array;
  half: Float64Array;
  kids: Int32Array;
  point: Int32Array;
  count = 0;

  constructor(capacity: number) {
    this.cx = new Float64Array(capacity);
    this.cy = new Float64Array(capacity);
    this.mass = new Float64Array(capacity);
    this.x0 = new Float64Array(capacity);
    this.y0 = new Float64Array(capacity);
    this.half = new Float64Array(capacity);
    this.kids = new Int32Array(capacity * 4);
    this.point = new Int32Array(capacity);
  }

  #cell(x0: number, y0: number, half: number): number {
    const i = this.count++;
    this.cx[i] = 0;
    this.cy[i] = 0;
    this.mass[i] = 0;
    this.x0[i] = x0;
    this.y0[i] = y0;
    this.half[i] = half;
    this.point[i] = -1;
    this.kids[i * 4] = this.kids[i * 4 + 1] = this.kids[i * 4 + 2] = this.kids[i * 4 + 3] = -1;
    return i;
  }

  build(xs: Float64Array, ys: Float64Array, n: number): void {
    this.count = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (xs[i]! < minX) minX = xs[i]!;
      if (xs[i]! > maxX) maxX = xs[i]!;
      if (ys[i]! < minY) minY = ys[i]!;
      if (ys[i]! > maxY) maxY = ys[i]!;
    }
    const half = Math.max(maxX - minX, maxY - minY, 1) / 2 + 1;
    const root = this.#cell((minX + maxX) / 2 - half, (minY + maxY) / 2 - half, half);
    for (let i = 0; i < n; i++) this.#insert(root, i, xs, ys);
  }

  #insert(root: number, p: number, xs: Float64Array, ys: Float64Array): void {
    let c = root;
    let depth = 0;
    for (;;) {
      // Every cell on the way down accumulates the mass and centre of what is below it.
      const m = this.mass[c]!;
      this.cx[c] = (this.cx[c]! * m + xs[p]!) / (m + 1);
      this.cy[c] = (this.cy[c]! * m + ys[p]!) / (m + 1);
      this.mass[c] = m + 1;
      if (m === 0 && this.kids[c * 4] === -1 && this.kids[c * 4 + 1] === -1 && this.kids[c * 4 + 2] === -1 && this.kids[c * 4 + 3] === -1) {
        this.point[c] = p;
        return;
      }
      if (this.point[c]! >= 0) {
        // A leaf already holds a point: push it one level down, then place the new one.
        const q = this.point[c]!;
        this.point[c] = -1;
        if (depth > 40 || (xs[q] === xs[p] && ys[q] === ys[p])) {
          // The same spot (or hopelessly close): keep both here as mass, nudged apart by the caller's jitter.
          this.point[c] = q;
          return;
        }
        const qc = this.#child(c, xs[q]!, ys[q]!);
        const m0 = this.mass[qc]!;
        this.cx[qc] = xs[q]!;
        this.cy[qc] = ys[q]!;
        this.mass[qc] = m0 + 1;
        this.point[qc] = q;
      }
      c = this.#child(c, xs[p]!, ys[p]!);
      depth++;
    }
  }

  #child(c: number, x: number, y: number): number {
    const h = this.half[c]! / 2;
    const right = x >= this.x0[c]! + this.half[c]!;
    const down = y >= this.y0[c]! + this.half[c]!;
    const k = c * 4 + (right ? 1 : 0) + (down ? 2 : 0);
    let child = this.kids[k]!;
    if (child === -1) {
      child = this.#cell(this.x0[c]! + (right ? this.half[c]! : 0), this.y0[c]! + (down ? this.half[c]! : 0), h);
      this.kids[k] = child;
    }
    return child;
  }

  /** The push on point `i` from everything else, added into `out[0..1]`. */
  repel(i: number, xs: Float64Array, ys: Float64Array, theta2: number, k: number, out: Float64Array): void {
    const x = xs[i]!;
    const y = ys[i]!;
    const stack = this.#stack;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const c = stack[--top]!;
      const m = this.mass[c]!;
      if (m === 0) continue;
      const dx = x - this.cx[c]!;
      const dy = y - this.cy[c]!;
      const size = this.half[c]! * 2;
      const d2 = dx * dx + dy * dy;
      const leafPoint = this.point[c]!;
      if (leafPoint >= 0 && this.kids[c * 4] === -1 && this.kids[c * 4 + 1] === -1 && this.kids[c * 4 + 2] === -1 && this.kids[c * 4 + 3] === -1) {
        if (leafPoint === i) continue;
        if (d2 === 0) {
          // The same spot: a push in a direction both ends agree on, or they would never come apart.
          const a = (i * 2654435761 + leafPoint * 40503) % 6283;
          out[0]! += Math.cos(a / 1000) * k * 0.05;
          out[1]! += Math.sin(a / 1000) * k * 0.05;
          continue;
        }
        const f = (k * m) / (d2 < 1 ? 1 : d2);
        out[0]! += dx * f;
        out[1]! += dy * f;
        continue;
      }
      if ((size * size) / (d2 || 1) < theta2) {
        // Repulsion falls off with distance (not its square), which keeps far parts of a graph from drifting off.
        const f = (k * m) / (d2 < 1 ? 1 : d2);
        out[0]! += dx * f;
        out[1]! += dy * f;
        continue;
      }
      for (let q = 0; q < 4; q++) {
        const ch = this.kids[c * 4 + q]!;
        if (ch !== -1) stack[top++] = ch;
      }
    }
  }

  readonly #stack = new Int32Array(4096);
}

export class ForceLayout {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  /** Pinned nodes keep their place. */
  readonly fixed: Uint8Array;
  alpha = 1;
  readonly #edges: LayoutEdge[];
  readonly #degree: Int32Array;
  readonly #tree: QuadTree;
  readonly #opts: Required<LayoutOptions>;
  readonly #force = new Float64Array(2);

  constructor(n: number, edges: LayoutEdge[], opts: LayoutOptions = {}) {
    this.n = n;
    this.#edges = edges;
    this.#opts = { linkDistance: opts.linkDistance ?? 30, repulsion: opts.repulsion ?? 45, gravity: opts.gravity ?? 0.07, theta: opts.theta ?? 0.9, friction: opts.friction ?? 0.62 };
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.fixed = new Uint8Array(n);
    this.#degree = new Int32Array(n);
    for (const e of edges) {
      this.#degree[e.s]!++;
      this.#degree[e.t]!++;
    }
    // A spiral by index: deterministic, spread out, and no two nodes at the same spot.
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const r = 20 * Math.sqrt(i + 0.5);
      this.x[i] = r * Math.cos(i * golden);
      this.y[i] = r * Math.sin(i * golden);
    }
    this.#tree = new QuadTree(Math.max(8, n * 4 + 16));
  }

  get settled(): boolean {
    return this.alpha < ALPHA_MIN;
  }

  /** Warms the layout up again, after a node was pinned or the graph changed. */
  reheat(alpha = 0.6): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  /** One step. Returns whether the layout has settled. */
  tick(): boolean {
    const { n, x, y, vx, vy, fixed } = this;
    if (n === 0) {
      this.alpha = 0;
      return true;
    }
    const o = this.#opts;
    const alpha = this.alpha;
    this.#tree.build(x, y, n);
    const theta2 = o.theta * o.theta;
    const f = this.#force;
    for (let i = 0; i < n; i++) {
      f[0] = 0;
      f[1] = 0;
      this.#tree.repel(i, x, y, theta2, o.repulsion, f);
      vx[i]! += f[0]! * alpha;
      vy[i]! += f[1]! * alpha;
      // Gravity: the further out, the harder the pull home.
      vx[i]! -= x[i]! * o.gravity * alpha;
      vy[i]! -= y[i]! * o.gravity * alpha;
    }
    for (const e of this.#edges) {
      const dx = x[e.t]! - x[e.s]!;
      const dy = y[e.t]! - y[e.s]!;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const ds = this.#degree[e.s]!;
      const dt = this.#degree[e.t]!;
      // Busy nodes keep their neighbours a little further away, so hubs open up.
      const rest = o.linkDistance * (1 + 0.12 * Math.log1p(Math.max(ds, dt)));
      // Each link pulls with one over the smaller degree of its ends (as d3-force does), so a node is never pulled harder in total
      // than one with a single link is: a hub with a hundred links would otherwise overshoot a little more every tick and fly apart.
      const strength = (0.9 + 0.2 * Math.min(3, Math.log2(1 + (e.w ?? 1)) / 2)) / Math.max(1, Math.min(ds, dt));
      const stretch = ((d - rest) / d) * strength * alpha;
      // The end with fewer links moves more.
      const share = (ds + 1) / (ds + dt + 2);
      const fx = dx * stretch;
      const fy = dy * stretch;
      vx[e.s]! += fx * (1 - share);
      vy[e.s]! += fy * (1 - share);
      vx[e.t]! -= fx * share;
      vy[e.t]! -= fy * share;
    }
    for (let i = 0; i < n; i++) {
      if (fixed[i]) {
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      let ux = vx[i]! * o.friction;
      let uy = vy[i]! * o.friction;
      // However it came about, no node moves further than this in a tick.
      const sp = ux * ux + uy * uy;
      if (sp > MAX_STEP * MAX_STEP) {
        const c = MAX_STEP / Math.sqrt(sp);
        ux *= c;
        uy *= c;
      }
      vx[i] = ux;
      vy[i] = uy;
      x[i]! += ux;
      y[i]! += uy;
    }
    this.alpha *= 1 - ALPHA_DECAY;
    return this.settled;
  }

  /** Runs until settled or `max` ticks; returns the ticks used. */
  run(max = 400): number {
    let i = 0;
    while (i < max && !this.tick()) i++;
    return i;
  }

  /** The box around every node: [minX, minY, maxX, maxY]. */
  bounds(): [number, number, number, number] {
    let a = Infinity;
    let b = Infinity;
    let c = -Infinity;
    let d = -Infinity;
    for (let i = 0; i < this.n; i++) {
      if (this.x[i]! < a) a = this.x[i]!;
      if (this.y[i]! < b) b = this.y[i]!;
      if (this.x[i]! > c) c = this.x[i]!;
      if (this.y[i]! > d) d = this.y[i]!;
    }
    return this.n ? [a, b, c, d] : [0, 0, 0, 0];
  }
}

/** The node under a point, using a grid so a tap on a thousand nodes isn't a thousand checks. */
export class HitGrid {
  readonly #cells = new Map<number, number[]>();
  readonly #size: number;
  constructor(
    private readonly x: Float64Array,
    private readonly y: Float64Array,
    private readonly n: number,
    size = 40,
  ) {
    this.#size = size;
    for (let i = 0; i < n; i++) {
      const k = this.#key(x[i]!, y[i]!);
      const list = this.#cells.get(k);
      if (list) list.push(i);
      else this.#cells.set(k, [i]);
    }
  }

  #key(px: number, py: number): number {
    return Math.floor(px / this.#size) * 100_003 + Math.floor(py / this.#size);
  }

  /** The nearest node within `radius(i)` of (px, py), or -1. */
  nearest(px: number, py: number, radius: (i: number) => number, reach = 40): number {
    let best = -1;
    let bestD = Infinity;
    const cells = Math.ceil(reach / this.#size);
    const cx = Math.floor(px / this.#size);
    const cy = Math.floor(py / this.#size);
    for (let gx = cx - cells; gx <= cx + cells; gx++) {
      for (let gy = cy - cells; gy <= cy + cells; gy++) {
        const list = this.#cells.get(gx * 100_003 + gy);
        if (!list) continue;
        for (const i of list) {
          const d = Math.hypot(this.x[i]! - px, this.y[i]! - py);
          if (d <= radius(i) && d < bestD) {
            best = i;
            bestD = d;
          }
        }
      }
    }
    return best;
  }
}
