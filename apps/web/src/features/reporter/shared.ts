import type { ReporterAnchor, ReporterCheckFinding, ReporterDeploymentState, ReporterWorkPhase } from '@portal/contracts';

/*
 * Pure helpers shared by the reporter panel (src/embed) and the owner's views (ticket evidence, bucket settings). No React, no app
 * imports: the panel entry stays small.
 */

export const PHASE_LABEL: Record<ReporterWorkPhase, string> = {
  open: 'Open',
  working: 'Working',
  review: 'Review',
  fixed: 'Fixed',
  deployed: 'Deployed',
  'wont-do': 'Won’t do',
};

/** Tailwind classes per phase (token colours, so light and dark both hold). */
export const PHASE_TONE: Record<ReporterWorkPhase, string> = {
  open: 'bg-danger-soft text-danger',
  working: 'bg-flame-soft text-flame',
  review: 'bg-gold-soft text-gold',
  fixed: 'bg-accent-soft text-accent',
  deployed: 'bg-accent text-primary-ink',
  'wont-do': 'bg-surface-2 text-muted',
};

export const DEPLOY_MARK: Record<ReporterDeploymentState['status'], string> = { deployed: '✓', 'not-deployed': '–', unknown: '?' };

export const DEPLOY_REASON: Record<NonNullable<ReporterDeploymentState['reason']>, string> = {
  'no-fix-commit': 'No fix commit known yet',
  'no-build-seen': 'No build seen in this environment',
  'ancestry-unchecked': 'Could not check whether the build contains the fix',
};

/** A deployed state seen only by the widget (no pipeline for that environment yet): shown with a lower-confidence marker. */
export const isObserved = (d: ReporterDeploymentState): boolean => d.confidence === 'observed';

/** The mark of one environment: ✓ – ?, and ✓* when "deployed" rests on a widget-observed build rather than a pipeline. */
export const deployMark = (d: ReporterDeploymentState): string => (d.status === 'deployed' && isObserved(d) ? `${DEPLOY_MARK.deployed}*` : DEPLOY_MARK[d.status]);

export const OBSERVED_NOTE = 'seen by the widget, no pipeline yet';

/** "stg ✓ · uat – · prod ?" in the server's order. */
export function envStrip(deployments: ReporterDeploymentState[]): string {
  return deployments.map((d) => `${d.environment} ${deployMark(d)}`).join(' · ');
}

/** One environment's state in words, for a tooltip or a screen reader. */
export function deploymentText(d: ReporterDeploymentState): string {
  const short = (c: string | null) => (c ? c.slice(0, 7) : null);
  const seen = isObserved(d) ? `, ${OBSERVED_NOTE}` : '';
  if (d.status === 'deployed') return `${d.environment}: deployed${d.fixCommit ? ` (fix ${short(d.fixCommit)})` : ''}${d.currentCommit ? ` in ${short(d.currentCommit)}` : ''}${seen}`;
  if (d.status === 'not-deployed') return `${d.environment}: not deployed${d.currentCommit ? ` (live ${short(d.currentCommit)})` : ''}${seen}`;
  return `${d.environment}: unknown${d.reason ? `, ${DEPLOY_REASON[d.reason].toLowerCase()}` : ''}`;
}

const REASON_SHORT: Record<NonNullable<ReporterDeploymentState['reason']>, string> = {
  'no-fix-commit': 'no fix commit yet',
  'no-build-seen': 'no build seen yet',
  'ancestry-unchecked': 'could not check the build',
};

/** One environment as the panel's ticket card lists it: "stg: unknown (no fix commit yet)", "uat: deployed (live abc1234)". */
export function deployLine(d: ReporterDeploymentState): string {
  const live = d.currentCommit ? `live ${d.currentCommit.slice(0, 7)}` : '';
  const seen = isObserved(d) ? OBSERVED_NOTE : '';
  const why = d.status === 'unknown' ? (d.reason ? REASON_SHORT[d.reason] : '') : [live, seen].filter(Boolean).join(', ');
  const word = d.status === 'deployed' ? 'deployed' : d.status === 'not-deployed' ? 'not yet' : 'unknown';
  return `${d.environment}: ${word}${why ? ` (${why})` : ''}`;
}

/** A capture's caption: "Shot 1 · /pricing", the root named ("Shot 1 · / (home)") so a lone slash reads as a page. */
export function shotCaption(index: number, pathOrUrl: string): string {
  const p = pathnameOf(pathOrUrl);
  return `Shot ${index} · ${p === '/' ? '/ (home)' : p}`;
}

/** "Not captured: image not readable (no CORS): cdn.example; canvas: drawn blank", or null when the shot is complete (or the SDK is older). */
export function gapsLine(e: { captureGaps?: string[] }): string | null {
  const gaps = (e.captureGaps ?? []).filter((g) => g.trim());
  return gaps.length ? `Not captured: ${gaps.join('; ')}` : null;
}

export const SEVERITIES: ReporterCheckFinding['severity'][] = ['critical', 'serious', 'moderate', 'minor'];

export function countBySeverity(findings: ReporterCheckFinding[]): Record<ReporterCheckFinding['severity'], number> {
  const out = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of findings) if (f.severity in out) out[f.severity]++;
  return out;
}

/** The path part of an anchor path or URL ("/pricing?x=1" -> "/pricing"), trailing slash dropped (but "/" stays). */
export function pathnameOf(pathOrUrl: string): string {
  let p = pathOrUrl;
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    // keep it as given
  }
  p = p.split('#')[0]!.split('?')[0]!;
  if (!p.startsWith('/')) p = `/${p}`;
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

export const samePage = (a: string, b: string) => pathnameOf(a) === pathnameOf(b);

export interface Box {
  /** Percent of the image's width or height. */
  left: number;
  top: number;
  width: number;
  height: number;
}

const near = (a: number, b: number, tol = 0.03) => Math.abs(a - b) <= tol * Math.max(a, b);

/**
 * Where an anchor's selection sits on its screenshot, in percent of the image, or null when there is nothing to draw (a full-page
 * report, or a screenshot that already IS the crop). The SDK may ship the visible screen (phone Snap), the whole document (desktop
 * full page) or the cropped area; the image's aspect tells which: a screen shot is offset by the scroll at capture time.
 */
export function cropBox(img: { w: number; h: number }, anchor: ReporterAnchor, scroll: { x: number; y: number } | null): Box | null {
  if (anchor.mode !== 'crop' || img.w <= 0 || img.h <= 0) return null;
  const { rect, viewport } = anchor;
  if (rect.w <= 0 || rect.h <= 0) return null;
  const aspect = img.w / img.h;
  if (near(aspect, rect.w / rect.h) && !near(aspect, viewport.w / viewport.h)) return null;
  const isScreen = viewport.w > 0 && viewport.h > 0 && near(aspect, viewport.w / viewport.h);
  const scale = viewport.w > 0 ? img.w / viewport.w : 1;
  const x = isScreen ? rect.x - (scroll?.x ?? 0) : rect.x;
  const y = isScreen ? rect.y - (scroll?.y ?? 0) : rect.y;
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const left = clamp(((x * scale) / img.w) * 100);
  const top = clamp(((y * scale) / img.h) * 100);
  const width = clamp(((rect.w * scale) / img.w) * 100);
  const height = clamp(((rect.h * scale) / img.h) * 100);
  if (width === 0 || height === 0) return null;
  return { left, top, width: Math.min(width, 100 - left), height: Math.min(height, 100 - top) };
}

/** "abc1234" for a commit, "unknown" for none (shown as a state, never guessed). */
export const shortCommit = (c: string | null | undefined) => (c ? c.slice(0, 7) : null);
