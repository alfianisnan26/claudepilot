// Chat content in the browser (chat-sessions PRD FR30-FR33): uploading what you attach, and where files are
// read from. An upload is an XHR rather than a fetch so the browser reports its progress and it can be cancelled.

import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { CHAT_API, CHAT_CONTENT_API, type ChatTextPreview, type ChatUpload } from '@portal/contracts';
import { ApiError } from '@/lib/api';

export interface UploadHandle {
  promise: Promise<ChatUpload>;
  /** Stops it; the promise rejects with an `AbortError`. */
  abort: () => void;
}

/** Sends one file to a chat as the raw request body; `onProgress` gets bytes sent and the total. */
export function uploadFile(sessionId: string, blob: Blob, name: string, onProgress: (sent: number, total: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<ChatUpload>((resolve, reject) => {
    xhr.open('POST', CHAT_CONTENT_API.upload(sessionId));
    xhr.responseType = 'json';
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    // Always opaque bytes, whatever the file is: the portal sniffs the type itself, and a body announced as JSON (a .json file) would be held to the 4 MB JSON limit and parsed.
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    xhr.onload = () => {
      const json: unknown = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300 && isApiSuccess<ChatUpload>(json)) return resolve(json.data);
      if (isApiErrorBody(json)) return reject(new ApiError(json.error.code, json.error.message, xhr.status, json.error.details));
      reject(new ApiError('INTERNAL_ERROR', xhr.status === 413 ? 'That file is too large.' : `The upload failed (${xhr.status}).`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.send(blob);
  });
  return { promise, abort: () => xhr.abort() };
}

/** Tells the portal an attachment was removed before it was sent (best effort: it would expire anyway). */
export function discardUpload(sessionId: string, uploadId: string): void {
  void fetch(CHAT_CONTENT_API.uploadOne(sessionId, uploadId), { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined);
}

/** A text file's start, secrets hidden. */
export async function fetchTextPreview(sessionId: string, blobId: string, signal?: AbortSignal): Promise<ChatTextPreview> {
  const res = await fetch(CHAT_CONTENT_API.preview(sessionId, blobId), { credentials: 'same-origin', signal });
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<ChatTextPreview>(json)) return json.data;
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Couldn’t read the file (${res.status}).`, res.status);
}

/** Where a stored file's bytes are served (inline for what a browser can show, a download for the rest). */
export const fileUrl = (sessionId: string, blobId: string): string => CHAT_API.blob(sessionId, blobId);
/** The same bytes as a download, whatever the type. */
export const downloadUrl = (sessionId: string, blobId: string): string => `${CHAT_API.blob(sessionId, blobId)}?download=1`;
/** A zip of the files of these transcript events. */
export const zipUrl = (sessionId: string, events: number[]): string => CHAT_CONTENT_API.zip(sessionId, events);
