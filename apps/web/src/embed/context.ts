import type {
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
  screenshot: Blob;
  previewUrl: string;
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
  capture: Capture | null;
  setCapture(c: Capture | null): void;
  pending: string | null;
  requestCapture(mode: 'full' | 'crop', precise?: boolean): void;
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

export const PanelContext = createContext<PanelState | null>(null);

export function usePanel(): PanelState {
  const v = useContext(PanelContext);
  if (!v) throw new Error('usePanel outside the panel');
  return v;
}

export const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
