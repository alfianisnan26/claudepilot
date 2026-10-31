import type {
  ReporterCaptureMode,
  ReporterContextCounts,
  ReporterDeviceInfo,
  ReporterMe,
  ReporterPageInfo,
  ReporterAnnotation,
  ReporterBuildInfo,
  ReporterEvidence,
  ReporterPanelMessage,
  ReporterReportTarget,
  ReporterReview,
  ReporterSessionTargetStatus,
  ReporterStatus,
} from '@portal/contracts';
import { createContext, useContext } from 'react';
import type { ReporterClient } from './api';

/** A capture the SDK sent back: screenshot bytes, evidence and an object URL for the preview. */
export interface Capture {
  captureId: string;
  requestId: string;
  /**
   * What is uploaded as the screenshot (and attached to a chat message): the original, or, once a mark blurs something, the flattened
   * image itself (the original then never leaves the panel).
   */
  screenshot: Blob;
  /** What the strip and the viewer show: the annotated image when there are marks. */
  previewUrl: string;
  /** The marks drawn on it (annotation editor), as they are sent with the capture. */
  annotations?: ReporterAnnotation[];
  /** The flattened image when there are marks and none blurs: uploaded as kind `annotated` beside the original. */
  annotated?: Blob;
  /** The un-annotated screenshot, kept in the panel only so it can be annotated again; never uploaded once a mark blurs. */
  original?: { blob: Blob; url: string };
  evidence: ReporterEvidence;
  /** What the capture toolbar's Ticket | Session switch said (host message), if it said anything. */
  target?: ReporterReportTarget;
}

export type Tab = 'tickets' | 'report' | 'sessions' | 'knowledge' | 'settings';

export interface PanelState {
  client: ReporterClient;
  bucket: string;
  origin: string;
  status: ReporterStatus;
  page: { url: string; title: string } | null;
  build: ReporterBuildInfo | null;
  sdkVersion: string;
  actorLabel: string | null;
  /** The panel is on a phone-like device (touch first): Snap instead of Full page, no hotkeys. */
  coarse: boolean;
  post(msg: ReporterPanelMessage): void;
  notify(text: string, tone?: 'info' | 'error' | 'ok'): void;
  /** Bumps when tickets changed (events, a filed report): lists reload. */
  tick: number;
  refresh(): void;
  tab: Tab;
  setTab(t: Tab): void;
  /** The ticket open in the Tickets tab (the showcase's detail card). */
  selected: string | null;
  select(key: string | null): void;
  /** The capture the host could not show here (other page or gone). */
  missing: { key: string; captureId: string | null; reason: 'other-page' | 'not-found' } | null;
  /** What the host's showcase shows now (null when it ended). */
  focused: { key: string; captureId: string } | null;
  /** Ask the host to show a ticket's capture (spotlight); clears `missing`. */
  focus(key: string, captureId: string | null): void;
  /** The open draft review (the default destination of a capture once started). */
  review: ReporterReview | null;
  setReview(r: ReporterReview | null): void;
  reloadReview(): Promise<void>;
  /** The newest shot of the report being written (null: none). */
  capture: Capture | null;
  /** Replaces every shot with this one (null clears them all). */
  setCapture(c: Capture | null): void;
  /** Every shot of the report being written, oldest first (the form's strip). */
  shots: Capture[];
  removeShot(captureId: string): void;
  /** The annotation editor's result for a shot: its marks (none: back to the original) and the flattened image. */
  annotateShot(captureId: string, marks: ReporterAnnotation[], image: Blob | null): void;
  pending: string | null;
  /** Asks the SDK for a capture; `append` adds it to the shots instead of starting a new report. */
  requestCapture(mode: ReporterCaptureMode, precise?: boolean, append?: boolean): void;
  /** The session the in-panel chat shows (Sessions tab), with what led there; null: the session list. */
  chat: ChatOpen | null;
  openChat(c: ChatOpen | null): void;
  /** What the SDK says the next report would carry (pilot-reporter:context); null until it says (an older SDK never does). */
  hostContext: { page: ReporterPageInfo; device: ReporterDeviceInfo; build: ReporterBuildInfo; counts: ReporterContextCounts } | null;
  /** /me: the token's facts and the client address the portal sees. */
  me: ReporterMe | null;
  /** Shows the Context sheet ("What's sent" on the report form opens it at its second section). */
  showContext(section?: 'context' | 'carries'): void;
  targets: ReporterSessionTargetStatus[];
  /** The last Ticket | Session choice the host's capture toolbar sent (capture-started or capture-result); null when it never said. */
  hostTarget: ReporterReportTarget | null;
  /** The panel's current Ticket | Session choice (what the SDK's capture toolbar starts on). */
  choice: ReporterReportTarget;
  /** Sets the choice and tells the SDK (`pilot-reporter:target`). */
  setChoice(t: ReporterReportTarget): void;
  signOut(): void;
  calloutsVisible: boolean;
  setCalloutsVisible(v: boolean): void;
  hotkeys: Record<'report' | 'crop' | 'callouts' | 'panel', string>;
  setHotkeys(h: Record<'report' | 'crop' | 'callouts' | 'panel', string>): void;
}

/** The chat the panel opens: a session, and when a direct ask led there, the ticket it filed and whether delivery failed. */
export interface ChatOpen {
  sessionId: string;
  /** The ticket a direct ask filed (a header chip links it). */
  ticketKey?: string | null;
  /** The direct ask's delivery failed: shown in the chat with Retry. */
  failed?: { reason: string } | null;
  /** What Retry sends as a chat message when delivery failed: the question and the first shot. */
  retry?: { text: string; image: Blob | null } | null;
}

export const PanelContext = createContext<PanelState | null>(null);

export function usePanel(): PanelState {
  const v = useContext(PanelContext);
  if (!v) throw new Error('usePanel outside the panel');
  return v;
}

export const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
