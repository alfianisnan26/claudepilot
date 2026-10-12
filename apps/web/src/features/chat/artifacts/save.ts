// Chat content: saving a file from the chat (chat-sessions PRD FR47). On a phone that can share files over HTTPS, a
// picture goes to the share sheet ("Save Image" puts it in the photo library, which a plain download link never
// does on iOS); everywhere else the browser downloads it under its own name.

import { fileUrl } from './contentApi';

const coarse = () => typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;

/** Starts a download of `url` as `name` (same-origin, so the `download` attribute is honoured). */
function anchorDownload(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** The download form of a stored file's URL (the portal then sends it as an attachment, whatever the type). */
export const asDownload = (url: string): string => (url.startsWith('data:') || url.startsWith('blob:') ? url : `${url}${url.includes('?') ? '&' : '?'}download=1`);

/**
 * Saves the file at `url` (the URL that shows it) as `name`. A picture on a touch screen that can share
 * files opens the share sheet; if that isn't possible, or for any other file, it is downloaded.
 */
export async function saveUrl(url: string, name: string, mediaType: string): Promise<void> {
  if (mediaType.startsWith('image/') && coarse() && window.isSecureContext && typeof navigator.canShare === 'function') {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (res.ok) {
        const blob = await res.blob();
        const shared = new File([blob], name, { type: mediaType });
        if (navigator.canShare({ files: [shared] })) {
          await navigator.share({ files: [shared] });
          return;
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // the person closed the sheet: that is an answer
    }
  }
  anchorDownload(asDownload(url), name);
}

/** {@link saveUrl} for a file of a chat. */
export const saveFile = (sessionId: string, file: { blobId: string; name: string; mediaType: string }): Promise<void> =>
  saveUrl(fileUrl(sessionId, file.blobId), file.name, file.mediaType);
