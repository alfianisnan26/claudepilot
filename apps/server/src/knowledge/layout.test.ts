import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForceLayout, HitGrid, type LayoutEdge } from '@portal/contracts';

const ring = (n: number): LayoutEdge[] => Array.from({ length: n }, (_, i) => ({ s: i, t: (i + 1) % n }));
const stats = (l: ForceLayout, edges: LayoutEdge[]) => {
  const lens = edges.map((e) => Math.hypot(l.x[e.s]! - l.x[e.t]!, l.y[e.s]! - l.y[e.t]!));
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
  let minGap = Infinity;
  for (let i = 0; i < l.n; i++) for (let j = i + 1; j < l.n; j++) minGap = Math.min(minGap, Math.hypot(l.x[i]! - l.x[j]!, l.y[i]! - l.y[j]!));
  return { mean, cv: sd / mean, minGap };
};

test('layout: deterministic, finite, settles, and lays a ring out evenly without overlaps', () => {
  const edges = ring(40);
  const a = new ForceLayout(40, edges);
  const b = new ForceLayout(40, edges);
  const ticks = a.run(500);
  b.run(500);
  assert.ok(a.settled && ticks <= 400, `settled after ${ticks} ticks`);
  assert.deepEqual([...a.x], [...b.x]);
  assert.ok([...a.x, ...a.y].every(Number.isFinite));
  const s = stats(a, edges);
  assert.ok(s.cv < 0.35, `edge lengths vary by ${s.cv.toFixed(2)}`);
  assert.ok(s.minGap > 8, `nodes ${s.minGap.toFixed(1)} apart at closest`);
});

test('layout: connected nodes end up nearer than unconnected ones; a hub opens up its neighbours', () => {
  // Two stars joined by a bridge.
  const edges: LayoutEdge[] = [];
  for (let i = 1; i <= 12; i++) edges.push({ s: 0, t: i });
  for (let i = 14; i <= 25; i++) edges.push({ s: 13, t: i });
  edges.push({ s: 0, t: 13 });
  const l = new ForceLayout(26, edges);
  l.run(500);
  const d = (i: number, j: number) => Math.hypot(l.x[i]! - l.x[j]!, l.y[i]! - l.y[j]!);
  const near = (d(0, 1) + d(0, 2) + d(13, 14) + d(13, 15)) / 4;
  const far = (d(1, 14) + d(2, 15) + d(3, 16)) / 3;
  assert.ok(far > near * 1.5, `neighbours ${near.toFixed(0)} apart, strangers ${far.toFixed(0)}`);
  assert.ok(stats(l, edges).minGap > 6);
});

test('layout: a pinned node stays; reheating moves the rest; empty and single-node graphs are fine', () => {
  const l = new ForceLayout(5, ring(5));
  l.run(500);
  l.fixed[2] = 1;
  const [px, py] = [l.x[2]!, l.y[2]!];
  l.reheat(0.8);
  l.run(50);
  assert.deepEqual([l.x[2], l.y[2]], [px, py]);
  assert.equal(new ForceLayout(0, []).tick(), true);
  const one = new ForceLayout(1, []);
  one.run(100);
  assert.ok(Number.isFinite(one.x[0]!));
  // Coincident starting points don't blow up.
  const same = new ForceLayout(3, ring(3));
  same.x.fill(5);
  same.y.fill(5);
  same.run(100);
  assert.ok([...same.x].every(Number.isFinite));
});

test('layout: a graph at the display cap (1,500 nodes, 6,000 edges) settles within a few hundred ticks and the cost per tick is small', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const n = 1500;
  const edges: LayoutEdge[] = Array.from({ length: 6000 }, () => ({ s: Math.floor(rnd() * n), t: Math.floor(n * rnd() ** 3) })).filter((e) => e.s !== e.t);
  const l = new ForceLayout(n, edges);
  // CPU time of this process, not the wall clock: a loaded machine (the gate runs files in parallel) stretches the wall clock but not
  // the CPU time spent in the loop (T-638: the wall-clock budget flaked under load).
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  const ticks = l.run(400);
  const ms = performance.now() - t0;
  const c = process.cpuUsage(c0);
  const cpuMs = (c.user + c.system) / 1000;
  console.log(`layout: ${n} nodes, ${edges.length} edges: ${ticks} ticks in ${ms.toFixed(0)} ms wall, ${cpuMs.toFixed(0)} ms cpu (${(cpuMs / ticks).toFixed(2)} ms cpu a tick)`);
  assert.ok([...l.x, ...l.y].every(Number.isFinite));
  assert.ok(cpuMs / ticks < 25, `${(cpuMs / ticks).toFixed(1)} ms cpu a tick`);
  const [x0, y0, x1, y1] = l.bounds();
  assert.ok(x1 - x0 < 20_000 && y1 - y0 < 20_000, 'the graph stays in a sane area');
});

test('hit grid: the nearest node within reach, a bigger node reaches further, nothing when none is close', () => {
  const x = Float64Array.from([0, 100, 103, 500]);
  const y = Float64Array.from([0, 100, 100, 500]);
  const g = new HitGrid(x, y, 4);
  assert.equal(g.nearest(2, 1, () => 10), 0);
  assert.equal(g.nearest(101.5, 100, () => 10), 1, 'the nearer of two');
  assert.equal(g.nearest(50, 50, () => 10), -1);
  assert.equal(g.nearest(120, 100, (i) => (i === 2 ? 25 : 5)), 2);
  assert.equal(g.nearest(500, 530, () => 40, 60), 3);
});

test('layout: a graph of hubs linked to hubs (the case that once flew apart) stays together, and nodes on one spot come apart', () => {
  const hubs = 40;
  const leaves = 700;
  const edges: LayoutEdge[] = [];
  for (let a = 0; a < hubs; a++) for (let b = a + 1; b < hubs; b++) edges.push({ s: a, t: b, w: 1 + ((a * b) % 44) });
  for (let i = 0; i < leaves; i++) for (let k = 0; k < 3; k++) edges.push({ s: hubs + i, t: (i * 7 + k * 13) % hubs, w: 1 + (i % 5) });
  const l = new ForceLayout(hubs + leaves, edges);
  let worst = 0;
  for (let t = 0; t < 320; t++) {
    l.tick();
    for (let i = 0; i < l.n; i++) worst = Math.max(worst, Math.hypot(l.vx[i]!, l.vy[i]!));
  }
  assert.ok(worst <= 40.0001, `no node moves more than the step cap (${worst})`);
  assert.ok([...l.x, ...l.y].every(Number.isFinite));
  const [x0, y0, x1, y1] = l.bounds();
  assert.ok(Math.max(Math.abs(x0), Math.abs(y0), Math.abs(x1), Math.abs(y1)) < 1200, `stays near the middle: ${[x0, y0, x1, y1].map(Math.round)}`);
  assert.ok(l.settled);

  // Nodes started on exactly one spot are pushed apart (repulsion has no direction at distance zero).
  const same = new ForceLayout(30, []);
  for (let i = 0; i < 30; i++) {
    same.x[i] = 5;
    same.y[i] = 5;
  }
  same.run(200);
  let closest = Infinity;
  for (let i = 0; i < 30; i++) for (let j = i + 1; j < 30; j++) closest = Math.min(closest, Math.hypot(same.x[i]! - same.x[j]!, same.y[i]! - same.y[j]!));
  assert.ok(closest > 3, `closest pair ${closest}`);
});
