import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const s = promisify(scrypt);
const salt = randomBytes(16);
const cases = [
  { N: 2 ** 14, r: 8, p: 1 },
  { N: 2 ** 15, r: 8, p: 1 },
  { N: 2 ** 16, r: 8, p: 1 },
  { N: 2 ** 17, r: 8, p: 1 },
];
for (const { N, r, p } of cases) {
  const maxmem = 128 * N * r * 2;
  const t = [];
  for (let i = 0; i < 4; i++) {
    const t0 = performance.now();
    await s('correct horse battery staple', salt, 32, { N, r, p, maxmem });
    t.push(performance.now() - t0);
  }
  console.log(`N=2^${Math.log2(N)} r=${r} p=${p} mem=${(128 * N * r) / 1048576} MiB  ms: ${t.map((x) => x.toFixed(0)).join(' ')}`);
}
// concurrency: 4 parallel hashes at N=2^15 (event-loop and threadpool behaviour)
const N = 2 ** 15, r = 8, p = 1;
let max = 0, last = performance.now();
const tick = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last - 10); last = n; }, 10);
const t0 = performance.now();
await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => s('pw', salt, 32, { N, r, p, maxmem: 128 * N * r * 2 })));
clearInterval(tick);
console.log(`8 parallel N=2^15: total ${(performance.now() - t0).toFixed(0)} ms, worst event-loop stall ${max.toFixed(0)} ms`);
