import { createHash } from 'node:crypto';
import { AppError } from '@isnanme/core';
import { PERSONA_AVATAR } from '@portal/contracts';
import sharp, { type Sharp } from 'sharp';

// The avatar pipeline (Persona PRD A10, interface I11). An image comes from a person's upload, from a file in a
// workspace or from an agent, so it is hostile input: it is identified by its bytes, decoded by libvips with a
// pixel limit, and re-encoded as a plain square PNG. What the portal stores and serves is never what it was given:
// no SVG or any other type, no animation, no metadata (EXIF, XMP, ICC, text chunks), at most 512 px.
// `sharp` is the one native dependency of the portal: it does the decoding for PNG, JPEG and WebP in libvips, and
// a hand-written parser of three image formats for hostile files would be worse than one library that is fuzzed.

sharp.cache(false);
sharp.concurrency(2);

export type AvatarType = 'png' | 'jpeg' | 'webp';

export interface Avatar {
  /** The re-encoded image: a square, non-animated PNG without metadata. */
  png: Buffer;
  /** Of `png`: the same image from any source has the same address. */
  sha256: string;
  /** Its side in pixels. */
  side: number;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const refuse = (message: string) => new AppError('VALIDATION_FAILED', message, { details: { image: message } });

/** What the bytes are, from their first bytes: never from a file name or a declared type. Null for anything else (SVG, GIF, HEIC…). */
export function sniffImage(bytes: Buffer): AvatarType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** An APNG says so in an `acTL` chunk before its first `IDAT`; libvips would show only its first frame, and we refuse the file rather than guess. */
function animatedPng(bytes: Buffer): boolean {
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    at += 12 + length;
  }
  return false;
}

/** The PNG's size on disk once it is as small as it will get: first lossless, then quantized, then smaller. */
async function encode(pipeline: () => Sharp, side: number): Promise<{ png: Buffer; side: number }> {
  // The picture's own size first, then halves of it down to 64 px.
  const sizes = [side];
  for (let s = Math.floor(side / 2); s >= 64; s = Math.floor(s / 2)) sizes.push(s);
  for (const s of sizes) {
    const base = () => pipeline().resize({ width: s, height: s, fit: 'cover', position: 'centre' }).toColourspace('srgb');
    const lossless = await base().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    if (lossless.length <= PERSONA_AVATAR.outputBytes) return { png: lossless, side: s };
    const quantized = await base().png({ compressionLevel: 9, palette: true, quality: 85, effort: 7 }).toBuffer();
    if (quantized.length <= PERSONA_AVATAR.outputBytes) return { png: quantized, side: s };
  }
  throw refuse('That image is too detailed to keep as an avatar. Use a simpler or smaller one.');
}

/**
 * Checks `input` and returns the avatar made from it, or throws VALIDATION_FAILED saying what's wrong. Nothing of
 * the input survives but its pixels: centred square crop, EXIF orientation applied, converted to sRGB.
 */
export async function normalizeAvatar(input: Buffer): Promise<Avatar> {
  if (input.length === 0) throw refuse('The image is empty.');
  if (input.length > PERSONA_AVATAR.inputBytes) throw refuse(`The image is larger than ${PERSONA_AVATAR.inputBytes / 1024 / 1024} MB.`);
  const type = sniffImage(input);
  if (!type) throw refuse('Use a PNG, JPEG or WebP image.');
  if (type === 'png' && animatedPng(input)) throw refuse('An animated image can’t be an avatar. Use a still one.');
  try {
    const open = () => sharp(input, { limitInputPixels: PERSONA_AVATAR.inputPixels, failOn: 'error' }).rotate();
    const meta = await sharp(input, { limitInputPixels: PERSONA_AVATAR.inputPixels, failOn: 'error' }).metadata();
    if (meta.format !== type) throw refuse('Use a PNG, JPEG or WebP image.');
    if ((meta.pages ?? 1) > 1) throw refuse('An animated image can’t be an avatar. Use a still one.');
    if (!meta.width || !meta.height) throw refuse('That image can’t be read.');
    const side = Math.min(PERSONA_AVATAR.maxSide, meta.width, meta.height);
    if (side < 16) throw refuse('The image is too small: use at least 16 by 16 pixels.');
    const out = await encode(open, side);
    return { png: out.png, sha256: createHash('sha256').update(out.png).digest('hex'), side: out.side };
  } catch (e) {
    if (e instanceof AppError) throw e;
    // libvips says things like "VipsJpeg: Premature end of JPEG file": nothing a person needs, and nothing to pass on.
    throw refuse('That image can’t be read. Use a PNG, JPEG or WebP file that opens on your computer.');
  }
}
