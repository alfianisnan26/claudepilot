// Which clusters may dial /bridge (PILOT-1144, D3, D4). The registry is the `BRIDGE_CLUSTERS` secret, a JSON object
//   { "<cluster>": { "node": "nd_…", "publicKey": "<raw Ed25519, base64url>", "tokenSha256": "<hex of SHA-256(bearer token)>" } }
// Only the token's hash is held. No secret, no registry: every dial is refused (fail closed). It is never in wrangler.jsonc.

import { connectPublicKeyProblem, connectSha256Hex, connectTimingSafeEqual } from '@portal/contracts';

export interface BridgeCluster {
  node: string;
  /** The cp-bridge's Ed25519 public key, raw 32 bytes, base64url. */
  publicKey: string;
  tokenSha256: string;
}

/** A cluster name: a lowercase DNS label (it names the Durable Object). */
export const BRIDGE_CLUSTER_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NODE_RE = /^nd_[A-Za-z0-9_-]{1,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** Compared against when the cluster is unknown, so a miss costs the same as a wrong token. */
const NO_HASH = '0'.repeat(64);

let cached: { raw: string; map: Map<string, BridgeCluster> } | null = null;

/** The registry, or an empty one when the secret is absent or malformed (a malformed entry, a bad or small-order key included, is dropped). */
export function bridgeRegistry(raw: string | undefined): Map<string, BridgeCluster> {
  if (!raw) return new Map();
  if (cached?.raw === raw) return cached.map;
  const map = new Map<string, BridgeCluster>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('bridge: BRIDGE_CLUSTERS is not JSON; every dial is refused');
    parsed = null;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<BridgeCluster> | null;
      // The portal's key check (enrollment, re-key; held equal in connectSign.test.ts): a small-order key verifies signatures nobody made.
      const keyOk = connectPublicKeyProblem(e?.publicKey) === null;
      if (
        BRIDGE_CLUSTER_RE.test(name) &&
        e &&
        typeof e.node === 'string' &&
        NODE_RE.test(e.node) &&
        keyOk &&
        typeof e.tokenSha256 === 'string' &&
        SHA256_RE.test(e.tokenSha256)
      ) {
        map.set(name, { node: e.node, publicKey: e.publicKey!, tokenSha256: e.tokenSha256 });
      } else {
        console.error('bridge: a BRIDGE_CLUSTERS entry is malformed and was dropped');
      }
    }
  }
  cached = { raw, map };
  return map;
}

/** The cluster the bearer token opens, or null. The work is the same for an unknown cluster, a wrong token and a right one. */
export async function bridgeAuthorize(raw: string | undefined, cluster: string, token: string): Promise<BridgeCluster | null> {
  const entry = BRIDGE_CLUSTER_RE.test(cluster) ? (bridgeRegistry(raw).get(cluster) ?? null) : null;
  const presented = await connectSha256Hex(token);
  const match = connectTimingSafeEqual(presented, entry?.tokenSha256 ?? NO_HASH);
  return entry && match && token.length > 0 ? entry : null;
}
