// The pure parts of tools/qa/bridge-rig.mjs (PILOT-1142): the preflight that decides between "run" and "skip, because…", the bridge
// Deployment rendered into a rig namespace, and the numbers. No I/O of its own: the caller passes what it runs, so bridge-rig.test.mjs
// checks every skip reason without a cluster.
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** A rig namespace as scripts/dev-rig.sh names one. Nothing else is ever touched by the e2e. */
export const RIG_NAME = /^dev-rig-[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/;

/**
 * Whether the rig e2e can run, or why not. `run(args)` runs kubectl with the rig kubeconfig and answers `{ code, stdout }` (never throws).
 * Every refusal is a skip with a plain reason, except a namespace that is not a rig name or the operator's own kubeconfig: those are
 * errors (`fatal`), because running would touch something that is not a rig.
 */
export function rigPreflight({ ns, kubeconfig, image, home = homedir() }, run) {
  if (!RIG_NAME.test(ns ?? '')) return { fatal: `BRIDGE_RIG_NS must be a rig namespace (dev-rig-<name>), not "${ns ?? ''}"` };
  if (!kubeconfig) return { skip: 'no rig kubeconfig: set BRIDGE_RIG_KUBECONFIG to the cp-bridge rig account\'s kubeconfig (T-3700, FOR THE COORDINATOR)' };
  if (resolve(kubeconfig) === resolve(home, '.kube/config')) return { fatal: 'BRIDGE_RIG_KUBECONFIG is ~/.kube/config: the rig runs only on the rig account\'s own kubeconfig' };
  if (!image) return { skip: 'no bridge image: set BRIDGE_RIG_IMAGE to a cp-bridge:<sha> built by deploy/k3s-build/bridge-job.yaml (PILOT-1141)' };
  const label = run(['get', 'namespace', ns, '-o', 'jsonpath={.metadata.labels.claudepilot\\.rig}']);
  if (label.code !== 0) return { skip: `the rig namespace ${ns} is not there or not readable with this kubeconfig (scripts/dev-rig.sh create ${ns})` };
  if (label.stdout.trim() !== 'true') return { fatal: `${ns} is not labelled claudepilot.rig=true: not a rig, refusing to use it` };
  for (const [verb, resource] of [['create', 'deployments'], ['delete', 'deployments'], ['create', 'secrets'], ['create', 'pods/exec']]) {
    const can = run(['auth', 'can-i', verb, resource, '-n', ns]);
    if (can.stdout.trim() !== 'yes') return { skip: `the rig account may not ${verb} ${resource} in ${ns} (T-3700, FOR THE COORDINATOR)` };
  }
  return { ok: true };
}

/**
 * deploy/k3s-bridge/bridge.yaml, made to run in the rig: the rig namespace for the Deployment and the one namespace it serves, the given
 * image, the scratch portal as PILOT_URL, no further namespaces. Throws when a live namespace name is left in it.
 */
export function renderBridge(yaml, { ns, image, portalUrl }) {
  if (!RIG_NAME.test(ns)) throw new Error(`not a rig namespace: ${ns}`);
  const lines = yaml.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The further namespaces (PILOT_KUBE_NAMESPACES and its value line) are live ones: the rig bridge serves its own namespace only.
    if (/- name: PILOT_KUBE_NAMESPACES$/.test(line)) {
      i++;
      continue;
    }
    out.push(line);
  }
  let text = out.join('\n');
  text = text.replace(/^(\s*namespace:) isnan-cp-bridge$/m, `$1 ${ns}`);
  text = text.replace(/registry\.int\.isnan\.me\/cp-bridge:COMMIT/, image);
  text = text.replace(/(- name: PILOT_URL\n\s*value: )"[^"]*"/, `$1${JSON.stringify(portalUrl)}`);
  text = text.replace(/(- name: PILOT_KUBE_NAMESPACE\n\s*value: )"[^"]*"/, `$1${JSON.stringify(ns)}`);
  // The scratch portal speaks plain http on the pod network (PORTAL_CONNECT_ALLOW_HTTP); the agent must be told it may.
  if (portalUrl.startsWith('http:')) text = text.replace(/(\n(\s*)- name: PILOT_MODE\n)/, `\n$2- name: PILOT_ALLOW_HTTP\n$2  value: "1"$1`);
  const live = text.split('\n').filter((l) => !l.trim().startsWith('#') && /\bisnan-(claudepilot|pilot-ws|cp-bridge)/.test(l));
  if (live.length) throw new Error(`a live namespace is left in the rendered bridge: ${live.join(' | ')}`);
  for (const must of [`namespace: ${ns}`, image, JSON.stringify(portalUrl)]) if (!text.includes(must)) throw new Error(`the rendered bridge lacks ${must}`);
  return text;
}

/** The Secret the bridge enrolls with: a manifest for `kubectl apply -f -` (stdin), so the token never sits in an argument list. */
export const enrollSecret = (ns, token) =>
  JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'cp-bridge-enroll', namespace: ns, labels: { 'app.kubernetes.io/part-of': 'cp-bridge' } }, type: 'Opaque', stringData: { token } });

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
