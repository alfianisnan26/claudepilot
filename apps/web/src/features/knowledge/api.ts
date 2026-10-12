import { isApiErrorBody, isApiSuccess } from '@isnanme/core';
import { track } from '@isnanme/ui';
import {
  GRAPH_API,
  KNOWLEDGE_API,
  type GraphQuery,
  type GraphResponse,
  type CreateVaultRequest,
  type KnowledgeSource,
  type NoteBacklink,
  type NoteHistory,
  type NoteMention,
  type NoteQuickHit,
  type NoteSearchResult,
  type NoteVersion,
  type NoteView,
  type RenameNoteResult,
  type UpdateVaultRequest,
  type VaultActivityEntry,
  type VaultDaily,
  type VaultHealth,
  type VaultImportPolicy,
  type VaultImportReport,
  type VaultSummary,
  type VaultTagCount,
  type VaultTree,
  type VaultTreeEntry,
  type WriteNoteResult,
} from '@portal/contracts';
import { api, ApiError } from '@/lib/api';

/**
 * The knowledge routes (`/api/knowledge`). The same contract as lib/api's client: `{ data }` on success, an
 * ApiError otherwise (a 409 carries the current version and text in `details`). On 401 it asks lib/api for
 * the admin state once, which tells the app the session ended the way every other call does.
 */
async function request<T>(method: string, path: string, body?: unknown, raw?: { bytes: Blob | ArrayBuffer; type: string }): Promise<T> {
  let res: Response;
  try {
    res = await track(
      fetch(path, {
        method,
        credentials: 'same-origin',
        headers: raw ? { 'Content-Type': raw.type } : body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: raw ? raw.bytes : body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server.', 0);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok && isApiSuccess<T>(json)) return json.data;
  if (res.status === 401) void api.adminState().catch(() => undefined);
  if (isApiErrorBody(json)) throw new ApiError(json.error.code, json.error.message, res.status, json.error.details);
  throw new ApiError('INTERNAL_ERROR', `Unexpected response (${res.status}).`, res.status);
}

const enc = encodeURIComponent;

export const knowledgeApi = {
  sources: () => request<KnowledgeSource[]>('GET', KNOWLEDGE_API.sources),
  vaults: () => request<VaultSummary[]>('GET', KNOWLEDGE_API.vaults),
  vault: (id: string) => request<VaultSummary>('GET', KNOWLEDGE_API.vault(id)),
  createVault: (body: CreateVaultRequest) => request<VaultSummary>('POST', KNOWLEDGE_API.vaults, body),
  updateVault: (id: string, body: UpdateVaultRequest) => request<VaultSummary>('PATCH', KNOWLEDGE_API.vault(id), body),
  deleteVault: (id: string, name: string) => request<{ ok: true }>('DELETE', KNOWLEDGE_API.vault(id), { name }),
  rescan: (id: string) => request<VaultSummary>('POST', KNOWLEDGE_API.rescan(id)),
  /** A zip, raw: into a new vault, or into `into`. */
  importZip: (file: File, o: { name?: string; into?: string; policy?: VaultImportPolicy } = {}) =>
    request<VaultImportReport>(
      'POST',
      `${KNOWLEDGE_API.importZip}?filename=${enc(file.name)}${o.name ? `&name=${enc(o.name)}` : ''}${o.into ? `&into=${enc(o.into)}` : ''}${o.policy ? `&policy=${o.policy}` : ''}`,
      undefined,
      { bytes: file, type: 'application/zip' },
    ),
  exportUrl: (id: string) => KNOWLEDGE_API.exportZip(id),
  tree: (id: string, folder = '') => request<VaultTree>('GET', KNOWLEDGE_API.tree(id, folder)),
  recent: (id: string) => request<VaultTreeEntry[]>('GET', KNOWLEDGE_API.recent(id)),
  note: (id: string, path: string) => request<NoteView>('GET', KNOWLEDGE_API.note(id, path)),
  putNote: (id: string, path: string, body: { content: string; baseVersion?: string; create?: boolean }) => request<WriteNoteResult>('PUT', KNOWLEDGE_API.note(id, path), body),
  deleteNote: (id: string, path: string) => request<{ ok: true }>('DELETE', KNOWLEDGE_API.note(id, path)),
  appendNote: (id: string, path: string, text: string, heading?: string) => request<WriteNoteResult>('POST', KNOWLEDGE_API.noteAction(id, 'append'), { path, text, heading }),
  renameNote: (id: string, from: string, to: string, rewriteLinks?: boolean) => request<RenameNoteResult>('POST', KNOWLEDGE_API.noteAction(id, 'rename'), { from, to, rewriteLinks }),
  restore: (id: string, path: string, version: number) => request<WriteNoteResult>('POST', KNOWLEDGE_API.noteAction(id, 'restore'), { path, version }),
  history: (id: string, path: string) => request<NoteHistory>('GET', KNOWLEDGE_API.noteAction(id, 'history', path)),
  version: (id: string, path: string, version: number) => request<NoteVersion>('GET', `${KNOWLEDGE_API.noteAction(id, 'version', path)}&id=${version}`),
  backlinks: (id: string, path: string) => request<NoteBacklink[]>('GET', KNOWLEDGE_API.noteAction(id, 'backlinks', path)),
  mentions: (id: string, path: string) => request<NoteMention[]>('GET', KNOWLEDGE_API.noteAction(id, 'mentions', path)),
  embed: (id: string, path: string, heading?: string | null, block?: string | null) => request<{ path: string; text: string }>('GET', KNOWLEDGE_API.embed(id, path, heading, block)),
  fileUrl: (id: string, path: string) => KNOWLEDGE_API.file(id, path),
  uploadFile: (id: string, path: string, file: File) =>
    request<{ path: string; size: number }>('PUT', KNOWLEDGE_API.file(id, path), undefined, { bytes: file, type: file.type || 'application/octet-stream' }),
  makeFolder: (id: string, path: string) => request<{ ok: true }>('POST', `${KNOWLEDGE_API.vault(id)}/folder`, { path }),
  search: (id: string, q: string, extra = '') => request<NoteSearchResult>('GET', KNOWLEDGE_API.search(id, q, extra)),
  quick: (id: string, q: string) => request<NoteQuickHit[]>('GET', KNOWLEDGE_API.quick(id, q)),
  tags: (id: string) => request<VaultTagCount[]>('GET', KNOWLEDGE_API.tags(id)),
  health: (id: string) => request<VaultHealth>('GET', KNOWLEDGE_API.health(id)),
  daily: (id: string, date = '') => request<VaultDaily>('GET', KNOWLEDGE_API.daily(id, date)),
  appendDaily: (id: string, text: string, date?: string) => request<WriteNoteResult & { date: string }>('POST', KNOWLEDGE_API.daily(id), { text, date }),
  activity: (id: string) => request<VaultActivityEntry[]>('GET', KNOWLEDGE_API.activity(id)),
  graph: (q: GraphQuery) => request<GraphResponse>('GET', GRAPH_API.graph(q)),
};

export const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** The current version and text a 409 carries, when it was a note conflict. */
export function conflictOf(e: unknown): { currentVersion: string | null; content: string | null; deleted: boolean } | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const d = e.details as { reason?: string; currentVersion?: string | null; content?: string | null; deleted?: boolean } | undefined;
  if (!d || (d.reason !== 'CONFLICT' && d.reason !== 'EXISTS')) return null;
  return { currentVersion: d.currentVersion ?? null, content: d.content ?? null, deleted: d.deleted === true };
}
