import { Badge, chipClass } from '@isnanme/ui';
import { TICKET_API, reporterIpText, type ReporterEvidence, type TicketReporterEvidence } from '@portal/contracts';
import { AlertTriangle } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Card } from '@/components/Card';
import { InfoTip } from '@/components/InfoTip';
import { reporterApi } from './api';
import { DEPLOY_REASON, OBSERVED_NOTE, cropBox, deployMark, deploymentText, gapsLine, isObserved, shortCommit } from './shared';

/** The ticket's reporter evidence (null when the ticket did not come from the widget, undefined while loading). */
export function useReporterEvidence(ticketId: string, reloadKey: unknown) {
  const [evidence, setEvidence] = useState<TicketReporterEvidence | null | undefined>(undefined);
  const load = useCallback(() => {
    reporterApi.evidence(ticketId).then(setEvidence, () => setEvidence(null));
  }, [ticketId]);
  useEffect(() => load(), [load, reloadKey]);
  return evidence;
}

export const failedRequests = (e: ReporterEvidence) => e.network.filter((n) => !!n.error || (n.status !== null && n.status >= 400));
export const consoleErrors = (e: ReporterEvidence) => e.console.filter((c) => c.level === 'error');

/** Where the fix stands per environment, for the ticket header: "stg ✓ · uat – · prod ?", each with its reason. */
export function DeploymentChips({ evidence }: { evidence: TicketReporterEvidence }) {
  if (!evidence.deployments.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {evidence.deployments.map((d) => (
        <Badge key={d.environment} tone={d.status === 'deployed' ? 'success' : d.status === 'not-deployed' ? 'warning' : 'neutral'}>
          <span title={deploymentText(d)}>
            {d.environment} {deployMark(d)}
          </span>
          <span className="sr-only">{deploymentText(d)}</span>
        </Badge>
      ))}
    </span>
  );
}

type TabId = 'console' | 'network' | 'components' | 'performance' | 'page' | 'device' | 'state' | 'checks' | 'steps';
const TABS: { value: TabId; label: string }[] = [
  { value: 'console', label: 'Console' },
  { value: 'network', label: 'Network' },
  { value: 'checks', label: 'Checks' },
  { value: 'steps', label: 'Steps' },
  { value: 'components', label: 'Components' },
  { value: 'performance', label: 'Performance' },
  { value: 'page', label: 'Page' },
  { value: 'device', label: 'Device' },
  { value: 'state', label: 'State' },
];

/**
 * The ticket page's Evidence card (next to Attachments): where it was reported (domain, path, build commit, branch, environment,
 * repo), whether the fix is live per environment, and a strip of the captures (swipe on a phone), each with its screenshot and crop,
 * its comment and the evidence tabs.
 */
export function EvidenceCard({ ticketId, evidence }: { ticketId: string; evidence: TicketReporterEvidence }) {
  const [at, setAt] = useState(0);
  const capture = evidence.captures[at] ?? evidence.captures[0];
  const [bundle, setBundle] = useState<ReporterEvidence | null | 'failed'>(null);
  const [tab, setTab] = useState<TabId>('console');
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    setBundle(null);
    setSize(null);
    if (!capture?.evidenceAttachmentId) return;
    let live = true;
    reporterApi.bundle(ticketId, Number(capture.evidenceAttachmentId)).then(
      (b) => live && setBundle(b),
      () => live && setBundle('failed'),
    );
    return () => {
      live = false;
    };
  }, [ticketId, capture?.evidenceAttachmentId]);

  const b = bundle && bundle !== 'failed' ? bundle : null;
  const host = (() => {
    try {
      return new URL(evidence.origin).host;
    } catch {
      return evidence.origin;
    }
  })();
  const box = capture && size ? cropBox(size, capture.anchor, b?.state.scroll ?? null) : null;
  const { site, build } = evidence;

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-muted">
        Evidence
        <InfoTip label="About evidence">Captured by the UI reporter on the page: what the person saw, and the page’s console, network, device and build at that moment. The repo and environment come from the site record, not from the page.</InfoTip>
      </h2>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13.5px]">
        <Row label="Page">
          <span className="break-all">
            {host}
            {capture ? capture.anchor.path : ''}
          </span>
        </Row>
        <Row label="Repo">
          <span className="break-all">
            {site.repo} · {site.environment}
          </span>
        </Row>
        <Row label="Build">
          {build.commit ? (
            <span className="break-all tabular-nums">
              {shortCommit(build.commit)}
              {build.branch ? ` · ${build.branch}` : ''}
              {build.environment ? ` · ${build.environment}` : ''}
              {build.version ? ` · v${build.version}` : ''}
            </span>
          ) : (
            <span className="text-muted">Unknown (the page did not say)</span>
          )}
        </Row>
        {evidence.target.kind === 'session' && (
          <Row label="Sent to">
            <span className="break-all">Session {evidence.target.sessionId.slice(0, 8)} (urgent)</span>
          </Row>
        )}
        <Row label="IP">
          {evidence.reporterIp ? <span className="break-all tabular-nums">{reporterIpText(evidence.reporterIp)}</span> : <span className="text-muted">Unknown</span>}
        </Row>
        <Row label="Fix">
          {evidence.fixCommits.length ? <span className="break-all tabular-nums">{evidence.fixCommits.map((c) => shortCommit(c)).join(', ')}</span> : <span className="text-muted">No fix commit yet</span>}
        </Row>
        <Row label="Deployed">
          {evidence.deployments.length ? (
            <ul className="flex flex-col gap-0.5">
              {evidence.deployments.map((d) => (
                <li key={d.environment} className="break-words">
                  <span className="font-semibold">{d.environment}</span>{' '}
                  <span className={d.status === 'deployed' ? 'text-accent' : d.status === 'not-deployed' ? 'text-danger' : 'text-muted'}>
                    {d.status === 'deployed' ? (isObserved(d) ? 'deployed*' : 'deployed') : d.status === 'not-deployed' ? 'not yet' : 'unknown'}
                  </span>
                  <span className="text-[12.5px] text-muted">
                    {d.status === 'unknown' && d.reason ? ` · ${DEPLOY_REASON[d.reason]}` : d.currentCommit ? ` · live ${shortCommit(d.currentCommit)}${isObserved(d) ? ` · ${OBSERVED_NOTE}` : ''}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted">Unknown: no environment known for this repo</span>
          )}
        </Row>
      </dl>
      {site.declaredMismatch && (
        <p role="status" className="mt-3 flex items-start gap-2 rounded-2xl bg-danger-soft px-3 py-2 text-[13.5px]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
          <span className="break-words">
            The page declared {site.declaredMismatch.repo ?? site.repo} / {site.declaredMismatch.environment ?? site.environment}, but {evidence.origin} is a site of {site.repo} / {site.environment}.
          </span>
        </p>
      )}

      {evidence.captures.length > 1 && (
        <ol className="mt-4 flex snap-x gap-2 overflow-x-auto pb-1" aria-label="Captures">
          {evidence.captures.map((c, i) => (
            <li key={c.captureId} className="shrink-0 snap-start">
              <button
                type="button"
                onClick={() => setAt(i)}
                aria-current={i === at}
                className={`flex min-h-11 w-24 flex-col gap-1 rounded-xl border p-1 text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden ${i === at ? 'border-accent' : 'border-line'}`}
              >
                {c.screenshotAttachmentId ? <img src={TICKET_API.attachment(ticketId, Number(c.screenshotAttachmentId))} alt="" loading="lazy" className="h-14 w-full rounded-lg object-cover" /> : <span className="h-14 w-full rounded-lg bg-surface-2" />}
                <span className="truncate text-[11.5px] text-muted">
                  {c.index} · {c.anchor.path}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {capture && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-[12.5px] text-muted tabular-nums">
            {capture.index} of {evidence.captures.length} · {capture.anchor.mode === 'crop' ? 'crop' : capture.anchor.mode === 'viewport' ? 'screen' : 'full'} · {capture.anchor.viewport.w}×{capture.anchor.viewport.h}
          </p>
          {capture.screenshotAttachmentId ? (
            <a href={TICKET_API.attachment(ticketId, Number(capture.screenshotAttachmentId))} target="_blank" rel="noopener noreferrer" className="relative block overflow-hidden rounded-xl border border-line bg-surface-2">
              <img
                src={TICKET_API.attachment(ticketId, Number(capture.screenshotAttachmentId))}
                alt={`Screenshot ${capture.index}`}
                onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                className="max-h-[28rem] w-full object-contain object-top"
              />
              {box && <span aria-hidden="true" className="absolute rounded-sm border-2 border-danger" style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` }} />}
            </a>
          ) : (
            <p className="text-[13px] text-muted">No screenshot.</p>
          )}
          {capture.note && <p className="text-[14px] break-words whitespace-pre-line">{capture.note}</p>}

          {bundle === 'failed' && <p className="text-[13px] text-muted">The evidence file could not be read.</p>}
          {!capture.evidenceAttachmentId && <p className="text-[13px] text-muted">No evidence file.</p>}
          {capture.evidenceAttachmentId && bundle === null && <div className="skeleton h-24 rounded-xl" aria-busy="true" />}
          {b && (
            <>
              {gapsLine(b) && <p className="text-[13px] break-words text-muted">{gapsLine(b)}</p>}
              <div role="tablist" aria-label="Evidence" className="flex flex-wrap gap-1.5">
                {TABS.map((t) => (
                  <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)} className={`${chipClass(tab === t.value)} min-h-11`}>
                    {tabLabel(t, b)}
                  </button>
                ))}
              </div>
              <EvidenceTab tab={tab} e={b} />
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function tabLabel(t: { value: TabId; label: string }, e: ReporterEvidence): string {
  if (t.value === 'console') {
    const n = consoleErrors(e).length;
    return n ? `${t.label} ${n}` : t.label;
  }
  if (t.value === 'network') {
    const n = failedRequests(e).length;
    return n ? `${t.label} ${n}` : t.label;
  }
  if (t.value === 'checks') return e.checks.ran ? (e.checks.findings.length ? `${t.label} ${e.checks.findings.length}` : t.label) : `${t.label} –`;
  return t.label;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

const ms = (v: number | null) => (v === null ? 'unavailable' : `${Math.round(v)} ms`);
const mb = (v: number | null) => (v === null ? 'unavailable' : `${(v / 1024 / 1024).toFixed(1)} MB`);

function Pairs({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
      {rows.map(([k, v]) => (
        <Row key={k} label={k}>
          <span className="break-all">{v === null || v === undefined || v === '' ? <span className="text-muted">unavailable</span> : v}</span>
        </Row>
      ))}
    </dl>
  );
}

function EvidenceTab({ tab, e }: { tab: TabId; e: ReporterEvidence }) {
  const mono = 'font-mono text-[12px] break-all';
  switch (tab) {
    case 'console':
      return e.console.length ? (
        <ul className="flex max-h-80 flex-col divide-y divide-line overflow-y-auto">
          {e.console.map((c, i) => (
            <li key={i} className={`py-1.5 ${mono} ${c.level === 'error' ? 'text-danger' : c.level === 'warn' ? 'text-flame' : ''}`}>
              <span className="mr-1 font-semibold uppercase">{c.level}</span>
              {c.text}
              {c.stack && <pre className="mt-1 whitespace-pre-wrap text-muted">{c.stack}</pre>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No console output.</p>
      );
    case 'network':
      return e.network.length ? (
        <ul className="flex max-h-80 flex-col divide-y divide-line overflow-y-auto">
          {e.network.map((n, i) => {
            const bad = !!n.error || (n.status !== null && n.status >= 400);
            return (
              <li key={i} className={`py-1.5 ${mono} ${bad ? 'text-danger' : ''}`}>
                <span className="font-semibold">{n.method}</span> {n.status ?? n.error ?? '–'} · {n.durationMs === null ? '' : `${Math.round(n.durationMs)} ms · `}
                {n.url}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No requests recorded.</p>
      );
    case 'checks':
      if (!e.checks.ran) return <p className="text-[13px] text-muted">The checks did not run{e.checks.error ? `: ${e.checks.error}` : ''}.</p>;
      return e.checks.findings.length ? (
        <ul className="flex flex-col gap-1.5 text-[13px]">
          {e.checks.findings.map((f, i) => (
            <li key={i} className="break-words">
              <Badge tone={f.severity === 'critical' || f.severity === 'serious' ? 'danger' : 'neutral'}>{f.severity}</Badge> <span className="font-semibold">{f.rule}</span> {f.message}
              {f.selector && <span className={`block text-muted ${mono}`}>{f.selector}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">Nothing found.</p>
      );
    case 'steps':
      return e.interactions.length ? (
        <ol className="list-decimal pl-5 text-[13px]">
          {e.interactions.map((s, i) => (
            <li key={i} className="break-words">
              {s.kind} {s.label ? `“${s.label}”` : (s.selector ?? '')} {s.value ? `(${s.value})` : ''} {s.detail ?? ''}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[13px] text-muted">No interactions recorded.</p>
      );
    case 'components':
      return e.components.length ? (
        <ul className={`max-h-80 overflow-y-auto ${mono}`}>
          {e.components.map((c, i) => (
            <li key={i} style={{ paddingLeft: `${Math.min(c.depth, 20) * 0.75}rem` }}>
              {c.name}
              {c.source && <span className="text-muted"> {c.source}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">{e.framework ? 'No components read.' : 'No React tree found on the page.'}</p>
      );
    case 'performance':
      return (
        <Pairs
          rows={[
            ['TTFB', ms(e.performance.navigation.ttfbMs)],
            ['DOM ready', ms(e.performance.navigation.domContentLoadedMs)],
            ['Load', ms(e.performance.navigation.loadMs)],
            ['LCP', ms(e.performance.vitals.lcpMs)],
            ['FCP', ms(e.performance.vitals.fcpMs)],
            ['INP', ms(e.performance.vitals.inpMs)],
            ['CLS', e.performance.vitals.cls === null ? 'unavailable' : e.performance.vitals.cls.toFixed(3)],
            ['Long tasks', `${e.performance.longTasks.count} · ${Math.round(e.performance.longTasks.totalMs)} ms`],
            ['JS heap', mb(e.performance.memory.usedJsHeapBytes)],
          ]}
        />
      );
    case 'page':
      return (
        <Pairs
          rows={[
            ['URL', e.page.url],
            ['Title', e.page.title],
            ['Route', e.page.route],
            ['Referrer', e.page.referrer],
            ['Language', e.page.lang],
            ['Selector', e.dom?.selector ?? e.anchor.selector],
            ['Element', e.dom?.snippet ? <code className={mono}>{e.dom.snippet}</code> : null],
            ['SDK', e.sdkVersion],
            ['Captured', e.capturedAt],
          ]}
        />
      );
    case 'device':
      return (
        <Pairs
          rows={[
            ['Browser', [e.device.browser.name, e.device.browser.version].filter(Boolean).join(' ')],
            ['OS', [e.device.os.name, e.device.os.version].filter(Boolean).join(' ')],
            ['Mobile', e.device.mobile === null ? null : e.device.mobile ? 'yes' : 'no'],
            ['Touch', e.device.touch ? 'yes' : 'no'],
            ['Screen', `${e.device.screen.w}×${e.device.screen.h} @${e.device.screen.dpr}x`],
            ['Viewport', `${e.device.viewport.w}×${e.device.viewport.h}`],
            ['Network', e.device.connection.effectiveType],
            ['Cores', e.device.hardwareConcurrency],
            ['Memory', e.device.deviceMemoryGb === null ? null : `${e.device.deviceMemoryGb} GB`],
            ['Time zone', e.device.timezone],
            ['Locale', e.device.locale],
            ['User agent', e.device.userAgent],
          ]}
        />
      );
    case 'state':
      return (
        <div className="flex flex-col gap-3">
          <Pairs
            rows={[
              ['Scroll', `${Math.round(e.state.scroll.x)}, ${Math.round(e.state.scroll.y)} of ${Math.round(e.state.scroll.maxY)}`],
              ['Visibility', e.state.visibility],
              ['Online', e.state.online ? 'yes' : 'no'],
              ['Theme', e.state.colorScheme],
              ['Reduced motion', e.state.reducedMotion ? 'yes' : 'no'],
              ['Focused', e.state.focused],
              ['localStorage', e.state.storageKeys.local.join(', ')],
              ['sessionStorage', e.state.storageKeys.session.join(', ')],
              ['Cookies', e.state.storageKeys.cookies.join(', ')],
            ]}
          />
          {e.state.app !== null && e.state.app !== undefined && <pre className="max-h-64 overflow-auto rounded-xl bg-surface-2 p-2 text-[12px]">{JSON.stringify(e.state.app, null, 2)}</pre>}
        </div>
      );
  }
}
