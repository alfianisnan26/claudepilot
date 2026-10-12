// Chat content (chat-sessions PRD FR30–FR33, FR47): the files you attach to a message and the artifacts the
// agent produces. Both live in the portal's blob store, scoped to the chat, and show up in the transcript
// itself — there is no file manager. The bytes of any of them are `CHAT_API.blob(sessionId, blobId)`.

/** How a file opens in the chat. `none`: it only downloads. */
export type ChatPreview = 'image' | 'text' | 'pdf' | 'audio' | 'video' | 'html' | 'none';

/**
 * What Claude can do with an attachment, so the composer never pretends: `sees` (shown to it directly: an
 * image), `reads` (it opens the file with its own tools: text, code, CSV, PDF), `path` (it only gets the
 * file's path, and can run tools on it: audio, video, archives, other binaries).
 */
export type ChatReach = 'sees' | 'reads' | 'path';

/** How an artifact came about: written or edited by the agent, made by a command, returned by a tool, or handed over on purpose. */
export type ChatArtifactSource = 'write' | 'edit' | 'command' | 'tool' | 'publish';

/** A file in a chat: one you attached (a `user` event's `files`), or an artifact the agent produced (an `artifact` event's `files`). */
export interface ChatFile {
  /** sha256 of the stored bytes. */
  blobId: string;
  /** The name it shows and downloads as: sanitised, never a path. */
  name: string;
  /** The type the portal sniffed from the bytes (not what the sender claimed). */
  mediaType: string;
  size: number;
  preview: ChatPreview;
  width?: number;
  height?: number;
  /** Attachments: what Claude can do with it. */
  reach?: ChatReach;
  /** Artifacts: where in the workspace the agent made it (shown, never read back). */
  path?: string;
  source?: ChatArtifactSource;
  /** Text copies only: secrets were hidden in what is stored (the file in the workspace is untouched). */
  redacted?: boolean;
}

/** `POST CHAT_CONTENT_API.upload`: a file received and checked, waiting to be sent with a message. */
export interface ChatUpload extends ChatFile {
  /** What `send` names it by (`ChatUploadRef`). */
  id: string;
}

/** A message's attachment that was uploaded first. */
export interface ChatUploadRef {
  uploadId: string;
}

/** Caps (FR30, FR31, FR32). A file over {@link CHAT_MAX_UPLOAD_BYTES}, or more than {@link CHAT_MAX_ATTACHMENTS} in a message, is refused with the reason. */
export const CHAT_MAX_UPLOAD_BYTES = 25_000_000;
export const CHAT_MAX_ATTACHMENTS = 20;
/** All of one message's attachments together. */
export const CHAT_MAX_ATTACHMENT_TOTAL = 100_000_000;
/** What the API accepts of one image (the browser sends far less: it downsizes to 2,000 px), and the images of one message together (FR30). */
export const CHAT_MAX_SENT_IMAGE_BYTES = 5_000_000;
export const CHAT_MAX_IMAGE_TOTAL = 20_000_000;
/** The part of a text file a preview shows. */
export const CHAT_MAX_PREVIEW_BYTES = 1_000_000;
/** "Download all": entries, and the bytes of what goes into one zip (FR32). */
export const CHAT_MAX_ZIP_ENTRIES = 200;
export const CHAT_MAX_ZIP_BYTES = 100_000_000;

/** The text preview of a stored file (`CHAT_CONTENT_API.preview`), secrets hidden. */
export interface ChatTextPreview {
  text: string;
  /** The file is longer than {@link CHAT_MAX_PREVIEW_BYTES}: this is its start. */
  truncated: boolean;
  /** Something was hidden in `text`. */
  redacted: boolean;
}

export const CHAT_CONTENT_API = {
  /** POST: the file as the raw body (`Content-Type` its claimed type, `X-File-Name` its URL-encoded name) → `ChatUpload`. */
  upload: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/uploads`,
  /** DELETE: drop an upload that was never sent. */
  uploadOne: (id: string, uploadId: string) => `/api/chat/sessions/${encodeURIComponent(id)}/uploads/${encodeURIComponent(uploadId)}`,
  /** GET: a text file's start as `ChatTextPreview`. */
  preview: (id: string, blobId: string) => `/api/chat/sessions/${encodeURIComponent(id)}/blobs/${blobId}/preview`,
  /** GET: an HTML file as a sandboxed document, only ever shown inside `<iframe sandbox>`. */
  sandbox: (id: string, blobId: string) => `/api/chat/sessions/${encodeURIComponent(id)}/blobs/${blobId}/sandbox`,
  /** GET `?events=12,15`: the files of those transcript events, zipped. */
  zip: (id: string, events: number[]) => `/api/chat/sessions/${encodeURIComponent(id)}/artifacts.zip?events=${events.join(',')}`,
} as const;

/** One word for what a file is, for its icon and for how it is described: the same on the server and in the app. */
export type ChatFileClass = 'image' | 'pdf' | 'audio' | 'video' | 'text' | 'html' | 'archive' | 'sheet' | 'doc' | 'file';

export function chatFileClass(mediaType: string, name: string): ChatFileClass {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('video/')) return 'video';
  if (mediaType === 'text/html') return 'html';
  if (mediaType === 'text/csv' || mediaType === 'text/tab-separated-values' || /spreadsheet|ms-excel|parquet/.test(mediaType) || ext === 'xlsx' || ext === 'xls') return 'sheet';
  if (/wordprocessing|msword|opendocument\.text|rtf|presentation|powerpoint/.test(mediaType)) return 'doc';
  if (/zip|gzip|tar|bzip2|x-xz|7z|rar|java-archive|epub/.test(mediaType)) return 'archive';
  if (mediaType.startsWith('text/') || /json|xml|yaml|toml|x-sh|sql|x-tex|ndjson/.test(mediaType)) return 'text';
  return 'file';
}
