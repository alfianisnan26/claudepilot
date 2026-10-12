// The push keys (docs/prd/web-app-pwa.md §11.4, owner decision O4): one VAPID key pair (P-256) and one random topic key, made on first
// use and SEALED at rest with the portal's secret key (`notify_keys`, platform-wide). A Locked portal cannot open them and so sends
// nothing. The public key is kept in clear beside the sealed private key: it is public by design (a browser subscribes with it).

import { createPrivateKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import type { Store } from '../store/store.js';
import { rawPublicKey } from './webpush.js';

export interface PushKeys {
  privateKey: KeyObject;
  publicKey: Buffer;
  topicKey: Buffer;
}

const slot = (id: string) => ({ table: 'notify_keys', row: id, column: 'value' });

export class NotifyKeys {
  #cache: PushKeys | null = null;
  #box: unknown = null;

  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The public key a browser subscribes with (base64url), without making one; null before the first. */
  publicKey(): string | null {
    const row = this.store.db?.prepare("SELECT public_key FROM notify_keys WHERE id = 'vapid'").get() as { public_key: string | null } | undefined;
    return row?.public_key ?? null;
  }

  /** The keys, made on first use; null while Locked or Frozen or when the database cannot be written to make them. */
  keys(create = true): PushKeys | null {
    const box = this.store.secrets;
    const db = this.store.db;
    if (!box || !db || this.store.trust.state !== 'ok') return null;
    if (this.#cache && this.#box === box) return this.#cache;
    const read = (id: string) => {
      const r = db.prepare('SELECT value, public_key FROM notify_keys WHERE id = ?').get(id) as { value: string | null; public_key: string | null } | undefined;
      return r?.value ? { value: r.value, public_key: r.public_key } : undefined;
    };
    let vapid = read('vapid');
    let topic = read('topic');
    if ((!vapid || !topic) && create && this.store.writable) {
      const at = this.now().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        vapid = read('vapid');
        topic = read('topic');
        if (!vapid) {
          db.prepare("DELETE FROM notify_keys WHERE id = 'vapid'").run(); // forgotten (NULL): made again
          const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
          const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
          const pub = rawPublicKey(privateKey).toString('base64url');
          db.prepare('INSERT INTO notify_keys (id, value, public_key, created_at) VALUES (?, ?, ?, ?)').run('vapid', box.seal(pkcs8, slot('vapid')), pub, at);
        }
        if (!topic) db.prepare("DELETE FROM notify_keys WHERE id = 'topic'").run();
        if (!topic) db.prepare('INSERT INTO notify_keys (id, value, public_key, created_at) VALUES (?, ?, NULL, ?)').run('topic', box.seal(randomBytes(32).toString('base64url'), slot('topic')), at);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      vapid = read('vapid');
      topic = read('topic');
    }
    if (!vapid || !topic) return null;
    try {
      const privateKey = createPrivateKey({ key: Buffer.from(box.open(vapid.value, slot('vapid')), 'base64url'), format: 'der', type: 'pkcs8' });
      this.#cache = { privateKey, publicKey: rawPublicKey(privateKey), topicKey: Buffer.from(box.open(topic.value, slot('topic')), 'base64url') };
      this.#box = box;
      return this.#cache;
    } catch {
      return null; // sealed under another key: as good as Locked
    }
  }
}
