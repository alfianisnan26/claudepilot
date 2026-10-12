// The portal's own redaction of CI text by VALUE: the secrets delivered into a workspace, found in any form a tool prints them
// (chat/valueRedact.ts, the same redactor the chat uses). The runner already masks the secrets a job names as they are written;
// this covers every other secret the workspace holds (an exposed one a step happens to print) before anything is stored or shown.
import { NO_VALUES, SessionStream, ValueRedactor } from '../chat/valueRedact.js';

const CACHE_MS = 30_000;

/** `secretValues` gives a workspace's exposed secret values (or throws when they can't be read: then only shapes apply). */
export function valueRedactors(secretValues: (workspaceId: string) => readonly string[]) {
  const kept = new Map<string, { at: number; redactor: ValueRedactor }>();
  const of = (workspaceId: string): ValueRedactor => {
    const now = Date.now();
    const hit = kept.get(workspaceId);
    if (hit && now - hit.at < CACHE_MS) return hit.redactor;
    let redactor = NO_VALUES;
    try {
      redactor = new ValueRedactor(secretValues(workspaceId));
    } catch {
      // Locked, or no Secrets & env: nothing to redact by value
    }
    kept.set(workspaceId, { at: now, redactor });
    return redactor;
  };
  return {
    /** Text with the workspace's secret values taken out. */
    redactFor: (workspaceId: string) => (text: string) => of(workspaceId).redact(text),
    /** A stream for a live read: secret values out first, then credential shapes, holding back a tail that could still become one. */
    streamFor: (workspaceId: string) => new SessionStream(of(workspaceId)),
  };
}
