// Reading uploads (Skillset FR1, §14): a `.zip`, or a folder a desktop browser sends file by file. Uploads
// are untrusted, so nothing here touches the disk or runs anything: entries come back as buffers, with
// every path checked, sizes and counts capped before anything is inflated, inflation bounded by the
// declared size, CRCs checked, and overlapping or self-referencing zip structures refused (zip bombs).

import { crc32, inflateRawSync } from 'node:zlib';
import { SKILL_UPLOAD_LIMITS } from '@portal/contracts';

export interface ArchiveEntry {
  /** Relative, `/`-separated, NFC, never empty, `.` or `..`. */
  path: string;
  type: 'file' | 'symlink' | 'special';
  /** Unix permission bits when the archive recorded them, else 0o644. */
  mode: number;
  /** File bytes; for a symlink, its target as written. */
  data: Buffer;
}

export interface ArchiveLimits {
  bytes: number;
  files: number;
  ratio: number;
}

/** What the person sees when an upload can't be read: one plain sentence. */
export class ArchiveError extends Error {}

const DEFAULT_LIMITS: ArchiveLimits = { bytes: SKILL_UPLOAD_LIMITS.bytes, files: SKILL_UPLOAD_LIMITS.files, ratio: SKILL_UPLOAD_LIMITS.ratio };
const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
/** Parsing stops here whatever the archive claims: folders count too. */
const MAX_ENTRIES = 20_000;

/** Files and folders that come along with zips made on a Mac, skipped without a word. */
const JUNK = (path: string) => path.startsWith('__MACOSX/') || path === '__MACOSX' || path.split('/').pop() === '.DS_Store';

/**
 * Checks and normalizes one archive path. Refuses absolute paths, drive letters, backslashes, control
 * characters and `.`/`..` segments outright: a path that would leave the folder makes the whole upload fail.
 */
export function cleanPath(raw: string): string {
  let p = raw;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) throw new ArchiveError(`A file name has a control character: ${JSON.stringify(p.slice(0, 80))}.`);
  if (p.includes('\\')) throw new ArchiveError(`A path uses backslashes, which aren’t supported: ${p.slice(0, 120)}`);
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new ArchiveError(`A path is absolute: ${p.slice(0, 120)}`);
  while (p.startsWith('./')) p = p.slice(2);
  if (p.endsWith('/')) p = p.slice(0, -1);
  const parts = p.split('/');
  if (!p || parts.some((s) => s === '' || s === '.' || s === '..')) throw new ArchiveError(`A path leaves its folder or is malformed: ${raw.slice(0, 120)}`);
  if (p.length > 1024) throw new ArchiveError('A path is longer than 1,024 characters.');
  return p.normalize('NFC');
}

/** UTF-8 when it decodes cleanly (many tools don't set the flag), else Latin-1 as an approximation of CP437. */
function decodeName(bytes: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return bytes.toString('utf8');
  const asUtf8 = bytes.toString('utf8');
  return asUtf8.includes('\uFFFD') ? bytes.toString('latin1') : asUtf8;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

interface CentralEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  size: number;
  unixMode: number | null;
  localOffset: number;
  isDir: boolean;
}

/**
 * Reads a whole zip held in memory. The central directory is the authority (local headers are only used
 * to find where data starts). Refused: zip64, multi-disk, encrypted entries, methods other than stored
 * and deflate, data ranges that overlap one another or the directory, sizes past the limits, and
 * inflated data that doesn't match its declared size or CRC.
 */
export function readZip(buf: Buffer, limits: ArchiveLimits = DEFAULT_LIMITS): ArchiveEntry[] {
  if (buf.length < 22) throw new ArchiveError('That isn’t a zip file.');
  // End of central directory: the last 22 bytes plus a comment of at most 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError('That isn’t a zip file.');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ArchiveError('Zip64 archives aren’t supported. Zip the folder again with a standard tool.');
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new ArchiveError('Split zip archives aren’t supported.');
  if (total > MAX_ENTRIES) throw new ArchiveError(`The zip has more than ${MAX_ENTRIES.toLocaleString('en')} entries.`);
  if (cdOffset + cdSize > eocd) throw new ArchiveError('The zip is damaged (its directory is out of range).');

  const entries: CentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== 0x02014b50) throw new ArchiveError('The zip is damaged (bad directory entry).');
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ArchiveError('Zip64 archives aren’t supported. Zip the folder again with a standard tool.');
    const nameEnd = p + 46 + nameLen;
    if (nameEnd + extraLen + commentLen > cdOffset + cdSize) throw new ArchiveError('The zip is damaged (bad directory entry).');
    const name = decodeName(buf.subarray(p + 46, nameEnd), (flags & 0x800) !== 0);
    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : null;
    entries.push({
      name,
      method,
      flags,
      crc,
      compressed,
      size,
      unixMode: unixMode || null,
      localOffset,
      isDir: name.endsWith('/') || (unixMode !== null && (unixMode & S_IFMT) === S_IFDIR),
    });
    p = nameEnd + extraLen + commentLen;
  }

  // Caps first, from what the directory declares; the inflate below holds the archive to it.
  const kept = entries.filter((e) => !e.isDir && !JUNK(e.name.replace(/^\.\//, '')));
  if (kept.length > limits.files) throw new ArchiveError(`The zip has ${kept.length.toLocaleString('en')} files; the limit is ${limits.files.toLocaleString('en')}.`);
  const declared = kept.reduce((n, e) => n + e.size, 0);
  if (declared > limits.bytes) throw new ArchiveError(`The zip unpacks to ${MB(declared)}; the limit is ${MB(limits.bytes)}.`);
  const packed = kept.reduce((n, e) => n + e.compressed, 0);
  if (declared > 1024 * 1024 && declared > packed * limits.ratio) throw new ArchiveError(`The zip is compressed more than ${limits.ratio}:1, which looks like a zip bomb.`);

  // Every entry's local header and data must sit before the directory, and no two may overlap.
  const ranges: { start: number; end: number; entry: CentralEntry }[] = [];
  for (const e of entries) {
    const lh = e.localOffset;
    if (lh + 30 > cdOffset || buf.readUInt32LE(lh) !== 0x04034b50) throw new ArchiveError('The zip is damaged (bad file header).');
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    const end = start + e.compressed;
    if (end > cdOffset) throw new ArchiveError('The zip is damaged (file data out of range).');
    ranges.push({ start: lh, end, entry: e });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]!.start < ranges[i - 1]!.end) throw new ArchiveError('The zip has overlapping files, which looks like a zip bomb.');

  const out: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let inflated = 0;
  for (const { entry: e } of ranges) {
    if (e.isDir) continue;
    const path = cleanPath(e.name);
    if (JUNK(path)) continue;
    if (seen.has(path)) throw new ArchiveError(`The zip lists ${path} twice.`);
    seen.add(path);
    if (e.flags & 0x41) throw new ArchiveError('Encrypted zip archives aren’t supported.');
    if (e.size > 1024 * 1024 && e.size > Math.max(e.compressed, 1) * limits.ratio) throw new ArchiveError(`${path} is compressed more than ${limits.ratio}:1, which looks like a zip bomb.`);
    const lh = e.localOffset;
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    const raw = buf.subarray(start, start + e.compressed);
    let data: Buffer;
    if (e.method === 0) {
      if (e.compressed !== e.size) throw new ArchiveError(`${path} is damaged (size mismatch).`);
      data = Buffer.from(raw);
    } else if (e.method === 8) {
      try {
        // Never more than the declared size: a lying header can't make this allocate more.
        data = e.size === 0 ? Buffer.alloc(0) : inflateRawSync(raw, { maxOutputLength: e.size });
      } catch {
        throw new ArchiveError(`${path} is damaged or larger than it says.`);
      }
      if (data.length !== e.size) throw new ArchiveError(`${path} is damaged (size mismatch).`);
    } else {
      throw new ArchiveError(`${path} uses a compression method that isn’t supported. Use standard zip (deflate).`);
    }
    if (crc32(data) >>> 0 !== e.crc >>> 0) throw new ArchiveError(`${path} is damaged (checksum mismatch).`);
    inflated += data.length;
    if (inflated > limits.bytes) throw new ArchiveError(`The zip unpacks to more than ${MB(limits.bytes)}.`);
    const fmt = e.unixMode === null ? S_IFREG : e.unixMode & S_IFMT || S_IFREG;
    const type: ArchiveEntry['type'] = fmt === S_IFREG ? 'file' : fmt === S_IFLNK ? 'symlink' : 'special';
    out.push({ path, type, mode: e.unixMode === null ? 0o644 : e.unixMode & 0o7777, data });
  }
  return out;
}

/** A folder from a desktop browser: relative paths (which start with the folder's own name) and bytes. */
export function readFolder(files: { path: string; data: Buffer }[], limits: ArchiveLimits = DEFAULT_LIMITS): ArchiveEntry[] {
  const kept = files.filter((f) => !JUNK(f.path));
  if (kept.length > limits.files) throw new ArchiveError(`The folder has ${kept.length.toLocaleString('en')} files; the limit is ${limits.files.toLocaleString('en')}.`);
  const bytes = kept.reduce((n, f) => n + f.data.length, 0);
  if (bytes > limits.bytes) throw new ArchiveError(`The folder holds ${MB(bytes)}; the limit is ${MB(limits.bytes)}.`);
  const seen = new Set<string>();
  return kept.map((f) => {
    const path = cleanPath(f.path);
    if (seen.has(path)) throw new ArchiveError(`The folder lists ${path} twice.`);
    seen.add(path);
    // Browsers don't send permissions; the scanner decides what's executable.
    return { path, type: 'file' as const, mode: 0o644, data: f.data };
  });
}
