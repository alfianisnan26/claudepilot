// Chat content: what a file is, decided from its bytes (chat-sessions PRD §13: "files get a sniffed type").
// What the sender or the file's extension claims is only a hint for the kinds that bytes alone can't tell
// apart (a CSV from a log, a .docx from a .zip). Nothing here runs or renders anything.

import { CHAT_MAX_SENT_IMAGE_BYTES, chatFileClass, type ChatPreview, type ChatReach } from '@portal/contracts';
import { extensionOf } from './names.js';

/** How much of a file's start is enough to decide its type and read an image's size. */
export const SNIFF_BYTES = 256 * 1024;

export interface Sniffed {
  /** The type the bytes say it is (`application/octet-stream` when nothing does). */
  mediaType: string;
  preview: ChatPreview;
  reach: ChatReach;
  /** Readable as text (UTF-8, no binary content). */
  textual: boolean;
  /** An image the API takes (PNG, JPEG, GIF, WebP) within its limits: shown to Claude directly. */
  claudeImage: boolean;
  width?: number;
  height?: number;
}

/** The image types the API takes, and so the ones Claude is shown. */
const CLAUDE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** The API refuses an image over 8,000 px on a side. */
const MAX_IMAGE_SIDE = 8000;

const ascii = (b: Buffer, from: number, to: number) => b.toString('latin1', from, to);

/* ---------- Image sizes, read from the header ---------- */

function pngSize(b: Buffer): [number, number] | null {
  return b.length >= 24 && ascii(b, 12, 16) === 'IHDR' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
}

function gifSize(b: Buffer): [number, number] | null {
  return b.length >= 10 ? [b.readUInt16LE(6), b.readUInt16LE(8)] : null;
}

function jpegSize(b: Buffer): [number, number] | null {
  let pos = 2;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = b[pos + 1]!;
    if (marker === 0xff) {
      pos++; // fill byte
      continue;
    }
    // Markers with no length: restart markers, TEM, SOI, EOI.
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xd9) return null;
    const length = b.readUInt16BE(pos + 2);
    // Start of frame (not DHT, JPG or DAC): precision, height, width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return pos + 9 <= b.length ? [b.readUInt16BE(pos + 7), b.readUInt16BE(pos + 5)] : null;
    }
    pos += 2 + length;
  }
  return null;
}

function webpSize(b: Buffer): [number, number] | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 16);
  if (chunk === 'VP8 ') return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff] : null;
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const w = 1 + (b[21]! | ((b[22]! & 0x3f) << 8));
    const h = 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10));
    return [w, h];
  }
  if (chunk === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  return null;
}

/* ---------- Container formats ---------- */

/** The type an ISO base media file ("ftyp" box) is: audio, video, or an image the browser may not show. */
function isoType(b: Buffer, ext: string): string {
  const major = ascii(b, 8, 12);
  const brands = new Set<string>([major]);
  const size = Math.min(b.readUInt32BE(0), b.length);
  for (let i = 16; i + 4 <= size; i += 4) brands.add(ascii(b, i, i + 4));
  if (brands.has('avif') || brands.has('avis')) return 'image/avif';
  if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].some((x) => brands.has(x))) return 'image/heic';
  if (major === 'qt  ') return 'video/quicktime';
  if (major === 'M4A ' || ((ext === 'm4a' || ext === 'm4b') && major !== 'M4V ')) return 'audio/mp4';
  if (['3gp4', '3gp5', '3gp6', '3gp7', '3ge6', '3gg6'].includes(major)) return 'video/3gpp';
  if (['3g2a', '3g2b', '3g2c'].includes(major)) return 'video/3gpp2';
  return major === 'M4V ' ? 'video/x-m4v' : 'video/mp4';
}

/** Whether the bytes start an MPEG audio frame (a bare MP3, or AAC in ADTS). */
function mpegAudio(b: Buffer): string | null {
  if (b.length < 4 || b[0] !== 0xff || (b[1]! & 0xe0) !== 0xe0) return null;
  const layer = (b[1]! >> 1) & 0x03;
  const version = (b[1]! >> 3) & 0x03;
  if (layer === 0 || version === 1) return layer === 0 && version !== 1 && (b[1]! & 0xf6) === 0xf0 ? 'audio/aac' : null;
  return (b[2]! >> 4) === 0x0f ? null : 'audio/mpeg';
}

/** Office and package formats are zip files by another name; the extension says which. */
const ZIP_BY_EXT: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
  jar: 'application/java-archive',
  apk: 'application/vnd.android.package-archive',
};

/* ---------- Text ---------- */

/** Extension → type, for text files (their bytes can't say whether they are CSV, Markdown or code). */
const TEXT_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  ndjson: 'application/x-ndjson',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  ini: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  env: 'text/plain',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  swift: 'text/x-swift',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  php: 'text/x-php',
  sh: 'application/x-sh',
  bash: 'application/x-sh',
  zsh: 'application/x-sh',
  sql: 'application/sql',
  tex: 'application/x-tex',
  diff: 'text/x-diff',
  patch: 'text/x-diff',
  vue: 'text/plain',
  svelte: 'text/plain',
  dockerfile: 'text/plain',
  gitignore: 'text/plain',
};

/** Types by extension that bytes alone can't give, for binary files (shown in the card; the file is served as a download). */
const BINARY_BY_EXT: Record<string, string> = {
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  wma: 'audio/x-ms-wma',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  amr: 'audio/amr',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  rtf: 'application/rtf',
  sqlite: 'application/vnd.sqlite3',
  db: 'application/octet-stream',
  parquet: 'application/vnd.apache.parquet',
  wasm: 'application/wasm',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/** Whether a buffer is text: valid UTF-8 (or UTF-16 with a byte order mark), without NULs and with hardly any controls. */
export function looksTextual(b: Buffer, cut: boolean): boolean {
  if (b.length === 0) return true;
  // UTF-16 only with its byte order mark, and only when it decodes (a stray FF FE starts plenty of binary files).
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) {
    try {
      const text = new TextDecoder(b[0] === 0xff ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(b.subarray(0, b.length - (b.length % 2)));
      // eslint-disable-next-line no-control-regex
      return (text.match(/[\u{0}-\u{8}\u{e}-\u{1f}]/gu)?.length ?? 0) <= Math.max(2, text.length / 100);
    } catch {
      return false;
    }
  }
  let end = b.length;
  // A multi-byte character cut by the end of the sample isn't an error.
  if (cut) for (let i = 1; i <= 3 && end - i >= 0; i++) if ((b[end - i]! & 0xc0) === 0xc0) { end -= i; break; }
  let controls = 0;
  for (let i = 0; i < end; i++) {
    const c = b[i]!;
    if (c === 0) return false;
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 27) controls++;
  }
  if (controls > Math.max(2, end / 100)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}

/** HTML, by what the bytes start with after any whitespace and BOM (or `.html` and a tag). */
const HTML_START = /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<!--)/i;
/** An SVG, by the root element (after any XML declaration, doctype or comment). */
const SVG_ROOT = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+svg[^>]*>\s*)?<svg[\s>]/i;

function fromTextExt(ext: string): string {
  return TEXT_BY_EXT[ext] ?? 'text/plain';
}

/**
 * What a file is, from its first bytes (at most {@link SNIFF_BYTES} are needed) and its name. `cut` says
 * `head` is only the start of a longer file. `size` is the whole file's (the API's per-image limit applies).
 */
export function sniff(head: Buffer, name: string, size: number, cut = head.length < size): Sniffed {
  const ext = extensionOf(name);
  const b = head;

  const done = (mediaType: string, preview: ChatPreview, reach: ChatReach, textual = false, dims?: [number, number] | null): Sniffed => {
    const out: Sniffed = { mediaType, preview, reach, textual, claudeImage: false };
    if (dims && dims[0] > 0 && dims[1] > 0) {
      out.width = dims[0];
      out.height = dims[1];
    }
    if (CLAUDE_IMAGES.has(mediaType)) {
      // Shown to Claude only when the API will take it: its size and its dimensions (unknown dimensions: not risked).
      out.claudeImage = size <= CHAT_MAX_SENT_IMAGE_BYTES && !!out.width && !!out.height && out.width <= MAX_IMAGE_SIDE && out.height <= MAX_IMAGE_SIDE;
      out.reach = out.claudeImage ? 'sees' : 'path';
    }
    return out;
  };
  const binary = (mediaType: string, preview: ChatPreview = 'none') => done(mediaType, preview, 'path');

  // Images
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return done('image/png', 'image', 'sees', false, pngSize(b));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return done('image/jpeg', 'image', 'sees', false, jpegSize(b));
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return done('image/gif', 'image', 'sees', false, gifSize(b));
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return done('image/webp', 'image', 'sees', false, webpSize(b));
  if (b.length >= 2 && ascii(b, 0, 2) === 'BM' && ext === 'bmp') return binary('image/bmp');

  // Documents
  if (ascii(b, 0, Math.min(b.length, 1024)).includes('%PDF-')) return done('application/pdf', 'pdf', 'reads');

  // Audio and video
  if (b.length >= 3 && ascii(b, 0, 3) === 'ID3') return done('audio/mpeg', 'audio', 'path');
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return done('audio/wav', 'audio', 'path');
  if (b.length >= 4 && ascii(b, 0, 4) === 'fLaC') return done('audio/flac', 'audio', 'path');
  if (b.length >= 4 && ascii(b, 0, 4) === 'OggS') {
    const video = ext === 'ogv' || ascii(b, 0, Math.min(b.length, 128)).includes('theora');
    return video ? done('video/ogg', 'video', 'path') : done('audio/ogg', 'audio', 'path');
  }
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const type = isoType(b, ext);
    if (type.startsWith('image/')) return binary(type);
    return done(type, type.startsWith('audio/') ? 'audio' : type === 'video/3gpp' || type === 'video/3gpp2' || type === 'video/x-m4v' ? 'video' : 'video', 'path');
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const webm = ascii(b, 0, Math.min(b.length, 64)).includes('webm');
    if (!webm) return binary('video/x-matroska');
    return ext === 'weba' ? done('audio/webm', 'audio', 'path') : done('video/webm', 'video', 'path');
  }
  const mpeg = mpegAudio(b);
  if (mpeg && (ext === 'mp3' || ext === 'aac' || ext === 'mp2' || ext === 'adts' || ext === 'm4a' || ext === '')) return done(mpeg, 'audio', 'path');

  // Archives and packages
  if (b.length >= 4 && ascii(b, 0, 2) === 'PK' && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6)) return binary(ZIP_BY_EXT[ext] ?? 'application/zip');
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return binary('application/gzip');
  if (b.length >= 3 && ascii(b, 0, 3) === 'BZh') return binary('application/x-bzip2');
  if (b.length >= 6 && b[0] === 0xfd && ascii(b, 1, 5) === '7zXZ') return binary('application/x-xz');
  if (b.length >= 6 && b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return binary('application/x-7z-compressed');
  if (b.length >= 4 && ascii(b, 0, 4) === 'Rar!') return binary('application/vnd.rar');
  if (b.length >= 262 && ascii(b, 257, 262) === 'ustar') return binary('application/x-tar');
  if (b.length >= 4 && ascii(b, 0, 4) === '\u{7f}ELF') return binary('application/x-executable');
  if (b.length >= 2 && ascii(b, 0, 2) === 'MZ') return binary('application/vnd.microsoft.portable-executable');
  if (b.length >= 4 && ascii(b, 0, 4) === '\u{0}asm') return binary('application/wasm');
  if (b.length >= 8 && ascii(b, 0, 8) === 'SQLite f') return binary('application/vnd.sqlite3');

  // Text
  if (looksTextual(b, cut)) {
    const text = b.toString('utf8', 0, Math.min(b.length, 4096)).replace(/^\u{feff}/u, '');
    if (SVG_ROOT.test(text) || ext === 'svg') return done('image/svg+xml', 'none', 'reads', true); // download only: an SVG can carry script
    if (HTML_START.test(text) || ((ext === 'html' || ext === 'htm' || ext === 'xhtml') && /</.test(text))) return done('text/html', 'html', 'reads', true);
    return done(fromTextExt(ext), 'text', 'reads', true);
  }
  return binary(BINARY_BY_EXT[ext] ?? 'application/octet-stream');
}

/** The types the blob route serves inline (so a browser can show or play them); everything else is a download. */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'audio/aac',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
]);

export const isInlineType = (mediaType: string): boolean => INLINE_TYPES.has(mediaType);

/** A one-word kind for icons and for the note to Claude: image, pdf, audio, video, text, html, archive, sheet, doc or file. */
export const fileClass = chatFileClass;
