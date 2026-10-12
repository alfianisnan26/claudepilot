import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { PERSONA_AVATAR } from '@portal/contracts';
import sharp from 'sharp';
import { normalizeAvatar, sniffImage } from './avatar.js';

const refused = (re: RegExp) => (e: unknown) => isAppError(e) && e.code === 'VALIDATION_FAILED' && re.test(e.message);
const solid = (width: number, height: number, background: string, channels: 3 | 4 = 4) => sharp({ create: { width, height, channels, background } });

/** The chunk types of a PNG, in order: what a file carries besides its pixels. */
function chunks(png: Buffer): string[] {
  const out: string[] = [];
  for (let at = 8; at + 12 <= png.length; at += 12 + png.readUInt32BE(at)) out.push(png.toString('latin1', at + 4, at + 8));
  return out;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return ~c >>> 0;
  };
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data])));
  return Buffer.concat([head, Buffer.from(type), data, tail]);
}
const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w: number, h: number) => {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0);
  b.writeUInt32BE(h, 4);
  b[8] = 8;
  b[9] = 2;
  return b;
};

test('a PNG, a JPEG and a WebP become the same kind of file: a square PNG, no larger than 512 px, with nothing but pixels', async () => {
  const png = await normalizeAvatar(await solid(800, 400, '#c81e1e').png().toBuffer());
  assert.equal(png.side, 400, 'a wide image is cropped to a square of its short side');
  const jpeg = await normalizeAvatar(await solid(1600, 1600, '#22aa77', 3).jpeg().toBuffer());
  assert.equal(jpeg.side, PERSONA_AVATAR.maxSide, 'and a large one is scaled down to 512');
  const webp = await normalizeAvatar(await solid(64, 64, '#3333ff').webp().toBuffer());
  assert.equal(webp.side, 64, 'a small one is never scaled up');
  for (const a of [png, jpeg, webp]) {
    assert.deepEqual(a.png.subarray(0, 8), MAGIC);
    const meta = await sharp(a.png).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', a.side, a.side]);
    assert.ok(a.png.length <= PERSONA_AVATAR.outputBytes);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
  }
  // The same picture from any source is the same address (content-addressed by what is stored).
  const again = await normalizeAvatar(await solid(800, 400, '#c81e1e').png().toBuffer());
  assert.equal(again.sha256, png.sha256);
});

test('metadata does not survive: EXIF (with its orientation applied), XMP, text chunks and colour profiles are gone', async () => {
  // A 30 x 60 picture stored sideways: orientation 6 means it is shown rotated, so the avatar is the rotated picture.
  const tagged = await solid(60, 30, '#336699', 3).withExif({ IFD0: { Orientation: '6', Copyright: 'private owner', Artist: 'someone' } }).jpeg().toBuffer();
  assert.ok((await sharp(tagged).metadata()).exif, 'the upload really carries EXIF');
  const out = await normalizeAvatar(tagged);
  const meta = await sharp(out.png).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.xmp, undefined);
  assert.equal(meta.icc, undefined);
  assert.equal(out.png.includes(Buffer.from('private owner')), false);
  // Only the chunks a plain image needs.
  assert.deepEqual([...new Set(chunks(out.png))].filter((c) => !['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'PLTE', 'tRNS'].includes(c)), []);
  // A PNG with a text chunk loses it as well.
  const withText = Buffer.concat([MAGIC, pngChunk('IHDR', ihdr(32, 32)), pngChunk('tEXt', Buffer.from('Comment\0a secret note')), pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 32 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(96, 90)]))))), pngChunk('IEND', Buffer.alloc(0))]);
  const cleaned = await normalizeAvatar(withText);
  assert.equal(cleaned.png.includes(Buffer.from('a secret note')), false);
  assert.ok(!chunks(cleaned.png).includes('tEXt'));
});

test('what is not a plain PNG, JPEG or WebP is refused by its bytes, whatever it is called: SVG, GIF, animation, corrupt, empty, oversized, a pixel bomb', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
  assert.equal(sniffImage(svg), null);
  await assert.rejects(normalizeAvatar(svg), refused(/PNG, JPEG or WebP/));
  await assert.rejects(normalizeAvatar(Buffer.from('GIF89a' + 'x'.repeat(40))), refused(/PNG, JPEG or WebP/));
  await assert.rejects(normalizeAvatar(Buffer.alloc(0)), refused(/empty/));
  await assert.rejects(normalizeAvatar(Buffer.alloc(PERSONA_AVATAR.inputBytes + 1, 1)), refused(/larger than 3 MB/));

  const png = await solid(64, 64, '#ff0000').png().toBuffer();
  await assert.rejects(normalizeAvatar(Buffer.concat([png.subarray(0, 40), Buffer.alloc(30, 7)])), refused(/can’t be read/));
  const jpeg = await solid(64, 64, '#00ff00', 3).jpeg().toBuffer();
  await assert.rejects(normalizeAvatar(jpeg.subarray(0, 60)), refused(/can’t be read/));
  // A file that claims one thing in its first bytes and is another inside is whatever libvips finds, never what it says.
  await assert.rejects(normalizeAvatar(Buffer.concat([MAGIC, Buffer.from('this is not a png')])), refused(/can’t be read/));

  // Animation: an animated WebP (two frames) and an APNG (an acTL chunk).
  const frames = await Promise.all(['#0000ff', '#ff0000'].map((c) => solid(32, 32, c, 3).raw().toBuffer()));
  const animated = await sharp(Buffer.concat(frames), { raw: { width: 32, height: 64, channels: 3, pageHeight: 32 } } as never).webp({ loop: 0, delay: [100, 100] } as never).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  await assert.rejects(normalizeAvatar(animated), refused(/animated/));
  const apng = Buffer.concat([MAGIC, pngChunk('IHDR', ihdr(32, 32)), pngChunk('acTL', Buffer.alloc(8)), pngChunk('IDAT', deflateSync(Buffer.alloc(32 * (1 + 96)))), pngChunk('IEND', Buffer.alloc(0))]);
  await assert.rejects(normalizeAvatar(apng), refused(/animated/));

  // A tiny file that declares 30,000 x 30,000 pixels is refused before anything is allocated for it.
  const bomb = Buffer.concat([MAGIC, pngChunk('IHDR', ihdr(30_000, 30_000)), pngChunk('IDAT', deflateSync(Buffer.alloc(100))), pngChunk('IEND', Buffer.alloc(0))]);
  await assert.rejects(normalizeAvatar(bomb), refused(/can’t be read/));
  // And an image too small to be a picture.
  await assert.rejects(normalizeAvatar(await solid(8, 8, '#000000').png().toBuffer()), refused(/too small/));
});

test('a detailed image that would be heavy is stored lighter instead of refused, within the size cap', async () => {
  const noise = Buffer.alloc(1024 * 1024 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
  const big = await sharp(noise, { raw: { width: 1024, height: 1024, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(big.length <= PERSONA_AVATAR.inputBytes + 1024 * 1024);
  const out = await normalizeAvatar(big.length > PERSONA_AVATAR.inputBytes ? await sharp(big).jpeg({ quality: 60 }).toBuffer() : big);
  assert.ok(out.png.length <= PERSONA_AVATAR.outputBytes, `${out.png.length} bytes`);
});
