// Chat content: "Download all" (chat-sessions PRD FR32): a turn's files as one zip. The files are blobs in the
// portal's store, so no workspace path is read and there is no symlink to follow; names are made safe and
// unique, the entry count and the total size are capped, and the archive is streamed (a file at a time) so a
// large one is never held in memory. Classic zip, no ZIP64: nothing here comes near 4 GB or 65,535 entries.

import { createReadStream, statSync } from 'node:fs';
import { PassThrough, pipeline, Readable, Transform } from 'node:stream';
import { crc32, createDeflateRaw } from 'node:zlib';
import { AppError } from '@isnanme/core';
import { CHAT_MAX_ZIP_BYTES, CHAT_MAX_ZIP_ENTRIES } from '@portal/contracts';
import { uniqueEntryName } from './names.js';
import type { BlobFile } from './serve.js';

export interface ZipItem {
  /** The name to give the entry (made safe and unique here). */
  name: string;
  file: BlobFile;
}

/** What an entry is stored as: a name that is already unique, and whether it is deflated. */
interface Planned {
  name: string;
  file: BlobFile;
  deflate: boolean;
}

/** Types that are already compressed: deflating them again costs time and gains nothing. */
const PACKED = /^(?:image\/(?:png|jpeg|gif|webp|avif|heic)|audio\/|video\/|application\/(?:zip|gzip|x-bzip2|x-xz|x-7z-compressed|vnd\.rar|pdf|epub\+zip|java-archive|vnd\.openxmlformats|vnd\.oasis))/;

/** Checks the caps and names the entries. Throws a 413 that says which cap. */
export function planZip(items: ZipItem[]): Planned[] {
  if (!items.length) throw new AppError('NOT_FOUND', 'There are no files to download.');
  if (items.length > CHAT_MAX_ZIP_ENTRIES) throw new AppError('PAYLOAD_TOO_LARGE', `Too many files for one zip (over ${CHAT_MAX_ZIP_ENTRIES}).`);
  const total = items.reduce((n, i) => n + i.file.size, 0);
  if (total > CHAT_MAX_ZIP_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', `Too large for one zip (over ${CHAT_MAX_ZIP_BYTES / 1_000_000} MB).`);
  const taken = new Set<string>();
  return items.map((i) => ({ name: uniqueEntryName(i.name, taken), file: i.file, deflate: !PACKED.test(i.file.mediaType) && i.file.size > 0 }));
}

/** MS-DOS date and time, the zip format's. */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

/** UTF-8 names, and sizes and CRC after the data (a data descriptor), since the data is streamed. */
const FLAGS = 0x0808;

/** The archive's bytes, an entry at a time. */
async function* archive(entries: Planned[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  const emit = (b: Buffer) => {
    offset += b.length;
    return b;
  };
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const { time, date } = dosTime(statSync(e.file.path).mtime);
    const method = e.deflate ? 8 : 0;
    const headerOffset = offset;
    yield emit(Buffer.concat([u32(0x04034b50), u16(20), u16(FLAGS), u16(method), u16(time), u16(date), u32(0), u32(0), u32(0), u16(name.length), u16(0), name]));
    let crc = 0;
    let size = 0;
    let packed = 0;
    // The CRC and the size are of the file's own bytes, taken before any deflating.
    const tap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        done(null, chunk);
      },
    });
    const out = new PassThrough();
    pipeline(createReadStream(e.file.path), tap, ...(e.deflate ? [createDeflateRaw({ level: 6 })] : []), out, (err) => {
      if (err) out.destroy(err);
    });
    for await (const chunk of out) {
      packed += (chunk as Buffer).length;
      yield emit(chunk as Buffer);
    }
    yield emit(Buffer.concat([u32(0x08074b50), u32(crc), u32(packed), u32(size)]));
    central.push(
      Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(FLAGS), u16(method), u16(time), u16(date), u32(crc), u32(packed), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(headerOffset), name]),
    );
  }
  const start = offset;
  let length = 0;
  for (const c of central) {
    length += c.length;
    yield emit(c);
  }
  yield emit(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(length), u32(start), u16(0)]));
}

/** The zip of these files as a web stream. The caps are checked first ({@link planZip}). */
export function zipStream(items: ZipItem[]): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from(archive(planZip(items)))) as unknown as ReadableStream<Uint8Array>;
}
