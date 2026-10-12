// The identity in a Kubernetes Secret (docs/prd/targets-connect.md §10.3, §13.5): a pod's filesystem is gone with the pod, so the agent keeps
// `identity.json` (and, during a rotation, `identity.next.json`) in the Secret `claudepilot-agent-identity` of its own namespace, which the
// Role lets it read and write. After a restart the agent finds the Secret and does not enroll again. The agent's calls here are its own,
// made with its service account: they do not go through the portal-facing proxy (whose allowlist, rightly, does not include this Secret).
import { IdentityError, identityText, parseIdentity, type Identity, type IdentityStore } from './identity.js';

export type KubeApiCall = (method: string, path: string, opts?: { body?: string; headers?: Record<string, string> }) => Promise<{ status: number; body: Buffer }>;

interface SecretDoc {
  metadata?: { name?: string; resourceVersion?: string; labels?: Record<string, string> };
  data?: Record<string, string>;
}

export class KubeSecretIdentityStore implements IdentityStore {
  constructor(
    private readonly api: KubeApiCall,
    private readonly namespace: string,
    private readonly secret: string,
  ) {}

  describe(): string {
    return `Secret ${this.namespace}/${this.secret}`;
  }

  get #path() {
    return `/api/v1/namespaces/${encodeURIComponent(this.namespace)}/secrets`;
  }

  async #get(): Promise<SecretDoc | null> {
    const res = await this.api('GET', `${this.#path}/${encodeURIComponent(this.secret)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`The API server answered ${res.status} for the identity Secret.`);
    return JSON.parse(res.body.toString('utf8')) as SecretDoc;
  }

  async #read(key: string): Promise<Identity | null> {
    const doc = await this.#get();
    const value = doc?.data?.[key];
    if (!value) return null;
    return parseIdentity(Buffer.from(value, 'base64').toString('utf8'));
  }

  load(): Promise<Identity | null> {
    return this.#read('identity.json');
  }

  async loadNext(): Promise<Identity | null> {
    try {
      return await this.#read('identity.next.json');
    } catch {
      return null;
    }
  }

  /** Read, change one key, write back (a conflict is retried: another writer is the same agent, a moment ago). */
  async #write(change: (data: Record<string, string>) => void, target: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = await this.#get();
      const data = { ...(doc?.data ?? {}) };
      change(data);
      const body = JSON.stringify({
        apiVersion: 'v1',
        kind: 'Secret',
        type: 'Opaque',
        metadata: {
          name: this.secret,
          namespace: this.namespace,
          labels: { 'app.kubernetes.io/part-of': 'claudepilot-connect', 'claudepilot.connect/target': target, ...(doc?.metadata?.labels ?? {}) },
          ...(doc?.metadata?.resourceVersion ? { resourceVersion: doc.metadata.resourceVersion } : {}),
        },
        data,
      });
      const res = doc
        ? await this.api('PUT', `${this.#path}/${encodeURIComponent(this.secret)}`, { body, headers: { 'content-type': 'application/json' } })
        : await this.api('POST', this.#path, { body, headers: { 'content-type': 'application/json' } });
      if (res.status === 200 || res.status === 201) return;
      if (res.status !== 409) throw new Error(`The API server answered ${res.status} writing the identity Secret.`);
    }
    throw new Error('The identity Secret kept changing under the agent.');
  }

  save(identity: Identity): Promise<void> {
    return this.#write((d) => (d['identity.json'] = Buffer.from(identityText(identity)).toString('base64')), identity.target);
  }

  saveNext(identity: Identity): Promise<void> {
    return this.#write((d) => (d['identity.next.json'] = Buffer.from(identityText(identity)).toString('base64')), identity.target);
  }

  async promoteNext(): Promise<Identity | null> {
    const next = await this.loadNext();
    if (!next) return null;
    await this.#write((d) => {
      d['identity.json'] = Buffer.from(identityText(next)).toString('base64');
      delete d['identity.next.json'];
    }, next.target);
    return next;
  }

  async dropNext(): Promise<void> {
    const doc = await this.#get();
    if (!doc?.data?.['identity.next.json']) return;
    await this.#write((d) => void delete d['identity.next.json'], doc.metadata?.labels?.['claudepilot.connect/target'] ?? '');
  }
}

export { IdentityError };
