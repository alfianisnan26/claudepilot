// Writes src/connect/node-manifest.json (docs/prd/targets-connect.md §13.4): the official Node.js tarballs a Host install downloads when
// the machine has no Node 22.13+, pinned by the sha256s nodejs.org publishes, and the pty package's exact version and npm integrity from
// the lockfile. Run it to move to a newer Node 22 and commit the result (src/connect/install/plan.test.ts checks its shape):
//   npm run gen:connect-node -w @portal/server [-- v22.x.y]
import { readFileSync, writeFileSync } from 'node:fs';

const MIRROR = 'https://nodejs.org/dist';
const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const;
const PTY = '@lydell/node-pty';

async function latest22(): Promise<string> {
  const res = await fetch(`${MIRROR}/index.json`);
  if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
  const all = (await res.json()) as { version: string }[];
  const v = all.find((r) => r.version.startsWith('v22.'));
  if (!v) throw new Error('no Node 22 release listed');
  return v.version;
}

const version = process.argv[2] ?? (await latest22());
if (!/^v22\.\d+\.\d+$/.test(version)) throw new Error(`not a Node 22 version: ${version}`);
const res = await fetch(`${MIRROR}/${version}/SHASUMS256.txt`);
if (!res.ok) throw new Error(`SHASUMS256.txt: HTTP ${res.status}`);
const sums = new Map((await res.text()).split('\n').map((l) => l.trim().split(/\s+/).reverse() as [string, string]));
const sha256: Record<string, string> = {};
for (const p of PLATFORMS) {
  const file = `node-${version}-${p}.tar.gz`;
  const s = sums.get(file);
  if (!s || !/^[0-9a-f]{64}$/.test(s)) throw new Error(`no sha256 for ${file}`);
  sha256[p] = s;
}

const lock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8')) as {
  packages: Record<string, { version?: string; integrity?: string }>;
};
const entry = (name: string) => {
  const e = lock.packages[`node_modules/${name}`];
  if (!e?.version || !e.integrity) throw new Error(`${name} is not in package-lock.json`);
  return e as { version: string; integrity: string };
};
const main = entry(PTY);
const integrity: Record<string, string> = { main: main.integrity };
for (const p of PLATFORMS) {
  const e = entry(`${PTY}-${p}`);
  if (e.version !== main.version) throw new Error(`${PTY}-${p} is ${e.version}, ${PTY} is ${main.version}`);
  integrity[p] = e.integrity;
}

const manifest = { node: { version: version.slice(1), sha256 }, pty: { name: PTY, version: main.version, integrity } };
const out = new URL('../src/connect/node-manifest.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote src/connect/node-manifest.json (Node ${version}, ${PTY} ${main.version})`);
