// Chat content (chat-sessions PRD FR30-FR33, FR47; interface I9): the files people attach to a message and
// the artifacts the agent produces. The chat controller holds one {@link ChatContent} and reaches it at a few
// seams only: a send hands it the message's attachments, a tool result is shown to it, and a deleted chat
// is purged through it. Everything else (routes, serving, previews, zips, the portal tool) lives here.

import type { Store } from '../../store/store.js';
import type { Workspaces } from '../../workspaces/manager.js';
import type { StoredEvent } from '../protocol.js';
import { checkAttachments, type AttachmentPlan } from './attachments.js';
import { ArtifactCapture } from './capture.js';
import { expireFiles, sweepOrphans } from './retention.js';
import { unstageSession } from './stage.js';
import { sweepUploads } from './uploads.js';

export { blobFileFor, serveBlob, textPreview, type BlobFile } from './serve.js';
export { checkAttachments, AttachmentPlan } from './attachments.js';
export { fileRef, fileRefs } from './records.js';

export interface ChatContentDeps {
  store: Store;
  workspaces: Workspaces;
  /** Brings cp-session up to date in a workspace (the controller's installer); read when used, since it is set after the controller is built. */
  install: (workspaceId: string) => Promise<void>;
  /** The workspace a session runs in, or null when there is no such session. */
  workspaceOf: (sessionId: string) => string | null;
  /** Adds an event to a session's transcript and returns its sequence number. */
  append: (sessionId: string, ev: StoredEvent) => number | undefined;
  /** Hides secrets in text that is kept (previews, text artifacts): the workspace's secret values first, then credential shapes. */
  redact: (workspaceId: string, text: string) => string;
}

/** How often the housekeeping runs. */
const SWEEP_MS = 60 * 60_000;

export class ChatContent {
  readonly #deps: ChatContentDeps;
  /** Copies out and records what the agent produces. */
  readonly capture: ArtifactCapture;
  #timer: NodeJS.Timeout | undefined;
  #first: NodeJS.Timeout | undefined;

  constructor(deps: ChatContentDeps) {
    this.#deps = deps;
    this.capture = new ArtifactCapture(deps);
  }

  /** Hands a file the agent chose to the person: copied out, recorded and shown as a card (the `artifact_publish` tool). */
  publish(sessionId: string, path: string, name?: string) {
    return this.capture.publish(sessionId, path, name);
  }

  /** An event the controller just stored: a tool that wrote a file, or a turn that ended, may have produced artifacts. */
  observe(sessionId: string, ev: StoredEvent): void {
    this.capture.observe(sessionId, ev);
  }

  /** Validates and resolves a message's attachments (before anything is stored or sent). */
  check(sessionId: string, attachments: unknown): AttachmentPlan {
    return checkAttachments(this.#deps.store, sessionId, attachments);
  }

  /** Writes the plan's uploaded files into the session's uploads folder in the workspace. */
  stage(plan: AttachmentPlan, workspaceId: string): Promise<void> {
    return plan.stage(this.#deps.workspaces, workspaceId, { install: this.#deps.install });
  }

  /** A deleted chat's staged files in the workspace go (best effort: the portal's own copy is deleted with its rows). */
  async purge(workspaceId: string, sessionId: string): Promise<boolean> {
    this.capture.forget(sessionId);
    return unstageSession(this.#deps.workspaces, workspaceId, sessionId, { install: this.#deps.install }).catch(() => false);
  }

  /**
   * Starts the housekeeping: waiting uploads that never got their message, files past their retention, blobs
   * nothing links. Skipped unless the store is writable and delivery is allowed: on a frozen database the tables may not be there.
   */
  start(): void {
    const { store } = this.#deps;
    if (this.#timer || !store.writable || !store.db || !store.deliveryAllowed) return;
    const sweep = () => {
      try {
        if (!store.writable) return;
        sweepUploads(store);
        expireFiles(store);
        sweepOrphans(store);
      } catch {
        // housekeeping never takes the portal down
      }
    };
    // Not in the first moments of startup, when the portal is busy reattaching sessions.
    this.#first = setTimeout(sweep, 60_000);
    this.#first.unref();
    this.#timer = setInterval(sweep, SWEEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#first) clearTimeout(this.#first);
    this.#timer = undefined;
    this.#first = undefined;
  }
}
