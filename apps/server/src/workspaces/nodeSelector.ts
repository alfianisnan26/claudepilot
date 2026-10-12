// `PORTAL_K8S_NODE_SELECTOR`: which nodes workspace pods may run on, as `key=value[,key=value]` (for example
// `kubernetes.io/hostname=k3s-node2`). Unset: the scheduler decides. A malformed value stops the portal at start.

const KEY = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/;

export function parseNodeSelector(text: string | undefined): Record<string, string> | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const out: Record<string, string> = {};
  for (const part of text.split(',')) {
    const entry = part.trim();
    const eq = entry.indexOf('=');
    const key = eq < 0 ? '' : entry.slice(0, eq).trim();
    const value = eq < 0 ? '' : entry.slice(eq + 1).trim();
    if (eq < 0 || !KEY.test(key) || key.length > 253 || !VALUE.test(value)) {
      throw new Error(`PORTAL_K8S_NODE_SELECTOR is not usable: "${entry.slice(0, 60)}" is not key=value (a Kubernetes label).`);
    }
    out[key] = value;
  }
  return out;
}
