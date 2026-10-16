// T-591 (D-69): the release report's sink on the knowledge vault, as the portal. Moved out of index.ts so it can be tested (no behaviour change).
// Only "no such note" / "no such vault" is an empty answer: any other error (a transient vault failure) is thrown, so a report is never rebuilt from nothing.
import { isKnowledgeError } from '../knowledge/errors.js';
import type { KnowledgeService } from '../knowledge/service.js';
import type { ReleaseNoteSink } from './releaseReporter.js';

type Notes = Pick<KnowledgeService, 'getNote' | 'summary' | 'putNote'>;
type Who = Parameters<Notes['getNote']>[2];

const isNotFound = (e: unknown): boolean => isKnowledgeError(e) && e.reason === 'NOT_FOUND';

export function vaultReleaseNotes(knowledge: Notes, actor: Who): Required<ReleaseNoteSink> {
  /** The note, or null when there is none; any other error is rethrown. */
  const noteOrNull = (vaultId: string, path: string): { content: string; version: string } | null => {
    try {
      return knowledge.getNote(vaultId, path, actor);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  };
  return {
    exists: (vaultId) => {
      try {
        knowledge.summary(vaultId);
        return true;
      } catch (e) {
        if (isNotFound(e)) return false;
        throw e;
      }
    },
    read: (vaultId, path) => noteOrNull(vaultId, path)?.content ?? null,
    // An existing note is replaced with its own version as `baseVersion`; a missing one is created.
    put: (vaultId, path, content) => {
      const version = noteOrNull(vaultId, path)?.version ?? null;
      const r = version ? knowledge.putNote(vaultId, path, { content, baseVersion: version }, actor) : knowledge.putNote(vaultId, path, { content, create: true }, actor);
      return { created: r.created, unchanged: r.unchanged };
    },
  };
}
