import type {
  ReporterBuildInfo,
  ReporterContextCounts,
  ReporterDeviceInfo,
  ReporterEvidence,
  ReporterMe,
  ReporterPageInfo,
  ReporterReportTarget,
  ReporterSessionTargetStatus,
  ReporterStatus,
} from '@portal/contracts';

/* The panel's pure rules for the screenshot viewer, the report form and the Context view (owner, 2026-10-31). Tested directly. */

/* ---------- Viewer ---------- */

export interface Size {
  w: number;
  h: number;
}
export interface View {
  scale: number;
  x: number;
  y: number;
}

/** The scale that fits the whole image in the box (never above 1: a small shot is shown at its size). */
export const fitScale = (img: Size, box: Size) => (img.w > 0 && img.h > 0 && box.w > 0 && box.h > 0 ? Math.min(1, box.w / img.w, box.h / img.h) : 1);

export const MAX_SCALE = 4;

/** The pan kept so the image never leaves a gap it could fill: centred when it is smaller than the box on an axis. */
export function clampView(v: View, img: Size, box: Size): View {
  const w = img.w * v.scale;
  const h = img.h * v.scale;
  const x = w <= box.w ? (box.w - w) / 2 : Math.min(0, Math.max(box.w - w, v.x));
  const y = h <= box.h ? (box.h - h) / 2 : Math.min(0, Math.max(box.h - h, v.y));
  return { scale: v.scale, x, y };
}

export const fitView = (img: Size, box: Size): View => clampView({ scale: fitScale(img, box), x: 0, y: 0 }, img, box);

/** Zoom by `factor` keeping the point under `at` (box coordinates) where it is: wheel, pinch. */
export function zoomAt(v: View, factor: number, at: { x: number; y: number }, img: Size, box: Size): View {
  const min = fitScale(img, box);
  const scale = Math.min(MAX_SCALE, Math.max(min, v.scale * factor));
  const k = scale / v.scale;
  return clampView({ scale, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k }, img, box);
}

/** Double-tap or double-click: fit to 100% at that point, anything else back to fit. */
export function toggleZoom(v: View, at: { x: number; y: number }, img: Size, box: Size): View {
  const fit = fitScale(img, box);
  if (Math.abs(v.scale - fit) > 0.01) return fitView(img, box);
  return zoomAt(v, (fit >= 1 ? 2 : 1) / v.scale, at, img, box);
}

/** A swipe down closes the viewer, only at fit (when zoomed in, a drag pans). */
export const swipeCloses = (dy: number, dx: number, atFit: boolean) => atFit && dy > 90 && Math.abs(dx) < dy * 0.6;

/* ---------- Report form ---------- */

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The anchored element's label: its text from the captured snippet, else the last part of its selector. */
export function elementLabel(e: Pick<ReporterEvidence, 'dom' | 'anchor'>): string {
  const snippet = e.dom?.snippet ? squash(e.dom.snippet.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ')) : '';
  if (snippet) return snippet.slice(0, 48);
  const sel = e.anchor.selector ?? '';
  const last = sel.split(/\s*>\s*|\s+/).filter(Boolean).at(-1) ?? '';
  return /^[a-z][a-z0-9-]*$/i.test(last) || /^#[\w-]+$/.test(last) ? last.replace(/^#/, '') : '';
}

/** The title suggestion: "<element> on <page title>", either alone when the other is missing; editable, never required to keep. */
export function suggestTitle(pageTitle: string, label: string): string {
  const page = squash(pageTitle).slice(0, 80);
  const el = squash(label).slice(0, 48);
  if (el && page) return `${el} on ${page}`.slice(0, 140);
  return el || page;
}

export interface SendButton {
  label: string;
  tone: 'primary' | 'urgent';
}

/** The primary button follows the destination switch: "File ticket" for the queue, "Send to <target>" (urgent accent) for a session. */
export function sendButton(target: ReporterReportTarget, targets: Pick<ReporterSessionTargetStatus, 'sessionId' | 'label'>[]): SendButton {
  if (target.kind === 'ticket') return { label: 'File ticket', tone: 'primary' };
  const t = targets.find((x) => x.sessionId === target.sessionId);
  return { label: `Send to ${t?.label || 'session'}`, tone: 'urgent' };
}

/** What stops a report from going: a title always; in Session mode the question too (the lead is asked something, not just shown). */
export function reportProblem(target: ReporterReportTarget, title: string, question: string): string | null {
  if (!title.trim()) return 'Write a title.';
  if (target.kind === 'session' && !question.trim()) return 'Write your question.';
  return null;
}

/** The destination the person chose last (per bucket): the form starts on it when that session is still offered. */
export const choiceKey = (bucket: string) => `pilot-reporter:destination:${bucket}`;
export function parseChoice(raw: string | null): ReporterReportTarget | null {
  try {
    const v = raw ? (JSON.parse(raw) as ReporterReportTarget) : null;
    if (v?.kind === 'ticket') return { kind: 'ticket' };
    if (v?.kind === 'session' && typeof v.sessionId === 'string' && v.sessionId.length <= 80) return { kind: 'session', sessionId: v.sessionId };
  } catch {
    // a broken value is no choice
  }
  return null;
}

/* ---------- Context view ---------- */

export interface CtxRow {
  label: string;
  value: string;
  /** Shown in full when copied (a whole commit), when the row shows less. */
  copy?: string;
  warn?: boolean;
}
export interface CtxGroup {
  title: string;
  rows: CtxRow[];
}

const UNKNOWN = 'unknown';
const or = (v: string | number | null | undefined, unit = '') => (v === null || v === undefined || v === '' ? UNKNOWN : `${v}${unit}`);

export interface ContextInput {
  status: ReporterStatus;
  page: ReporterPageInfo | { url: string; title: string } | null;
  device: ReporterDeviceInfo | null;
  build: ReporterBuildInfo | null;
  me: ReporterMe | null;
  actorLabel: string | null;
  sdkVersion: string;
  portalRelease: string | null;
}

const isFullPage = (p: ContextInput['page']): p is ReporterPageInfo => !!p && 'host' in p;

/** The Context view's groups: what the panel knows of this site, page, build, client, network and session; "unknown" when it does not. */
export function contextGroups(c: ContextInput): CtxGroup[] {
  const site = c.status.site;
  const b = c.build;
  const d = c.device;
  const p = c.page;
  const declared = b && site && ((b.repo && b.repo !== site.repo) || (b.environment && b.environment !== site.environment));
  let host: string | null = null;
  let path: string | null = null;
  try {
    if (p) {
      const u = new URL(p.url);
      host = u.host;
      path = `${u.pathname}${u.search}`;
    }
  } catch {
    // not a URL: unknown
  }
  const groups: CtxGroup[] = [
    {
      title: 'Site',
      rows: [
        { label: 'Domain', value: or(isFullPage(p) ? p.host : host) },
        { label: 'Origin', value: or(site?.origin) },
        { label: 'Environment', value: or(site?.environment) },
        { label: 'Repo', value: or(site?.repo) },
        { label: 'Branch', value: or(site?.branch) },
        ...(declared ? [{ label: 'Declared', value: `${b.repo ?? '-'} / ${b.environment ?? '-'} (the site record wins)`, warn: true }] : []),
      ],
    },
    {
      title: 'Page',
      rows: [
        { label: 'Title', value: or(p?.title) },
        { label: 'Path', value: or(isFullPage(p) ? `${p.path}${p.search}` : path) },
        ...(isFullPage(p) && p.route ? [{ label: 'Route', value: p.route }] : []),
        { label: 'Referrer', value: isFullPage(p) ? p.referrer || 'none' : UNKNOWN },
      ],
    },
    {
      title: 'Build',
      rows: [
        { label: 'Version', value: or(b?.version) },
        { label: 'Commit', value: b?.commit ? b.commit.slice(0, 7) : UNKNOWN, ...(b?.commit ? { copy: b.commit } : {}) },
        { label: 'Branch', value: or(b?.branch) },
        { label: 'Environment', value: or(b?.environment) },
        { label: 'Built', value: or(b?.builtAt) },
      ],
    },
    {
      title: 'Client',
      rows: d
        ? [
            { label: 'Browser', value: or([d.browser.name, d.browser.version].filter(Boolean).join(' ')) },
            { label: 'OS', value: or([d.os.name, d.os.version].filter(Boolean).join(' ')) },
            { label: 'Device', value: d.mobile === null ? UNKNOWN : d.mobile ? 'mobile' : 'desktop' },
            { label: 'Touch', value: d.touch ? 'yes' : 'no' },
            { label: 'Screen', value: `${Math.round(d.screen.w)}×${Math.round(d.screen.h)} @${d.screen.dpr}x` },
            { label: 'Viewport', value: `${Math.round(d.viewport.w)}×${Math.round(d.viewport.h)}` },
            { label: 'Orientation', value: or(d.screen.orientation) },
            { label: 'Locale', value: or(d.locale) },
            { label: 'Timezone', value: or(d.timezone) },
            {
              label: 'Connection',
              value: d.connection.effectiveType
                ? [d.connection.effectiveType, d.connection.downlinkMbps !== null ? `${d.connection.downlinkMbps} Mbps` : null, d.connection.rttMs !== null ? `${d.connection.rttMs} ms` : null].filter(Boolean).join(' · ')
                : UNKNOWN,
            },
            { label: 'CPU', value: or(d.hardwareConcurrency, ' cores') },
            { label: 'Memory', value: or(d.deviceMemoryGb, ' GB') },
          ]
        : [{ label: 'Client', value: 'unknown (this page’s SDK does not send it yet)' }],
    },
    {
      title: 'Network',
      rows: [
        { label: 'IP', value: or(c.me?.clientIp) },
        { label: 'Family', value: c.me?.clientIpFamily ? `IPv${c.me.clientIpFamily}` : UNKNOWN },
      ],
    },
    {
      title: 'Session',
      rows: [
        { label: 'Signed in', value: or(c.actorLabel) },
        { label: 'Token until', value: or(c.me?.expiresAt) },
        { label: 'SDK', value: `${c.sdkVersion || UNKNOWN} (served ${c.status.sdkVersion})` },
        { label: 'Portal', value: or(c.portalRelease) },
      ],
    },
  ];
  return groups;
}

/** Everything as plain text, for Copy all. */
export const contextText = (groups: CtxGroup[]) => groups.map((g) => [`${g.title}`, ...g.rows.map((r) => `  ${r.label}: ${r.copy ?? r.value}`)].join('\n')).join('\n');

/** What the next report carries beyond the context above: live counts while the SDK sends them, "unknown" before. */
export function carriesRows(counts: ReporterContextCounts | null): CtxRow[] {
  const n = (v: number | undefined) => (v === undefined ? UNKNOWN : String(v));
  return [
    { label: 'Console', value: counts ? `${n(counts.console)} entries · ${n(counts.consoleErrors)} errors` : UNKNOWN },
    { label: 'Network', value: counts ? `${n(counts.network)} requests · ${n(counts.networkFailed)} failed` : UNKNOWN },
    { label: 'Interactions', value: counts ? n(counts.interactions) : UNKNOWN },
    { label: 'UI checks', value: 'run at capture' },
    { label: 'Performance', value: 'vitals at capture (LCP, CLS, INP, FCP)' },
    { label: 'Screenshot', value: 'Screen, Whole page or Crop' },
  ];
}

/** The redaction rules, one line each (what the SDK and the server do before anything is stored). */
export const REDACTION_RULES = [
  'No request or response bodies, no headers.',
  'Query values in URLs are redacted.',
  'Typed input values are masked.',
  'Storage: key names only, never values.',
  'Credential-shaped text is masked.',
  'Your IP is added by the server, not the page.',
] as const;
