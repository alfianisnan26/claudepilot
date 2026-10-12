import { readFileSync } from 'node:fs';
import { blobFileFor } from '../chat/artifacts/index.js';
import type { Store } from '../store/store.js';

/** The bytes of a file this chat session links in the blob store (an image it showed, an artifact), or null: not its file, gone, or over `maxBytes`. */
export function readSessionBlob(store: Store, sessionId: string, blobId: string, maxBytes: number): Buffer | null {
  const file = blobFileFor(store, sessionId, blobId);
  if (!file || file.size > maxBytes) return null;
  try {
    return readFileSync(file.path);
  } catch {
    return null;
  }
}
