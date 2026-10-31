// UI reporter: the Markdown a reported ticket's description carries, written by the SERVER from what it stored (so it improves without an
// SDK release), and the repro steps and Playwright test built from a capture's interaction trail. An agent must be able to tell from the
// description alone which page, which build (commit, branch, environment), which repo and which device to look at.
//
// Everything quoted here came from a web page: it is untrusted, already redacted (validate.ts), and is fenced or escaped so it renders as
// text, never as a link or an instruction.

import { TICKET_LIMITS, type ReporterBuildInfo, type ReporterDeploymentState, type ReporterEvidence, type ReporterRepro, type ReporterTicketSite } from '@portal/contracts';

/** Every control character and line or paragraph separator (C0, DEL, C1, U+2028, U+2029): what could start a new line in a prompt. */
const BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** Untrusted text on one line: control characters and line breaks become one space, then capped. */
export const oneLine = (text: string | null | undefined, max = 200): string => (text ?? '').replace(BREAKS, ' ').slice(0, max);

/** One line of untrusted text inline: no Markdown, no HTML, no line breaks, no control characters. */
export function inline(text: string | null | undefined, max = 200): string {
  return oneLine(text, max).replace(/[\\`*_{}[\]()#+!|<>~]/g, (c) => `\\${c}`);
}

/** Untrusted text as a code span (backticks inside are dropped). */
const code = (text: string | null | undefined, max = 200) => `\`${oneLine(text, max).replace(/`/g, ' ')}\``;

/**
 * Untrusted Markdown kept as written (the reporter's words, a review comment), except an HTML comment opener: the footer marker the server
 * finds later (DEPLOY_FOOTER_START) can never come from the page, so a rewrite never cuts what follows it.
 */
const untrustedMarkdown = (text: string) => text.replace(/<!--/g, '<\\!--');

export interface DescribedCapture {
  captureId: string;
  index: number;
  pageUrl: string;
  path: string;
  note: string | null;
  /** The review comment, when the capture came from a review. */
  body?: string | null;
  evidence: ReporterEvidence | null;
  screenshotAttachmentId: number | null;
  evidenceAttachmentId: number | null;
}

export interface DescribeInput {
  /** The reporter's own words (the quick path's description, or the review's overall comment). Untrusted Markdown, kept as written. */
  text: string;
  site: ReporterTicketSite;
  build: ReporterBuildInfo;
  sdkVersion: string;
  target: { kind: 'ticket' } | { kind: 'session'; label: string };
  captures: DescribedCapture[];
  ticketId: string;
  deployments: ReporterDeploymentState[];
  fixCommits: string[];
  /** The reporter's address as the portal saw it (added by the server, never sent by the page); null or absent: unknown. */
  reporterIp?: string | null;
}

const deviceLine = (e: ReporterEvidence) => {
  const d = e.device;
  const browser = [d.browser.name, d.browser.version].filter(Boolean).join(' ') || 'unknown browser';
  const os = [d.os.name, d.os.version].filter(Boolean).join(' ') || 'unknown OS';
  return `${inline(browser, 60)} on ${inline(os, 60)}, ${d.mobile ? 'mobile' : 'desktop'}${d.touch ? ', touch' : ''}, viewport ${d.viewport.w}x${d.viewport.h} @${d.screen.dpr}x`;
};

const buildLine = (b: ReporterBuildInfo) =>
  b.commit || b.version || b.branch
    ? `${b.version ? `version ${code(b.version, 40)}, ` : ''}commit ${b.commit ? code(b.commit, 40) : 'unknown'}, branch ${b.branch ? code(b.branch, 80) : 'unknown'}`
    : 'unknown (the page declared no build)';

/** The deployment strip as text: "stg deployed (abc1234) · prod not deployed · uat unknown (no build seen)". */
export function deploymentLine(states: ReporterDeploymentState[]): string {
  if (!states.length) return 'no environments known';
  const reason = { 'no-fix-commit': 'no fix commit yet', 'no-build-seen': 'no build seen', 'ancestry-unchecked': 'not checked' } as const;
  return states
    .map((s) =>
      s.status === 'deployed'
        ? `${s.environment} deployed${s.fixCommit ? ` (${s.fixCommit.slice(0, 7)})` : ''}${s.confidence === 'observed' ? ' (observed by the widget, no pipeline yet)' : ''}`
        : s.status === 'not-deployed'
          ? `${s.environment} not deployed${s.currentCommit ? ` (live ${s.currentCommit.slice(0, 7)})` : ''}`
          : `${s.environment} unknown${s.reason ? ` (${reason[s.reason]})` : ''}`,
    )
    .join(' · ');
}

export const DEPLOY_FOOTER_START = '<!-- reporter:deployments -->';

/** The footer, replaced whenever the deployment state changes (the only part of the description the server rewrites later). */
export function deploymentFooter(states: ReporterDeploymentState[], fixCommits: string[]): string {
  return `${DEPLOY_FOOTER_START}\n### Deployment\n\n- Fix commits: ${fixCommits.length ? fixCommits.map((c) => code(c, 40)).join(', ') : 'none known yet'}\n- ${deploymentLine(states)}\n`;
}

function captureSection(c: DescribedCapture, total: number, ticketId: string): string {
  const lines: string[] = [];
  lines.push(`### ${total > 1 ? `Capture ${c.index} of ${total}: ` : 'Page: '}${code(c.path, 300)}`);
  lines.push('');
  if (c.body) lines.push(untrustedMarkdown(c.body.trim()), '');
  else if (c.note) lines.push(`> ${inline(c.note, 1000)}`, '');
  lines.push(`- URL: ${code(c.pageUrl, 400)}`);
  const e = c.evidence;
  if (e) {
    if (e.page.route) lines.push(`- Route: ${code(e.page.route, 200)}`);
    lines.push(`- Device: ${deviceLine(e)}`);
    if (e.captureGaps?.length) lines.push(`- Not captured: ${e.captureGaps.map((g) => inline(g, 200)).join('; ')}`);
    lines.push(`- Area: ${areaWord(e.anchor.mode)} at x ${Math.round(e.anchor.rect.x)}, y ${Math.round(e.anchor.rect.y)}, ${Math.round(e.anchor.rect.w)}x${Math.round(e.anchor.rect.h)}${e.anchor.selector ? `, element ${code(e.anchor.selector, 200)}` : ''}`);
    const errors = e.console.filter((x) => x.level === 'error');
    const failed = e.network.filter((n) => n.error !== undefined || (n.status !== null && n.status >= 400));
    lines.push(`- Console errors: ${errors.length}; failed requests: ${failed.length}; LCP: ${e.performance.vitals.lcpMs === null ? 'unknown' : `${Math.round(e.performance.vitals.lcpMs)} ms`}`);
    for (const x of errors.slice(0, 5)) lines.push(`  - error: ${code(x.text, 300)}`);
    for (const n of failed.slice(0, 5)) lines.push(`  - ${code(`${n.method} ${n.url}`, 300)} -> ${n.status ?? inline(n.error ?? 'failed', 80)}`);
    if (!e.checks.ran) lines.push(`- UI checks: did not run (${inline(e.checks.error ?? 'unknown', 200)})`);
    else if (e.checks.findings.length) {
      lines.push(`- UI checks: ${e.checks.findings.length} findings`);
      for (const f of e.checks.findings.slice(0, 8)) lines.push(`  - ${f.severity} ${code(f.rule, 60)}: ${inline(f.message, 200)}${f.selector ? ` at ${code(f.selector, 120)}` : ''}`);
    } else lines.push('- UI checks: no findings');
  } else lines.push('- Evidence: not uploaded yet');
  const files = [
    c.screenshotAttachmentId !== null ? `screenshot (attachment ${c.screenshotAttachmentId})` : null,
    c.evidenceAttachmentId !== null ? `evidence JSON (attachment ${c.evidenceAttachmentId})` : null,
  ].filter(Boolean);
  if (files.length) lines.push(`- Files: ${files.join(', ')}; read them with ticket_attachment_get ${ticketId} or reporter_evidence ${ticketId}`);
  return lines.join('\n');
}

/** The whole description: the reporter's text on top, the context, a section per capture, the repro steps, the deployment footer. */
export function describeTicket(d: DescribeInput): string {
  const first = d.captures.find((c) => c.evidence)?.evidence ?? null;
  const out: string[] = [];
  if (d.text.trim()) out.push(untrustedMarkdown(d.text.trim()), '');
  out.push('---', '', '### Where', '');
  out.push(`- Site: ${code(d.site.origin, 200)} (environment ${code(d.site.environment, 20)}), repo ${code(d.site.repo, 200)}`);
  if (d.site.declaredMismatch)
    out.push(`- Warning: the page declared repo ${code(d.site.declaredMismatch.repo ?? 'none', 200)} and environment ${code(d.site.declaredMismatch.environment ?? 'none', 20)}, which differ from the site record; the site record wins.`);
  if (first) out.push(`- Domain: ${code(first.page.host, 200)}, path ${code(first.page.path, 300)}${first.page.route ? `, route ${code(first.page.route, 200)}` : ''}`);
  out.push(`- Build: ${buildLine(d.build)}${d.build.environment ? `, declared environment ${code(d.build.environment, 20)}` : ''}`);
  if (first) out.push(`- Device: ${deviceLine(first)}`);
  out.push(`- Reporter IP: ${d.reporterIp ? code(d.reporterIp, 64) : 'unknown'} (as the portal saw it)`);
  out.push(`- Reported with the UI reporter (SDK ${code(d.sdkVersion || 'unknown', 40)})${d.target.kind === 'session' ? `, sent straight to the session ${inline(d.target.label, 60)} (urgent)` : ''}.`);
  out.push('');
  for (const c of d.captures) out.push(captureSection(c, d.captures.length, d.ticketId), '');
  const repro = first ? buildRepro(first, d.site.origin) : null;
  if (repro?.steps.length) {
    out.push('### Steps to reproduce', '');
    repro.steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
    out.push('', 'A Playwright test of these steps is attached as `repro.spec.ts`.', '');
  }
  out.push(deploymentFooter(d.deployments, d.fixCommits));
  let text = out.join('\n');
  if (text.length > TICKET_LIMITS.description) {
    const footer = deploymentFooter(d.deployments, d.fixCommits);
    text = `${text.slice(0, TICKET_LIMITS.description - footer.length - 40)}\n\n(cut: see the evidence)\n${footer}`;
  }
  return text;
}

/** Replaces the deployment footer of a description (or appends one). The LAST marker: the footer is always the end of the description. */
export function withFooter(description: string, footer: string): string {
  const at = description.lastIndexOf(DEPLOY_FOOTER_START);
  const head = at >= 0 ? description.slice(0, at) : `${description.trimEnd()}\n\n`;
  const next = `${head}${footer}`;
  return next.length > TICKET_LIMITS.description ? description : next;
}

/* ---------- Repro ---------- */

const quoteJs = (s: string) => JSON.stringify(s);

/** A path that, joined to the origin, stays on it; anything else is "/". */
function onOrigin(origin: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return '/';
  try {
    return new URL(`${origin}${path}`).origin === origin ? path : '/';
  } catch {
    return '/';
  }
}

function who(i: { label: string | null; selector: string | null }): string {
  if (i.label) return `"${inline(i.label, 80)}"`;
  if (i.selector) return code(i.selector, 120);
  return 'the page';
}

/**
 * Numbered human steps and a Playwright test from the trail: it opens the first page the trail saw (else the captured page) at the capture's
 * viewport and user agent, replays clicks, changes (masked values become a placeholder fill), submits, keys and navigations, and ends with an
 * expect on the anchored element. Never a typed value: the trail never had one.
 */
export function buildRepro(e: ReporterEvidence, siteOrigin?: string): ReporterRepro {
  // The SITE's origin (the token's), never the page's claim; a start path that would leave it (`@host`, `//host`) falls back to "/".
  const origin = siteOrigin ?? e.page.origin;
  const firstNav = e.interactions.find((i) => i.kind === 'navigate' && i.detail);
  const start = onOrigin(origin, firstNav?.detail || e.page.path || '/');
  const steps: string[] = [`Open ${code(`${origin}${start}`, 300)} at ${e.device.viewport.w}x${e.device.viewport.h}${e.device.mobile ? ' (mobile)' : ''}.`];
  const body: string[] = [];
  for (const i of e.interactions) {
    const sel = i.selector ? quoteJs(i.selector) : null;
    switch (i.kind) {
      case 'click':
        steps.push(`Click ${who(i)}.`);
        if (sel) body.push(`  await page.locator(${sel}).first().click();`);
        break;
      case 'input':
        steps.push(`Type into ${who(i)} (value not recorded).`);
        if (sel) body.push(`  await page.locator(${sel}).first().fill('example'); // the real value was never recorded`);
        break;
      case 'change':
        steps.push(`Change ${who(i)}${i.value && i.value !== '[masked]' ? ` to "${inline(i.value, 60)}"` : ''}.`);
        if (sel && (i.value === 'checked' || i.value === 'unchecked')) body.push(`  await page.locator(${sel}).first().setChecked(${i.value === 'checked'});`);
        else if (sel && i.value && i.value !== '[masked]') body.push(`  await page.locator(${sel}).first().selectOption({ label: ${quoteJs(i.value)} });`);
        break;
      case 'submit':
        steps.push(`Submit ${who(i)}.`);
        if (sel) body.push(`  await page.locator(${sel}).first().evaluate((f) => (f as HTMLFormElement).requestSubmit?.());`);
        break;
      case 'key':
        if (i.detail) {
          steps.push(`Press ${i.detail}.`);
          body.push(`  await page.keyboard.press(${quoteJs(i.detail)});`);
        }
        break;
      case 'navigate':
        if (i !== firstNav && i.detail) {
          steps.push(`Go to ${code(i.detail, 300)}.`);
          body.push(`  await page.waitForURL((u) => u.pathname + u.search === ${quoteJs(i.detail)}).catch(() => page.goto(${quoteJs(i.detail)}));`);
        }
        break;
      case 'scroll':
        break;
    }
  }
  const target = e.anchor.selector;
  steps.push(target ? `Look at ${code(target, 200)}: this is where the issue is.` : 'Look at the area in the screenshot: this is where the issue is.');
  const playwright = [
    "import { test, expect } from '@playwright/test';",
    '',
    `test.use({ viewport: { width: ${Math.round(e.device.viewport.w) || 390}, height: ${Math.round(e.device.viewport.h) || 844} }, deviceScaleFactor: ${e.device.screen.dpr || 1}, isMobile: ${e.device.mobile === true}, hasTouch: ${e.device.touch}, userAgent: ${quoteJs(e.device.userAgent)} });`,
    '',
    `test(${quoteJs(`repro: ${e.page.path}`)}, async ({ page }) => {`,
    `  await page.goto(${quoteJs(`${origin}${start}`)});`,
    ...body,
    target ? `  await expect(page.locator(${quoteJs(target)}).first()).toBeVisible();` : `  await expect(page).toHaveURL(new RegExp(${quoteJs(e.page.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}));`,
    '});',
    '',
  ].join('\n');
  return { steps, playwright };
}

/** How a capture's area reads in the ticket: a crop, what was on screen, or the whole page (an unknown mode reads as the whole page). */
export function areaWord(mode: string): string {
  return mode === 'crop' ? 'crop' : mode === 'viewport' ? 'screen (what was visible)' : 'full page';
}
