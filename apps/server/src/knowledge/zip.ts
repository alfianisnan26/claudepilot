// Knowledge: zip reading and writing for vault import and export (Knowledge PRD §15.1).
//
// Reading is the Skillset importer's discipline (skills/archive.ts) with the differences a vault needs: entries
// are inflated one at a time, on demand, so a large vault never sits unpacked in memory; the entry limit is
// the classic zip's (65,535); and a path that could leave the folder fails the whole archive while hidden and
// disallowed files are skipped and reported by the caller. Refused: zip64, split and encrypted archives, other
// methods than stored and deflate, overlapping or out-of-range data, declared sizes past the caps, inflation
// past the declared size, wrong CRCs, and ratios that look like bombs.
//
// Writing is a plain streaming zip: deflate or store, UTF-8 names, known sizes, one entry in memory at a time.

import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export class ZipError extends Error {}

export interface ZipLimits {
  packedBytes: number;
  unpackedBytes: number;
  files: number;
  ratio: number;
}

export interface ZipFile {
  /** The name as the archive spells it (not yet cleaned). */
  name: string;
  size: number;
  isDir: boolean;
  /** Unix file type: 'file', 'symlink' or 'special' (a device, a socket); 'file' when the archive didn't say. */
  type: 'file' | 'symlink' | 'special';
  /** Inflates and checks this one entry. */
  read(): Buffer;
}

const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** UTF-8 when it decodes cleanly (many tools don't set the flag), else Latin-1 as an approximation of CP437. */
function decodeName(bytes: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return bytes.toString('utf8');
  const asUtf8 = bytes.toString('utf8');
  return asUtf8.includes('�') ? bytes.toString('latin1') : asUtf8;
}

interface Central {
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
 * Reads a zip held in memory; nothing is inflated until an entry's `read()` is called. Entries `skip`
 * names (hidden folders, files that won't be kept) don't count toward the file, size and ratio caps,
 * because they are never read: a vault zipped with its `.git` folder is still a small vault.
 */
export function openZip(buf: Buffer, limits: ZipLimits, skip: (name: string) => boolean = () => false): ZipFile[] {
  if (buf.length > limits.packedBytes) throw new ZipError(`The zip is ${MB(buf.length)}; the limit is ${MB(limits.packedBytes)}.`);
  if (buf.length < 22) throw new ZipError('That isn’t a zip file.');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('That isn’t a zip file.');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('Zip64 archives aren’t supported. Zip the folder again with a standard tool.');
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new ZipError('Split zip archives aren’t supported.');
    if (cdOffset + cdSize > eocd) throw new ZipError('The zip is damaged (its directory is out of range).');

  const entries: Central[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The zip is damaged (bad directory entry).');
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
    if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('Zip64 archives aren’t supported. Zip the folder again with a standard tool.');
    const nameEnd = p + 46 + nameLen;
    if (nameEnd + extraLen + commentLen > cdOffset + cdSize) throw new ZipError('The zip is damaged (bad directory entry).');
    const name = decodeName(buf.subarray(p + 46, nameEnd), (flags & 0x800) !== 0);
    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : null;
    entries.push({ name, method, flags, crc, compressed, size, unixMode: unixMode || null, localOffset, isDir: name.endsWith('/') || (unixMode !== null && (unixMode & S_IFMT) === S_IFDIR) });
    p = nameEnd + extraLen + commentLen;
  }

  const files = entries.filter((e) => !e.isDir && !skip(e.name));
  if (files.length > limits.files) throw new ZipError(`The zip has ${files.length.toLocaleString('en')} files; the limit is ${limits.files.toLocaleString('en')}.`);
  const declared = files.reduce((n, e) => n + e.size, 0);
  if (declared > limits.unpackedBytes) throw new ZipError(`The zip unpacks to ${MB(declared)}; the limit is ${MB(limits.unpackedBytes)}.`);
  const packed = files.reduce((n, e) => n + e.compressed, 0);
  if (declared > 1024 * 1024 && declared > packed * limits.ratio) throw new ZipError(`The zip is compressed more than ${limits.ratio}:1, which looks like a zip bomb.`);

  // Every entry's local header and data must sit before the directory, and no two may overlap.
  const ranges: { start: number; end: number }[] = [];
  for (const e of entries) {
    const lh = e.localOffset;
    if (lh + 30 > cdOffset || buf.readUInt32LE(lh) !== 0x04034b50) throw new ZipError('The zip is damaged (bad file header).');
    const end = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28) + e.compressed;
    if (end > cdOffset) throw new ZipError('The zip is damaged (file data out of range).');
    ranges.push({ start: lh, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]!.start < ranges[i - 1]!.end) throw new ZipError('The zip has overlapping files, which looks like a zip bomb.');

  return entries.map((e): ZipFile => {
    const fmt = e.unixMode === null ? S_IFREG : e.unixMode & S_IFMT || S_IFREG;
    return {
      name: e.name,
      size: e.size,
      isDir: e.isDir,
      type: e.isDir || fmt === S_IFREG ? 'file' : fmt === S_IFLNK ? 'symlink' : 'special',
      read() {
        if (e.flags & 0x41) throw new ZipError('Encrypted zip archives aren’t supported.');
        if (e.size > 1024 * 1024 && e.size > Math.max(e.compressed, 1) * limits.ratio) throw new ZipError(`${e.name} is compressed more than ${limits.ratio}:1, which looks like a zip bomb.`);
        const lh = e.localOffset;
        const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
        const raw = buf.subarray(start, start + e.compressed);
        let data: Buffer;
        if (e.method === 0) {
          if (e.compressed !== e.size) throw new ZipError(`${e.name} is damaged (size mismatch).`);
          data = Buffer.from(raw);
        } else if (e.method === 8) {
          try {
            // Never more than the declared size: a lying header can't make this allocate more.
            data = e.size === 0 ? Buffer.alloc(0) : inflateRawSync(raw, { maxOutputLength: e.size });
          } catch {
            throw new ZipError(`${e.name} is damaged or larger than it says.`);
          }
          if (data.length !== e.size) throw new ZipError(`${e.name} is damaged (size mismatch).`);
        } else {
          throw new ZipError(`${e.name} uses a compression method that isn’t supported. Use standard zip (deflate).`);
        }
        if (crc32(data) >>> 0 !== e.crc >>> 0) throw new ZipError(`${e.name} is damaged (checksum mismatch).`);
        return data;
      },
    };
  });
}

/* ---------- Writing ---------- */

export interface ZipOut {
  name: string;
  data: Buffer;
  mtime: Date;
  /** Keep the bytes as they are (already compressed: images, media, archives). */
  store?: boolean;
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * A standard zip as a stream of chunks, one entry in memory at a time. `entries` is read lazily, so a
 * generator that reads each file as it is asked for keeps memory flat. At most 65,534 entries and 4 GB
 * (no zip64): callers cap vaults below that.
 */
export function* zipChunks(entries: Iterable<ZipOut>): Generator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  for (const e of entries) {
    if (++count > 65_534) throw new ZipError('Too many files for one zip.');
    const name = Buffer.from(e.name, 'utf8');
    const { time, date } = dosTime(e.mtime);
    const crc = crc32(e.data) >>> 0;
    const packed = e.store || e.data.length < 64 ? null : deflateRawSync(e.data, { level: 6 });
    const useDeflate = packed !== null && packed.length < e.data.length;
    const body = useDeflate ? packed! : e.data;
    const method = useDeflate ? 8 : 0;
    if (offset + body.length > 0xfffffff0) throw new ZipError('That would be more than a 4 GB zip.');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const head = Buffer.concat([local, name]);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE((3 << 8) | 20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(((S_IFREG | 0o644) << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, name]));
    yield head;
    yield body;
    offset += head.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  yield cd;
  yield end;
}
