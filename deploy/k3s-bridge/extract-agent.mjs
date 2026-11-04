// Writes the Connect agent bundle (agent.mjs) out of the committed `apps/server/src/connect/agent.generated.ts`, for the cp-bridge image
// (deploy/k3s-build/bridge.Dockerfile, T-3699). The image takes the exact bytes the portal serves to every enrolled agent: no npm, no esbuild,
// no package token in the build. The text's SHA-256 must equal PILOT_AGENT_SHA256 in the same file, or nothing is written and it exits 1.
//   node deploy/k3s-bridge/extract-agent.mjs <agent.generated.ts> <out agent.mjs>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/** The bundle text and its declared hash, read from the generated module's source. Throws when the file is not that module. */
export function extractAgent(source) {
  const text = /^export const PILOT_AGENT = (".*");$/m.exec(source)?.[1];
  const sha256 = /^export const PILOT_AGENT_SHA256 = "([0-9a-f]{64})";$/m.exec(source)?.[1];
  if (!text || !sha256) throw new Error('not agent.generated.ts: PILOT_AGENT or PILOT_AGENT_SHA256 is missing');
  const bundle = JSON.parse(text);
  if (typeof bundle !== 'string') throw new Error('PILOT_AGENT is not a string');
  const actual = createHash('sha256').update(bundle, 'utf8').digest('hex');
  if (actual !== sha256) throw new Error(`checksum mismatch: PILOT_AGENT hashes to ${actual}, the file declares ${sha256}`);
  return { bundle, sha256 };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('usage: extract-agent.mjs <agent.generated.ts> <out agent.mjs>');
    process.exit(2);
  }
  try {
    const { bundle, sha256 } = extractAgent(readFileSync(src, 'utf8'));
    writeFileSync(out, bundle, { mode: 0o444 });
    console.log(`agent.mjs ${sha256.slice(0, 12)} (${Buffer.byteLength(bundle)} bytes)`);
  } catch (e) {
    console.error(`extract-agent: ${e.message}`);
    process.exit(1);
  }
}
