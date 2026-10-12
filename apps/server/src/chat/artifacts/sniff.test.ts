import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileClass, isInlineType, looksTextual, sniff } from './sniff.js';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** A PNG header that says it is `w` by `h`. */
function png(w: number, h: number): Buffer {
  const b = Buffer.from(PNG_1X1);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** A JPEG with an EXIF-like APP1 segment first, then a start-of-frame saying `w` by `h`. */
function jpeg(w: number, h: number, app1 = 40): Buffer {
  const app = Buffer.concat([Buffer.from([0xff, 0xe1, (app1 + 2) >> 8, (app1 + 2) & 0xff]), Buffer.alloc(app1)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, sof, Buffer.from([0xff, 0xd9])]);
}

function webpX(w: number, h: number): Buffer {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(24, 4);
  b.write('WEBPVP8X', 8, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

const ftyp = (brand: string, compat: string[] = []) => {
  const b = Buffer.alloc(16 + compat.length * 4 + 16);
  b.writeUInt32BE(16 + compat.length * 4, 0);
  b.write('ftyp', 4, 'latin1');
  b.write(brand, 8, 'latin1');
  compat.forEach((c, i) => b.write(c, 16 + i * 4, 'latin1'));
  return b;
};

test('sniff: the four image types the API takes, with their size from the header', () => {
  const p = sniff(png(640, 480), 'shot.png', 5000);
  assert.deepEqual([p.mediaType, p.preview, p.reach, p.width, p.height, p.claudeImage], ['image/png', 'image', 'sees', 640, 480, true]);
  const j = sniff(jpeg(1920, 1080, 70000), 'p.jpg', 200_000); // EXIF can be big: the frame header still has to be found
  assert.deepEqual([j.mediaType, j.width, j.height, j.claudeImage], ['image/jpeg', 1920, 1080, true]);
  const g = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x10, 0x00, 0x20, 0x00]), Buffer.alloc(8)]);
  assert.deepEqual([sniff(g, 'a.gif', 100).mediaType, sniff(g, 'a.gif', 100).width, sniff(g, 'a.gif', 100).height], ['image/gif', 16, 32]);
  const w = sniff(webpX(800, 600), 'a.webp', 100);
  assert.deepEqual([w.mediaType, w.width, w.height, w.claudeImage], ['image/webp', 800, 600, true]);
});

test('sniff: an image the API would refuse is not shown to Claude (too big, too wide, size unknown) but still previews', () => {
  const big = sniff(png(1000, 1000), 'big.png', 5_000_001);
  assert.deepEqual([big.preview, big.claudeImage, big.reach], ['image', false, 'path']);
  const wide = sniff(png(9000, 100), 'wide.png', 1000);
  assert.deepEqual([wide.preview, wide.claudeImage, wide.reach], ['image', false, 'path']);
  const unknown = sniff(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]), 'cut.jpg', 100);
  assert.deepEqual([unknown.mediaType, unknown.claudeImage, unknown.width], ['image/jpeg', false, undefined]);
});

test('sniff: the bytes decide, not the name or the claim', () => {
  assert.equal(sniff(PNG_1X1, 'holiday.jpg', 100).mediaType, 'image/png', 'a PNG named .jpg is a PNG');
  const script = Buffer.from('<script>alert(1)</script>');
  const fake = sniff(script, 'cat.png', script.length);
  assert.notEqual(fake.preview, 'image', 'a .png that is not an image never previews as one');
  assert.equal(fake.mediaType, 'text/plain');
  assert.equal(sniff(Buffer.from('%PDF-1.7\n...'), 'x.txt', 20).mediaType, 'application/pdf');
  assert.equal(sniff(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), 'notes.txt', 100).mediaType, 'application/x-executable', 'an executable named .txt stays an executable');
});

test('sniff: documents, audio, video and archives', () => {
  assert.deepEqual(
    ((s) => [s.mediaType, s.preview, s.reach])(sniff(Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj'), 'report.pdf', 1000)),
    ['application/pdf', 'pdf', 'reads'],
  );
  assert.deepEqual(((s) => [s.mediaType, s.preview, s.reach])(sniff(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00\xff\xfb\x90\x00'), 'a.mp3', 100)), ['audio/mpeg', 'audio', 'path']);
  assert.equal(sniff(Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt '), Buffer.alloc(20)]), 'a.wav', 100).mediaType, 'audio/wav');
  assert.equal(sniff(Buffer.concat([Buffer.from('OggS\x00\x02'), Buffer.from('\x01vorbis'), Buffer.alloc(20)]), 'a.ogg', 100).mediaType, 'audio/ogg');
  assert.equal(sniff(Buffer.concat([Buffer.from('OggS\x00\x02'), Buffer.from('\x80theora'), Buffer.alloc(20)]), 'a.ogv', 100).mediaType, 'video/ogg');
  assert.equal(sniff(Buffer.from('fLaC\x00\x00\x00\x22'), 'a.flac', 100).mediaType, 'audio/flac');
  assert.equal(sniff(ftyp('isom', ['isom', 'mp42']), 'clip.mp4', 1000).mediaType, 'video/mp4');
  assert.equal(sniff(ftyp('M4A ', ['M4A ', 'mp42']), 'voice.m4a', 1000).mediaType, 'audio/mp4');
  assert.equal(sniff(ftyp('qt  '), 'movie.mov', 1000).mediaType, 'video/quicktime');
  assert.equal(sniff(ftyp('heic', ['mif1']), 'IMG_0001.HEIC', 1000).mediaType, 'image/heic');
  assert.equal(sniff(ftyp('heic', ['mif1']), 'IMG_0001.HEIC', 1000).preview, 'none', 'a format browsers mostly can not show only downloads');
  assert.equal(sniff(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84]), Buffer.from('webm')]), 'a.webm', 100).mediaType, 'video/webm');
  assert.equal(sniff(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88, 0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61]), 'a.mkv', 100).preview, 'none', 'Matroska is not played in a browser');
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  assert.equal(sniff(zip, 'pack.zip', 100).mediaType, 'application/zip');
  assert.equal(sniff(zip, 'brief.docx', 100).mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(sniff(zip, 'brief.docx', 100).reach, 'path', 'Claude gets the path of an Office file, and can run tools on it');
  assert.equal(sniff(Buffer.from([0x1f, 0x8b, 8, 0]), 'x.tgz', 100).mediaType, 'application/gzip');
});

test('sniff: text is text, refined by its name; HTML previews only in a sandbox; SVG only downloads', () => {
  const t = (text: string, name: string) => sniff(Buffer.from(text), name, text.length);
  assert.deepEqual(((s) => [s.mediaType, s.preview, s.reach, s.textual])(t('a,b\n1,2\n', 'data.csv')), ['text/csv', 'text', 'reads', true]);
  assert.equal(t('# Title\n', 'README.md').mediaType, 'text/markdown');
  assert.equal(t('{"a":1}', 'x.json').mediaType, 'application/json');
  assert.equal(t('print(1)\n', 'x.py').mediaType, 'text/x-python');
  assert.equal(t('hello', 'noext').mediaType, 'text/plain');
  assert.deepEqual(((s) => [s.mediaType, s.preview])(t('<!DOCTYPE html><html><body>hi</body></html>', 'page.html')), ['text/html', 'html']);
  assert.deepEqual(((s) => [s.mediaType, s.preview])(t('<html><script>1</script></html>', 'index')), ['text/html', 'html'], 'HTML without a name that says so is still HTML');
  assert.deepEqual(((s) => [s.mediaType, s.preview, s.reach])(t('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>', 'logo.svg')), ['image/svg+xml', 'none', 'reads']);
  assert.equal(t('<svg xmlns="http://www.w3.org/2000/svg"/>', 'logo.png').mediaType, 'image/svg+xml', 'an SVG named .png is still an SVG, and downloads');
  assert.equal(sniff(Buffer.from('\u{feff}a,b\n'), 'x.csv', 20).mediaType, 'text/csv', 'a BOM is no problem');
  assert.equal(sniff(Buffer.alloc(0), 'empty.txt', 0).mediaType, 'text/plain');
});

test('sniff: binary content is not text, and a multi-byte character cut at the sample end is not an error', () => {
  assert.equal(looksTextual(Buffer.from([0x68, 0x69, 0x00, 0x21]), false), false, 'a NUL byte');
  assert.equal(looksTextual(Buffer.from([0x68, 0x69, 0xc3, 0x28]), false), false, 'invalid UTF-8');
  assert.equal(looksTextual(Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00]), false), false, 'a byte order mark in front of something that is not UTF-16');
  assert.equal(looksTextual(Buffer.from('\ufeffhello', 'utf16le'), false), true, 'UTF-16 with its mark');
  assert.equal(looksTextual(Buffer.from(Array.from({ length: 200 }, (_, i) => (i % 8 === 0 ? 7 : 65))), false), false, 'a lot of control bytes');
  const euro = Buffer.from('€'); // three bytes
  assert.equal(looksTextual(Buffer.concat([Buffer.from('price '), euro.subarray(0, 2)]), true), true, 'cut mid-character: only the start of a longer file');
  assert.equal(looksTextual(Buffer.concat([Buffer.from('price '), euro.subarray(0, 2)]), false), false, 'the whole file ending mid-character is not text');
  assert.equal(sniff(Buffer.from([1, 2, 3, 4, 0, 5, 6]), 'blob.bin', 7).mediaType, 'application/octet-stream');
  assert.deepEqual(((s) => [s.preview, s.reach, s.textual])(sniff(Buffer.from([1, 2, 3, 4, 0, 5, 6]), 'blob.bin', 7)), ['none', 'path', false]);
});

test('isInlineType and fileClass: what a browser may show from the portal, and the icon family', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'audio/mpeg', 'video/mp4', 'video/webm']) assert.ok(isInlineType(t), t);
  for (const t of ['image/svg+xml', 'text/html', 'text/plain', 'application/zip', 'application/octet-stream', 'application/javascript', 'application/xhtml+xml', 'text/xml', 'image/x-icon', 'video/x-matroska']) assert.ok(!isInlineType(t), t);
  assert.deepEqual(
    [
      fileClass('image/png', 'a.png'),
      fileClass('application/pdf', 'a.pdf'),
      fileClass('audio/mpeg', 'a.mp3'),
      fileClass('video/mp4', 'a.mp4'),
      fileClass('text/html', 'a.html'),
      fileClass('text/csv', 'a.csv'),
      fileClass('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a.xlsx'),
      fileClass('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx'),
      fileClass('application/zip', 'a.zip'),
      fileClass('text/x-python', 'a.py'),
      fileClass('application/octet-stream', 'a.bin'),
    ],
    ['image', 'pdf', 'audio', 'video', 'html', 'sheet', 'sheet', 'doc', 'archive', 'text', 'file'],
  );
});
