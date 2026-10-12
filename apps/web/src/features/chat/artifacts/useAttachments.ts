// Chat content: the files being attached to the message being written (chat-sessions PRD FR30). Each one
// gets a tile at once; a photo is made ready (prepareImage), then every file is uploaded on its own with
// progress and a way to cancel, a few at a time. A tile is `ready` when the portal has it and has said what it
// is; Send waits for every tile to be ready or gone.

import { CHAT_MAX_ATTACHMENTS, CHAT_MAX_UPLOAD_BYTES, type ChatUpload } from '@portal/contracts';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { discardUpload, uploadFile, type UploadHandle } from './contentApi';
import { formatSize } from './fileKinds';
import { ImageProblem, prepareImage } from './prepareImage';

export interface Attachment {
  key: string;
  /** The name as picked (the portal's version, made safe, is `upload.name` once uploaded). */
  name: string;
  /** Bytes being uploaded (a scaled photo is smaller than what was picked). */
  size: number;
  /** A guess from the browser until the portal says what it sniffed. */
  mediaType: string;
  state: 'preparing' | 'uploading' | 'ready' | 'error';
  /** 0 to 1 while uploading. */
  progress: number;
  upload?: ChatUpload;
  error?: string;
  /** A `blob:` URL of a picture, for its thumbnail while it uploads. */
  thumb?: string;
}

type Action =
  | { type: 'add'; items: Attachment[] }
  | { type: 'patch'; key: string; patch: Partial<Attachment> }
  | { type: 'remove'; key: string }
  | { type: 'set'; items: Attachment[] };

function reduce(state: Attachment[], action: Action): Attachment[] {
  switch (action.type) {
    case 'add':
      return [...state, ...action.items];
    case 'patch':
      return state.map((a) => (a.key === action.key ? { ...a, ...action.patch } : a));
    case 'remove':
      return state.filter((a) => a.key !== action.key);
    case 'set':
      return action.items;
  }
}

/** How many uploads run at once. */
const PARALLEL = 3;
let nextKey = 0;

/** A photo or screenshot the browser prepares (scales, re-encodes) before it goes up; an SVG, a BMP or a TIFF goes as it is and the portal decides. */
const isPhoto = (f: File) => /^image\/(?:png|jpe?g|gif|webp|avif|heic|heif)$/.test(f.type) || (f.type === '' && /\.(?:heic|heif)$/i.test(f.name));
/** What `<img>` shows everywhere: a thumbnail can be made from the file itself. */
const showsInImg = (f: File) => /^image\/(?:png|jpe?g|gif|webp)$/.test(f.type);

export interface AttachmentsApi {
  items: Attachment[];
  /** Whether something is still being made ready or uploaded: Send waits. */
  busy: boolean;
  /** Adds files (picked, pasted or dropped). Problems that stop a file at the door come back as messages. */
  add: (files: File[]) => string[];
  remove: (key: string) => void;
  retry: (key: string) => void;
  /** The uploads ready to go with the message; the tiles are cleared (the files now belong to the message). */
  take: () => ChatUpload[];
  /** Puts back what `take` returned (the send failed). */
  restore: (uploads: ChatUpload[]) => void;
}

/** The attachments of the message being written in one chat. `onProblem` gets short messages for the person. */
export function useAttachments(sessionId: string, onProblem: (message: string) => void): AttachmentsApi {
  const [items, dispatch] = useReducer(reduce, []);
  const itemsRef = useRef<Attachment[]>([]);
  itemsRef.current = items;
  const files = useRef(new Map<string, File>());
  const handles = useRef(new Map<string, UploadHandle>());
  const queue = useRef<string[]>([]);
  const running = useRef(0);
  const alive = useRef(true);
  const problem = useRef(onProblem);
  problem.current = onProblem;

  const patch = useCallback((key: string, p: Partial<Attachment>) => alive.current && dispatch({ type: 'patch', key, patch: p }), []);

  const pump = useCallback(() => {
    while (running.current < PARALLEL && queue.current.length > 0) {
      const key = queue.current.shift()!;
      const file = files.current.get(key);
      if (!file) continue;
      running.current++;
      void (async () => {
        try {
          let blob: Blob = file;
          let name = file.name || 'file';
          if (isPhoto(file)) {
            try {
              const prepared = await prepareImage(file);
              blob = prepared.blob;
              name = prepared.name;
              patch(key, { size: blob.size, name });
            } catch (e) {
              if (e instanceof ImageProblem) throw e;
              // Anything else about decoding: the portal sniffs it and decides.
            }
          }
          if (!files.current.has(key)) return; // removed while it was being prepared
          patch(key, { state: 'uploading', progress: 0 });
          const handle = uploadFile(sessionId, blob, name, (sent, total) => patch(key, { progress: total ? sent / total : 0 }));
          handles.current.set(key, handle);
          const upload = await handle.promise;
          if (!files.current.has(key)) return void discardUpload(sessionId, upload.id); // cancelled just as it finished
          patch(key, { state: 'ready', progress: 1, upload, mediaType: upload.mediaType, name: upload.name, size: upload.size });
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          patch(key, { state: 'error', error: e instanceof Error ? e.message : 'The upload failed.' });
        } finally {
          handles.current.delete(key);
          running.current--;
          pump();
        }
      })();
    }
  }, [sessionId, patch]);

  const add = useCallback(
    (picked: File[]): string[] => {
      const problems: string[] = [];
      const room = Math.max(0, CHAT_MAX_ATTACHMENTS - itemsRef.current.length);
      const accepted: File[] = [];
      const tooBig: string[] = [];
      for (const f of picked) {
        if (f.size > CHAT_MAX_UPLOAD_BYTES && !isPhoto(f)) tooBig.push(f.name || 'file');
        else if (f.size === 0) problems.push(`“${f.name || 'file'}” is empty.`);
        else accepted.push(f);
      }
      if (tooBig.length) problems.push(tooBig.length === 1 ? `“${tooBig[0]}” is over ${formatSize(CHAT_MAX_UPLOAD_BYTES)}.` : `${tooBig.length} files are over ${formatSize(CHAT_MAX_UPLOAD_BYTES)}.`);
      const take = accepted.slice(0, room);
      if (take.length < accepted.length) problems.push(`Up to ${CHAT_MAX_ATTACHMENTS} files per message.`);
      const added: Attachment[] = take.map((f) => {
        const key = `a${++nextKey}`;
        files.current.set(key, f);
        queue.current.push(key);
        return {
          key,
          name: f.name || (isPhoto(f) ? 'image' : 'file'),
          size: f.size,
          mediaType: f.type || 'application/octet-stream',
          state: 'preparing',
          progress: 0,
          thumb: showsInImg(f) ? URL.createObjectURL(f) : undefined,
        };
      });
      if (added.length) {
        dispatch({ type: 'add', items: added });
        pump();
      }
      for (const p of problems) problem.current(p);
      return problems;
    },
    [pump],
  );

  const release = useCallback((a: Attachment) => {
    if (a.thumb) URL.revokeObjectURL(a.thumb);
    files.current.delete(a.key);
    queue.current = queue.current.filter((k) => k !== a.key);
  }, []);

  const remove = useCallback(
    (key: string) => {
      const a = itemsRef.current.find((x) => x.key === key);
      if (!a) return;
      handles.current.get(key)?.abort();
      release(a);
      if (a.upload) discardUpload(sessionId, a.upload.id);
      dispatch({ type: 'remove', key });
    },
    [release, sessionId],
  );

  const retry = useCallback(
    (key: string) => {
      if (!files.current.has(key)) return;
      patch(key, { state: 'preparing', progress: 0, error: undefined });
      queue.current.push(key);
      pump();
    },
    [patch, pump],
  );

  const take = useCallback((): ChatUpload[] => {
    const ready = itemsRef.current.filter((a) => a.state === 'ready' && a.upload);
    for (const a of itemsRef.current) release(a);
    dispatch({ type: 'set', items: [] });
    return ready.map((a) => a.upload!);
  }, [release]);

  const restore = useCallback((uploads: ChatUpload[]) => {
    if (!alive.current || uploads.length === 0) return;
    dispatch({
      type: 'add',
      items: uploads.map((u) => ({ key: `a${++nextKey}`, name: u.name, size: u.size, mediaType: u.mediaType, state: 'ready' as const, progress: 1, upload: u })),
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    const live = files.current;
    const flying = handles.current;
    return () => {
      // Leaving the chat: what is still going up stops; what is ready waits on the portal (it expires there).
      alive.current = false;
      for (const h of flying.values()) h.abort();
      for (const a of itemsRef.current) if (a.thumb) URL.revokeObjectURL(a.thumb);
      live.clear();
    };
  }, []);

  return { items, busy: items.some((a) => a.state === 'preparing' || a.state === 'uploading'), add, remove, retry, take, restore };
}
