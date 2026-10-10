import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Where a ciphertext belongs. Bound into the encryption, so a value can't be moved to another row or column. */
export interface SecretSlot {
  table: string;
  row: string;
  column: string;
}

export class SecretKeyError extends Error {}

/** A value that this key can't open: wrong key, wrong slot, or tampered. */
export class SecretOpenError extends Error {}

/** `PORTAL_SECRET_KEY` is 32 random bytes in base64url (plain base64 is accepted too). */
export function parseSecretKey(raw: string, source = 'PORTAL_SECRET_KEY'): Buffer {
  const key = Buffer.from(raw.trim(), 'base64url');
  if (key.length !== KEY_BYTES)
    throw new SecretKeyError(`${source} must be ${KEY_BYTES} random bytes in base64url (got ${key.length} bytes).`);
  return key;
}

/** Reads the key from `PORTAL_SECRET_KEY` or the file in `PORTAL_SECRET_KEY_FILE`; null when neither is set. */
export function loadSecretKey(opts: { value?: string; file?: string }): Buffer | null {
  if (opts.value) return parseSecretKey(opts.value);
  if (opts.file) {
    let raw: string;
    try {
      raw = readFileSync(opts.file, 'utf8');
    } catch (e) {
      throw new SecretKeyError(`PORTAL_SECRET_KEY_FILE ${opts.file} can't be read: ${(e as Error).message}`);
    }
    return parseSecretKey(raw, `PORTAL_SECRET_KEY_FILE (${opts.file})`);
  }
  return null;
}

export function generateSecretKey(): string {
  return randomBytes(KEY_BYTES).toString('base64url');
}

const derive = (key: Buffer, info: string) => Buffer.from(hkdfSync('sha256', key, 'claudepilot', info, KEY_BYTES));

const slotData = (s: SecretSlot) => Buffer.from(`${s.table}\0${s.row}\0${s.column}`, 'utf8');

/**
 * Seals and opens secret values: AES-256-GCM under a key derived (HKDF-SHA256) from the portal's
 * secret key, with the slot as additional data. The envelope is `v1.<keyId>.<iv>.<ciphertext+tag>`
 * (base64url parts); the key ID tells which key sealed a value, so the key can be rotated.
 */
export class SecretBox {
  readonly keyId: string;
  readonly #dataKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== KEY_BYTES) throw new SecretKeyError(`Secret key must be ${KEY_BYTES} bytes.`);
    this.#dataKey = derive(masterKey, 'claudepilot/data-key/v1');
    this.keyId = createHash('sha256').update(derive(masterKey, 'claudepilot/key-id/v1')).digest('hex').slice(0, 12);
  }

  seal(plaintext: string, slot: SecretSlot): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#dataKey, iv);
    cipher.setAAD(slotData(slot));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return [VERSION, this.keyId, iv.toString('base64url'), body.toString('base64url')].join('.');
  }

  open(envelope: string, slot: SecretSlot): string {
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretOpenError('Not a sealed value this portal understands.');
    const [, keyId, ivPart, bodyPart] = parts as [string, string, string, string];
    if (keyId !== this.keyId) throw new SecretOpenError(`Sealed with another key (${keyId}).`);
    const iv = Buffer.from(ivPart, 'base64url');
    const body = Buffer.from(bodyPart, 'base64url');
    if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw new SecretOpenError('Sealed value is damaged.');
    const decipher = createDecipheriv('aes-256-gcm', this.#dataKey, iv);
    decipher.setAAD(slotData(slot));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretOpenError('Sealed value does not open with this key here (wrong key, wrong place, or tampered).');
    }
  }

  /** Which key sealed an envelope, without opening it. */
  static keyIdOf(envelope: string): string | null {
    const parts = envelope.split('.');
    return parts.length === 4 && parts[0] === VERSION ? parts[1]! : null;
  }
}
