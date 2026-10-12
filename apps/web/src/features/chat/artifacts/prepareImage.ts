// Chat content: a photo is made ready in the browser before it is uploaded (chat-sessions PRD FR30). Claude
// Code caps pictures at 2,000 px on the long edge, and a phone photo is several megabytes, so anything bigger
// is scaled down here (and a phone photo's rotation, which lives in its metadata and is lost by whoever reads
// only the pixels, is applied by drawing it). Pictures that are small enough go as they are, so a GIF
// keeps moving and a PNG keeps its transparency.

/** The longest side of what is sent, in pixels. */
export const MAX_SIDE = 2000;
/** What the API takes of one image. */
const MAX_BYTES = 5_000_000;
/** Above this a JPEG is re-encoded even when small in pixels: it is a phone photo whose rotation may be in its metadata. */
const REENCODE_ABOVE = 1_000_000;

const SENT_AS_IS = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface Prepared {
  blob: Blob;
  name: string;
  /** The picture was scaled or re-encoded. */
  changed: boolean;
}

/** Why a picture couldn't be made ready (shown to the person). */
export class ImageProblem extends Error {}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } catch {
    // Older browsers: an <img> (which also applies the rotation).
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function toBlob(canvas: HTMLCanvasElement | OffscreenCanvas, type: string, quality: number): Promise<Blob | null> {
  return 'convertToBlob' in canvas ? canvas.convertToBlob({ type, quality }).catch(() => null) : new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

const withExtension = (name: string, ext: string) => `${name.replace(/\.[A-Za-z0-9]{1,5}$/, '')}.${ext}`;

/**
 * The file to upload for a picked image: as it is when it is small enough, else scaled to {@link MAX_SIDE}
 * (a PNG stays a PNG while that fits, anything else becomes a JPEG). Throws {@link ImageProblem} for a picture
 * the browser can't read and that isn't safe to send untouched.
 */
export async function prepareImage(file: File): Promise<Prepared> {
  const name = file.name || 'image';
  let decoded: Awaited<ReturnType<typeof decode>>;
  try {
    decoded = await decode(file);
  } catch {
    // Can't be read here (a HEIC on a desktop browser, say). One of the four types and under the limit goes as it is.
    if (SENT_AS_IS.has(file.type) && file.size <= MAX_BYTES) return { blob: file, name, changed: false };
    throw new ImageProblem('Can’t read this photo format.');
  }
  try {
    const { width, height } = decoded;
    const long = Math.max(width, height);
    const fits = long <= MAX_SIDE && file.size <= MAX_BYTES;
    const keep = SENT_AS_IS.has(file.type) && fits && !(file.type === 'image/jpeg' && file.size > REENCODE_ABOVE);
    if (keep) return { blob: file, name, changed: false };

    const scale = Math.min(1, MAX_SIDE / long);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas: HTMLCanvasElement | OffscreenCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new ImageProblem('Can’t read this photo format.');
    const asPng = file.type === 'image/png';
    if (!asPng) {
      // JPEG has no transparency: what was clear shows as white, not black.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(decoded.source, 0, 0, w, h);
    let out = asPng ? await toBlob(canvas, 'image/png', 1) : null;
    let ext = 'png';
    if (!out || out.size > MAX_BYTES * 0.9 || out.type !== 'image/png') {
      out = await toBlob(canvas, 'image/jpeg', 0.88);
      ext = 'jpg';
    }
    if (!out) throw new ImageProblem('Can’t read this photo format.');
    if (out.size > MAX_BYTES) throw new ImageProblem('This photo is too large.');
    return { blob: out, name: withExtension(name, ext), changed: true };
  } finally {
    decoded.close();
  }
}
