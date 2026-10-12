// What the agent keeps (docs/prd/targets-connect.md §10.3): its node identity, with the private key it made itself. The portal stores only
// the public half. Two stores: files (a host's `~/.claudepilot/agent/`, a container's state volume) and, in Kubernetes, a Secret
// (kubeapi.ts). Both hold `identity.json` and, during a key rotation (§10.4), `identity.next.json`.
//
// Every write is atomic (a temporary file in the same folder, fsync, rename) and the files are mode 0600 in a 0700 folder, so a crash
// leaves either the old identity or the new one, never half of one.
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fromB64u, keyFingerprint, publicKeyOf } from '../tunnel/auth.js';

export interface Identity {
  node: string;
  target: string;
  portalUrl: string;
  /** The portal's id, pinned at the first `welcome` (null before it). */
  portalId: string | null;
  /** PKCS8 DER, base64url. */
  privateKey: string;
  /** The raw 32 bytes, base64url. */
  publicKey: string;
  enrolledAt: string;
}

export class IdentityError extends Error {
  override readonly name = 'IdentityError';
}

export const fingerprintOf = (identity: Pick<Identity, 'publicKey'>): string => keyFingerprint(identity.publicKey);

/** Parses and checks an identity file's text: every field present, the keys consistent. Never echoes the key in an error. */
export function parseIdentity(text: string): Identity {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new IdentityError('The identity file is not valid JSON.');
  }
  const o = raw as Record<string, unknown> | null;
  const str = (k: string) => (typeof o?.[k] === 'string' && (o[k] as string).length > 0 ? (o[k] as string) : null);
  const node = str('node');
  const target = str('target');
  const portalUrl = str('portalUrl');
  const privateKey = str('privateKey');
  const publicKey = str('publicKey');
  const enrolledAt = str('enrolledAt');
  if (!node || !target || !portalUrl || !privateKey || !publicKey || !enrolledAt) throw new IdentityError('The identity file is missing a field.');
  const portalId = typeof o!.portalId === 'string' && o!.portalId ? (o!.portalId as string) : null;
  try {
    if (fromB64u(publicKey).length !== 32 || publicKeyOf(privateKey) !== publicKey) throw new Error('mismatch');
  } catch {
    throw new IdentityError('The identity file’s keys do not match each other.');
  }
  return { node, target, portalUrl, portalId, privateKey, publicKey, enrolledAt };
}

export const identityText = (identity: Identity): string => `${JSON.stringify(identity, null, 2)}\n`;

export interface IdentityStore {
  /** The current identity, or null when the agent has never enrolled. Throws IdentityError when the stored one is damaged. */
  load(): Promise<Identity | null>;
  /** The identity of a key rotation in progress, or null. A damaged one reads as null (the rotation is simply abandoned). */
  loadNext(): Promise<Identity | null>;
  save(identity: Identity): Promise<void>;
  saveNext(identity: Identity): Promise<void>;
  /** `next` becomes the current identity and is removed. */
  promoteNext(): Promise<Identity | null>;
  dropNext(): Promise<void>;
  /** Where it lives, for logs and `doctor` (never a secret). */
  describe(): string;
}

/** Writes `data` to `path` atomically with `mode`. */
export async function writeFileAtomic(path: string, data: string, mode = 0o600): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'wx', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  await rename(tmp, path);
}

export class FileIdentityStore implements IdentityStore {
  readonly #file: string;
  readonly #next: string;

  constructor(readonly dir: string) {
    this.#file = join(dir, 'identity.json');
    this.#next = join(dir, 'identity.next.json');
  }

  describe(): string {
    return this.#file;
  }

  async #read(path: string): Promise<Identity | null> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    return parseIdentity(text);
  }

  load(): Promise<Identity | null> {
    return this.#read(this.#file);
  }

  async loadNext(): Promise<Identity | null> {
    try {
      return await this.#read(this.#next);
    } catch {
      return null;
    }
  }

  async #write(path: string, identity: Identity): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, identityText(identity));
  }

  save(identity: Identity): Promise<void> {
    return this.#write(this.#file, identity);
  }

  saveNext(identity: Identity): Promise<void> {
    return this.#write(this.#next, identity);
  }

  async promoteNext(): Promise<Identity | null> {
    const next = await this.loadNext();
    if (!next) return null;
    await rename(this.#next, this.#file);
    return next;
  }

  async dropNext(): Promise<void> {
    await rm(this.#next, { force: true });
  }

  /** The file's permission bits, for `doctor` (null when there is no file). */
  async mode(): Promise<number | null> {
    try {
      return (await stat(this.#file)).mode & 0o777;
    } catch {
      return null;
    }
  }
}
