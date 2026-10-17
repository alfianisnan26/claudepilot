/** The portal says the feature is off: a 404 from the open or the ports route. Not an error. (Duck-typed on `status`: an `ApiError`.) */
export const isAppOff = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 404;

/** The URL the server returned is only ever loaded when it is https: the app host is always served over TLS. */
export function isHttpsUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export type OpenOutcome = { kind: 'url'; url: string } | { kind: 'off' } | { kind: 'unsafe' } | { kind: 'error'; error: unknown };

/**
 * One call of the open route, read the same way by the frame and by "open in a new tab": the URL, or "the feature is off" (404, a state),
 * or "unsafe" (the URL is not https: it is never loaded), or the error to show.
 */
export async function runOpen(open: () => Promise<{ url: string }>): Promise<OpenOutcome> {
  try {
    const r = await open();
    return isHttpsUrl(r?.url) ? { kind: 'url', url: r.url } : { kind: 'unsafe' };
  } catch (e) {
    return isAppOff(e) ? { kind: 'off' } : { kind: 'error', error: e };
  }
}
