// Chat content: a message's attachments, from what the browser sends to what Claude reads and the transcript
// keeps (chat-sessions PRD FR30, FR31). The browser uploads each file first (uploads.ts) and names them
// in the message; an image attached inline as base64 (the API's way, and every test) is still accepted.
//
//   check   validates the list before anything is stored or sent (counts, sizes, ids) and resolves it;
//   stage   writes each uploaded file into the workspace so Claude can open it (stage.ts);
//   inline  the images Claude is shown directly, as base64 for the message line;
//   note    the lines that tell Claude where the files are and what it can do with them;
//   record  links what was sent to the chat (blobs, `chat_files`) and returns the fields of the user event.

import { readFileSync } from 'node:fs';
import { AppError } from '@isnanme/core';
import {
  CHAT_MAX_ATTACHMENT_TOTAL,
  CHAT_MAX_ATTACHMENTS,
  CHAT_MAX_IMAGE_TOTAL,
  CHAT_MAX_SENT_IMAGE_BYTES,
  type ChatFile,
  type ChatImage,
  type ChatUpload,
} from '@portal/contracts';
import type { Store } from '../../store/store.js';
import type { Workspaces } from '../../workspaces/manager.js';
import { decodeAttachments, saveBlob, type DecodedImage } from '../blobs.js';
import type { RawImage } from '../protocol.js';
import { stagedName } from './names.js';
import { consumeUploads, takeUploads, uploadPath } from './uploads.js';
import { recordFile, setFileEvent } from './records.js';
import { attachmentNote, stageFile, type NoteItem, type StageOptions } from './stage.js';
import { fileClass } from './sniff.js';

const invalid = (message: string) => new AppError('VALIDATION_FAILED', message, { details: { attachments: message } });

const sizeText = (bytes: number) => `${+(bytes / 1_000_000).toFixed(1)} MB`;

/** What Claude is told about a file it can't open at all, when that is worth saying. */
function limitOf(mediaType: string): string | undefined {
  if (mediaType.startsWith('audio/')) return 'you can’t hear it; run tools on it if needed';
  if (mediaType.startsWith('video/')) return 'you can’t watch or hear it; run tools on it if needed';
  return undefined;
}

/** A word for what a file is, in the note to Claude. */
function labelOf(f: ChatFile): string {
  const kind = fileClass(f.mediaType, f.name);
  return kind === 'sheet' ? 'spreadsheet' : kind === 'doc' ? 'document' : kind === 'file' ? 'binary file' : kind === 'text' ? 'text' : kind === 'pdf' ? 'PDF' : kind;
}

export interface Recorded {
  /** For the user event: the images (as `ChatImage`s) and the other files. */
  images: ChatImage[];
  files: ChatFile[];
  /** Once the event has its sequence number: the chat's file rows point at it. */
  link: (eventSeq: number) => void;
}

/** A message's attachments, checked and resolved; see the file's header for the steps. */
export class AttachmentPlan {
  readonly #store: Store;
  readonly #sessionId: string;
  readonly #inlineImages: DecodedImage[];
  readonly #uploads: ChatUpload[];
  /** Staged paths, by upload id, once {@link stage} has run. */
  readonly #paths = new Map<string, string>();

  constructor(store: Store, sessionId: string, inlineImages: DecodedImage[], uploads: ChatUpload[]) {
    this.#store = store;
    this.#sessionId = sessionId;
    this.#inlineImages = inlineImages;
    this.#uploads = uploads;
  }

  /** How many attachments the message carries. */
  get count(): number {
    return this.#inlineImages.length + this.#uploads.length;
  }

  /** Whether any file has to be written into the workspace (only uploads are). */
  get needsStaging(): boolean {
    return this.#uploads.length > 0;
  }

  /** Writes each uploaded file into the session's uploads folder in the workspace, a few at a time (a file attached twice is written once). */
  async stage(workspaces: Workspaces, workspaceId: string, opts: StageOptions = {}): Promise<void> {
    const byName = new Map<string, ChatUpload[]>();
    for (const u of this.#uploads) {
      const staged = stagedName(u.name, u.blobId);
      byName.set(staged, [...(byName.get(staged) ?? []), u]);
    }
    const queue = [...byName.entries()];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [staged, uploads] = next;
        const blobPath = uploadPath(this.#store, uploads[0]!.blobId);
        if (!blobPath) throw new AppError('VALIDATION_FAILED', `“${uploads[0]!.name}” is no longer there. Attach it again.`, { details: { attachments: 'Missing file.' } });
        const path = await stageFile(workspaces, workspaceId, this.#sessionId, { blobPath, staged }, opts);
        for (const u of uploads) this.#paths.set(u.id, path);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  }

  /** The images Claude is shown directly: inline ones and uploaded ones it can take. */
  inline(): RawImage[] {
    const out: RawImage[] = this.#inlineImages.map((i) => ({ mediaType: i.mediaType, dataBase64: i.dataBase64 }));
    for (const u of this.#uploads) {
      if (u.reach !== 'sees') continue;
      const path = uploadPath(this.#store, u.blobId);
      if (!path) throw new AppError('VALIDATION_FAILED', `“${u.name}” is no longer there. Attach it again.`, { details: { attachments: 'Missing file.' } });
      out.push({ mediaType: u.mediaType, dataBase64: readFileSync(path).toString('base64') });
    }
    return out;
  }

  /** What Claude reads after the person's words: where each uploaded file is, and what it can do with it. */
  note(): string {
    const items: NoteItem[] = [];
    for (const u of this.#uploads) {
      const path = this.#paths.get(u.id);
      if (!path) continue;
      items.push({ path, reach: u.reach ?? 'path', label: labelOf(u), size: u.size, shown: u.reach === 'sees', limit: limitOf(u.mediaType) });
    }
    return attachmentNote(items);
  }

  /** The text Claude reads: the person's words, then the note that says where their files are (when there are any). */
  withNote(text: string): string {
    const note = this.note();
    return note ? `${text}${text.trim() ? '\n\n' : ''}${note}` : text;
  }

  /** The message reached Claude: the uploads it named are spent. (Until then they wait, so a retry can send them again.) */
  done(): void {
    consumeUploads(this.#store, this.#sessionId, this.#uploads.map((u) => u.id));
  }

  /** Links everything sent to the chat; the blobs of uploads are already stored, an inline image is stored now. Call {@link done} once the message is sent. */
  record(): Recorded {
    const images: ChatImage[] = [];
    const files: ChatFile[] = [];
    const rows: number[] = [];
    for (const i of this.#inlineImages) images.push(saveBlob(this.#store, this.#sessionId, 'upload', i.name, i.mediaType, i.bytes));
    for (const u of this.#uploads) {
      const { id: _id, ...file } = u;
      const withPath: ChatFile = { ...file, path: this.#paths.get(u.id) };
      if (!withPath.path) delete withPath.path;
      rows.push(recordFile(this.#store, this.#sessionId, 'upload', withPath));
      if (u.preview === 'image' && u.mediaType !== 'image/svg+xml') {
        const image: ChatImage = { blobId: u.blobId, mediaType: u.mediaType, name: u.name };
        if (u.width && u.height) {
          image.width = u.width;
          image.height = u.height;
        }
        images.push(image);
      } else files.push(file);
    }
    return { images, files, link: (seq) => setFileEvent(this.#store, rows, seq) };
  }
}

/**
 * Checks a message's `attachments` and resolves them: inline images the way they always were (at most four,
 * each within the old limit: they ride the socket), uploaded files by the ids the browser got back. A bad one
 * throws a validation error that says which and why; nothing has been stored or sent yet.
 */
export function checkAttachments(store: Store, sessionId: string, list: unknown): AttachmentPlan {
  if (list === undefined || list === null) return new AttachmentPlan(store, sessionId, [], []);
  if (!Array.isArray(list)) throw invalid('Attachments must be a list of files.');
  if (list.length > CHAT_MAX_ATTACHMENTS) throw invalid(`Attach at most ${CHAT_MAX_ATTACHMENTS} files to one message.`);
  const isRef = (a: unknown): a is { uploadId: string } => !!a && typeof a === 'object' && typeof (a as { uploadId?: unknown }).uploadId === 'string';
  const inline = decodeAttachments(list.filter((a) => !isRef(a)));
  const ids = [...new Set(list.filter(isRef).map((a) => a.uploadId))];
  const uploads = ids.length ? takeUploads(store, sessionId, ids) : [];

  const total = uploads.reduce((n, u) => n + u.size, 0) + inline.reduce((n, i) => n + i.bytes.length, 0);
  if (total > CHAT_MAX_ATTACHMENT_TOTAL) throw invalid(`Attachments can be up to ${CHAT_MAX_ATTACHMENT_TOTAL / 1_000_000} MB in all (these are ${sizeText(total)}).`);
  const shown = uploads.filter((u) => u.reach === 'sees');
  const imageBytes = shown.reduce((n, u) => n + u.size, 0) + inline.reduce((n, i) => n + i.bytes.length, 0);
  if (imageBytes > CHAT_MAX_IMAGE_TOTAL) throw invalid(`Images can be up to ${CHAT_MAX_IMAGE_TOTAL / 1_000_000} MB in all (these are ${sizeText(imageBytes)}).`);
  if (shown.some((u) => u.size > CHAT_MAX_SENT_IMAGE_BYTES)) throw invalid(`An image can be up to ${CHAT_MAX_SENT_IMAGE_BYTES / 1_000_000} MB.`);
  return new AttachmentPlan(store, sessionId, inline, uploads);
}
