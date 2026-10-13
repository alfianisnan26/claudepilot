// The Kubernetes manifest (docs/prd/targets-connect.md §13.5, FR50): what `GET /connect/v1/manifest` answers for a `kubernetes`
// enrollment and what `install.sh` pipes to `kubectl apply -f -`. Plain text built here (no YAML library: the output is fixed and a
// golden file pins it). Strings go through JSON.stringify, which is a valid YAML double-quoted scalar.
//
// - The Namespace is the FIRST document and ends at the first `---` line: the installer drops it when the namespace already exists, so
//   an existing namespace is never relabelled.
// - Namespaced objects only; the Role is the allowlist of §13.5 (the agent's proxy enforces appendix B on top of it). A namespace the
//   manifest creates enforces Pod Security `baseline`.
// - The token is in the Secret `claudepilot-agent-enroll` (the bearer that asked for this manifest; a used token is inert). The admin's
//   preview passes `<token>` instead.
// - Nothing here carries `claudepilot.managed`, so `KubernetesRuntime.list()` never sees the agent as a workspace.
import { CONNECT_AGENT_ENV, CONNECT_PROTOCOL } from '@portal/contracts';
import { FETCHER } from './fetcher.js';
import { namespaceOf, type PlanInput } from './plan.js';

export const AGENT_NAME = 'claudepilot-agent';
export const ENROLL_SECRET = 'claudepilot-agent-enroll';
export const IDENTITY_SECRET = 'claudepilot-agent-identity';
export const HEADERS_SECRET = 'claudepilot-agent-headers';
export const CA_CONFIGMAP = 'claudepilot-agent-ca';
export const PART_OF = 'claudepilot-connect';

/** The Role's rules (PRD §13.5): [apiGroup, resource, verbs]. The structure test reads this too. */
export const ROLE_RULES: [string, string[], string[]][] = [
  ['', ['pods'], ['get', 'list', 'watch']],
  ['', ['pods/exec'], ['create', 'get']],
  ['', ['persistentvolumeclaims'], ['get', 'list', 'create', 'delete']],
  ['', ['secrets'], ['get', 'list', 'create', 'update', 'patch', 'delete']],
  ['apps', ['deployments'], ['get', 'list', 'create', 'update', 'patch', 'delete']],
  ['apps', ['deployments/scale'], ['get', 'update', 'patch']],
  ['metrics.k8s.io', ['pods'], ['get', 'list']],
];

export interface ManifestInput extends PlanInput {
  /** The enrollment token to put in the Secret, or `<token>` for a preview. */
  token: string;
}

const q = (s: string) => JSON.stringify(s);
const list = (xs: string[]) => `[${xs.map(q).join(', ')}]`;

export function buildManifest(input: ManifestInput): string {
  const { target, options, bundle, config, token } = input;
  const ns = namespaceOf(input);
  const portal = target.portalUrl.replace(/\/+$/, '');
  const bundleUrl = `${portal}/connect/v1/agent/${encodeURIComponent(bundle.build)}/agent.mjs`;
  const ca = options.privateCa && config.caPem ? config.caPem : null;
  const labels = (extra: Record<string, string> = {}, indent = '    ') =>
    Object.entries({ 'app.kubernetes.io/name': AGENT_NAME, 'app.kubernetes.io/part-of': PART_OF, 'claudepilot.connect/target': target.id, ...extra })
      .map(([k, v]) => `${indent}${k}: ${q(v)}`)
      .join('\n');
  const meta = (name: string) => `metadata:\n  name: ${name}\n  namespace: ${q(ns)}\n  labels:\n${labels()}`;
  const env = (name: string, value: string) => `            - name: ${name}\n              value: ${q(value)}`;
  const security = [
    '          securityContext:',
    '            allowPrivilegeEscalation: false',
    '            readOnlyRootFilesystem: true',
    '            capabilities:',
    '              drop: ["ALL"]',
  ].join('\n');
  const resources = ['          resources:', '            requests: { cpu: "50m", memory: "128Mi" }', '            limits: { cpu: "500m", memory: "256Mi" }'].join('\n');
  const caEnv = ca ? [env('NODE_EXTRA_CA_CERTS', '/etc/claudepilot-ca/ca.pem'), env(CONNECT_AGENT_ENV.ca, '/etc/claudepilot-ca/ca.pem')] : [];
  const caMount = ca ? ['            - { name: ca, mountPath: /etc/claudepilot-ca, readOnly: true }'] : [];
  const docs: string[] = [];

  // Pod Security `baseline` (T6, checked on k3s 1.35: the agent and the workspace pods pass it): the second wall behind the agent's proxy, so a
  // Deployment made with the agent's Role can't ask for privileged mode, host paths or the host's network even if the proxy were bypassed.
  docs.push(['apiVersion: v1', 'kind: Namespace', 'metadata:', `  name: ${q(ns)}`, '  labels:', '    claudepilot.managed: "true"', '    pod-security.kubernetes.io/enforce: "baseline"'].join('\n'));
  docs.push(['apiVersion: v1', 'kind: ServiceAccount', meta(AGENT_NAME), 'automountServiceAccountToken: true'].join('\n'));
  docs.push(
    [
      'apiVersion: rbac.authorization.k8s.io/v1',
      'kind: Role',
      meta(AGENT_NAME),
      'rules:',
      ...ROLE_RULES.map(([group, resources, verbs]) => `  - apiGroups: [${q(group)}]\n    resources: ${list(resources)}\n    verbs: ${list(verbs)}`),
    ].join('\n'),
  );
  docs.push(
    [
      'apiVersion: rbac.authorization.k8s.io/v1',
      'kind: RoleBinding',
      meta(AGENT_NAME),
      'roleRef:',
      '  apiGroup: rbac.authorization.k8s.io',
      '  kind: Role',
      `  name: ${AGENT_NAME}`,
      'subjects:',
      '  - kind: ServiceAccount',
      `    name: ${AGENT_NAME}`,
      `    namespace: ${q(ns)}`,
    ].join('\n'),
  );
  docs.push(['apiVersion: v1', 'kind: Secret', meta(ENROLL_SECRET), 'type: Opaque', 'stringData:', `  token: ${q(token)}`].join('\n'));
  if (ca) docs.push(['apiVersion: v1', 'kind: ConfigMap', meta(CA_CONFIGMAP), 'data:', `  ca.pem: ${q(ca)}`].join('\n'));
  docs.push(
    [
      'apiVersion: apps/v1',
      'kind: Deployment',
      meta(AGENT_NAME),
      'spec:',
      '  replicas: 1',
      // Two pods would meet `already_connected`: the old one goes before the new one starts.
      '  strategy:',
      '    type: Recreate',
      '  selector:',
      '    matchLabels:',
      `      app.kubernetes.io/name: ${AGENT_NAME}`,
      `      claudepilot.connect/target: ${q(target.id)}`,
      '  template:',
      '    metadata:',
      // The command's enrollment: a new command changes the template, so `kubectl apply` restarts the agent with the new token (a revoked
      // or removed node then enrolls again with it; a healthy one reconnects with its own identity). T6 saw a new command change nothing.
      '      annotations:',
      `        claudepilot.connect/enrollment: ${q(input.enrollment.id)}`,
      '      labels:',
      labels({}, '        '),
      '    spec:',
      `      serviceAccountName: ${AGENT_NAME}`,
      '      automountServiceAccountToken: true',
      '      securityContext:',
      '        runAsNonRoot: true',
      '        runAsUser: 65534',
      '        runAsGroup: 65534',
      '        fsGroup: 65534',
      '        seccompProfile:',
      '          type: RuntimeDefault',
      '      initContainers:',
      // Fetches the bundle the plan pins and checks its sha256 before anything runs it. `upgrade` changes these two variables.
      '        - name: fetch',
      `          image: ${q(config.baseImage)}`,
      `          command: ["node", "-e", ${q(FETCHER)}, "$(${CONNECT_AGENT_ENV.bundleUrl})", "$(${CONNECT_AGENT_ENV.bundleSha256})", "/agent/agent.mjs"]`,
      '          env:',
      env(CONNECT_AGENT_ENV.bundleUrl, bundleUrl),
      env(CONNECT_AGENT_ENV.bundleSha256, bundle.sha256),
      env('NODE_USE_ENV_PROXY', '1'),
      env('PILOT_HEADERS_FILE', '/etc/claudepilot-headers/headers'),
      ...caEnv,
      security,
      resources,
      '          volumeMounts:',
      '            - { name: agent, mountPath: /agent }',
      '            - { name: headers, mountPath: /etc/claudepilot-headers, readOnly: true }',
      ...caMount,
      '      containers:',
      '        - name: agent',
      `          image: ${q(config.baseImage)}`,
      '          command: ["node", "/agent/agent.mjs", "run"]',
      '          env:',
      env(CONNECT_AGENT_ENV.url, portal),
      env(CONNECT_AGENT_ENV.mode, 'kubernetes'),
      env(CONNECT_AGENT_ENV.dataDir, '/var/lib/claudepilot-agent'),
      `            - name: ${CONNECT_AGENT_ENV.kubeNamespace}\n              valueFrom:\n                fieldRef: { fieldPath: metadata.namespace }`,
      env(CONNECT_AGENT_ENV.identitySecret, IDENTITY_SECRET),
      env(CONNECT_AGENT_ENV.nodeName, options.nodeName || target.id),
      env(CONNECT_AGENT_ENV.bundleUrl, bundleUrl),
      env(CONNECT_AGENT_ENV.bundleSha256, bundle.sha256),
      ...(/^http:/i.test(portal) ? [env(CONNECT_AGENT_ENV.allowHttp, '1')] : []),
      ...caEnv,
      `            - name: ${CONNECT_AGENT_ENV.enrollToken}\n              valueFrom:\n                secretKeyRef: { name: ${ENROLL_SECRET}, key: token, optional: true }`,
      `            - name: ${CONNECT_AGENT_ENV.headers}\n              valueFrom:\n                secretKeyRef: { name: ${HEADERS_SECRET}, key: headers, optional: true }`,
      security,
      resources,
      '          volumeMounts:',
      '            - { name: agent, mountPath: /agent, readOnly: true }',
      '            - { name: state, mountPath: /var/lib/claudepilot-agent }',
      '            - { name: tmp, mountPath: /tmp }',
      ...caMount,
      '      volumes:',
      '        - { name: agent, emptyDir: {} }',
      '        - { name: state, emptyDir: {} }',
      '        - { name: tmp, emptyDir: {} }',
      `        - name: headers\n          secret: { secretName: ${HEADERS_SECRET}, optional: true }`,
      ...(ca ? [`        - name: ca\n          configMap: { name: ${CA_CONFIGMAP} }`] : []),
    ].join('\n'),
  );
  return `# ClaudePilot agent for target ${target.id} (protocol ${CONNECT_PROTOCOL}, build ${bundle.build}). Namespaced objects only.\n${docs.join('\n---\n')}\n`;
}
