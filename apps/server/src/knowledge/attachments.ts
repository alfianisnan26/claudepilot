// Knowledge: which files in a vault are notes, which are attachments the portal will keep and serve, and
// which it skips (Knowledge PRD FR3, §17.2). By extension, from an allow-list: a file's content type is never
// taken from an upload, and nothing that can run in a browser or on a machine is on the list.

import { baseName, extOf, isHiddenPath, isNotePath } from './paths.js';

export interface AttachmentType {
  mime: string;
  /** Shown in the browser (images, audio, video, PDF), else downloaded. */
  inline: boolean;
}

const INLINE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

// SVG can carry script, so it is never shown inline by navigating to it: it downloads (an <img> still draws it).
const DOWNLOAD: Record<string, string> = {
  svg: 'image/svg+xml',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json',
  canvas: 'application/json',
  base: 'text/plain; charset=utf-8',
  zip: 'application/zip',
  heic: 'image/heic',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** The type to serve a file as, or null when the file isn't an allowed attachment. */
export function attachmentType(path: string): AttachmentType | null {
  const ext = extOf(path);
  if (INLINE[ext]) return { mime: INLINE[ext]!, inline: true };
  if (DOWNLOAD[ext]) return { mime: DOWNLOAD[ext]!, inline: false };
  return null;
}

/** Types that can carry script or run on a machine: named so a skip says why. */
const DANGEROUS = new Set(['html', 'htm', 'xhtml', 'xht', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'exe', 'dll', 'msi', 'com', 'scr', 'jar', 'apk', 'app', 'swf', 'vbs', 'wasm', 'php', 'py', 'rb', 'pl']);

export type FileClass =
  | { kind: 'note' }
  | { kind: 'attachment'; type: AttachmentType }
  | { kind: 'skip'; reason: 'hidden' | 'type' | 'dangerous'; ext: string };

/** What a vault does with a relative path: keep it as a note, keep it as an attachment, or skip it. */
export function classifyFile(path: string): FileClass {
  if (isHiddenPath(path)) return { kind: 'skip', reason: 'hidden', ext: extOf(path) };
  if (isNotePath(path)) return { kind: 'note' };
  const type = attachmentType(path);
  if (type) return { kind: 'attachment', type };
  const ext = extOf(path);
  return { kind: 'skip', reason: DANGEROUS.has(ext) ? 'dangerous' : 'type', ext };
}

/** Headers for serving an attachment (Knowledge PRD §17.2): never sniffed, sandboxed, downloaded unless inline. */
export function attachmentHeaders(path: string, type: AttachmentType): Record<string, string> {
  const name = baseName(path).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return {
    'Content-Type': type.mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'",
    'Content-Disposition': `${type.inline ? 'inline' : 'attachment'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(baseName(path))}`,
    'Cache-Control': 'private, no-cache',
  };
}
