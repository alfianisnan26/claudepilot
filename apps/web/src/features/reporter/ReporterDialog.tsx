import { Button, CopyButton, FormDialog, Select, SwitchRow, TextField } from '@isnanme/ui';
import { REPORTER_LIMITS, type ReporterSessionTarget } from '@portal/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { chatApi } from '@/features/chat/api';
import { errorText } from '@/lib/api';
import { reporterApi } from './api';
import { deployCurl, emptyRow, rowOf, siteErrors, siteOf, sitesValid, snippet, targetsValid, type SiteRow } from './sites';

/**
 * A bucket's Reporter settings (docs/prd/ui-reporter.md): the switch, the sites (an origin, which environment of which repo it serves;
 * an origin belongs to one bucket only), the sessions a reporter may send straight to, whether callouts show by default, and the
 * script tag to paste (or inject at the edge) per site.
 */
export function ReporterDialog({ bucket, onClose }: { bucket: string | null; onClose: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [rows, setRows] = useState<SiteRow[]>([]);
  const [targets, setTargets] = useState<ReporterSessionTarget[]>([]);
  const [calloutsDefault, setCalloutsDefault] = useState(true);
  const [sessions, setSessions] = useState<{ id: string; title: string; workspaceId: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!bucket) return;
    let live = true;
    setLoaded(false);
    setError(null);
    setTouched(false);
    reporterApi.config(bucket).then(
      (c) => {
        if (!live) return;
        setEnabled(c.enabled);
        setRows(c.sites.map(rowOf));
        setTargets(c.sessionTargets);
        setCalloutsDefault(c.calloutsDefault);
        setLoaded(true);
      },
      (e) => live && (setError(errorText(e, 'Couldn’t load the reporter settings.')), setLoaded(true)),
    );
    chatApi.listAll().then(
      (list) => live && setSessions(list.filter((s) => s.state !== 'ended' && !s.archivedAt).map((s) => ({ id: s.id, title: s.title, workspaceId: s.workspaceId }))),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bucket]);

  const errors = touched ? siteErrors(rows) : {};
  const portal = typeof window === 'undefined' ? '' : window.location.origin;
  const setRow = (i: number, patch: Partial<SiteRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async () => {
    if (!bucket) return;
    setTouched(true);
    if (!sitesValid(rows)) return setError('Fix the marked sites first.');
    if (!targetsValid(targets)) return setError('Each direct-report session needs a name, once.');
    setSaving(true);
    setError(null);
    try {
      await reporterApi.saveConfig(bucket, { enabled, sites: rows.map(siteOf), sessionTargets: targets.map((t) => ({ ...t, label: t.label.trim() })), calloutsDefault });
      onClose();
    } catch (e) {
      // 409: an origin is already a site of another bucket.
      setError(errorText(e, 'Couldn’t save.'));
    } finally {
      setSaving(false);
    }
  };

  const unused = sessions.filter((s) => !targets.some((t) => t.sessionId === s.id));
  const sessionName = (id: string) => sessions.find((s) => s.id === id)?.title ?? `${id.slice(0, 8)} (not live)`;

  return (
    <FormDialog open={!!bucket} onClose={onClose} title={`Reporter · ${bucket ?? ''}`} onSubmit={submit} submitLabel="Save" saving={saving} error={error} dirty={loaded}>
      {!loaded ? (
        <div className="skeleton h-40 rounded-2xl" aria-busy="true" />
      ) : (
        <div className="flex flex-col gap-5">
          <SwitchRow label="On" description="The widget works on this bucket’s sites." checked={enabled} onChange={setEnabled} />
          <SwitchRow label="Callouts" description="Open tickets show on the page by default." checked={calloutsDefault} onChange={setCalloutsDefault} />

          <section className="flex flex-col gap-3">
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-muted">
              Sites
              <InfoTip label="About sites">
                One row per origin: which environment of which repo it serves. Tickets take their repo and environment from here (what the page says is only compared), and an origin can belong to one bucket only.
              </InfoTip>
            </h3>
            {rows.map((r, i) => (
              <fieldset key={i} className="flex flex-col gap-2 rounded-2xl border border-line p-3">
                <legend className="sr-only">Site {i + 1}</legend>
                <TextField label="Origin" placeholder="https://stg.konfersi.com" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={r.origin} onChange={(e) => setRow(i, { origin: e.target.value })} error={errors[i]?.origin} />
                <div className="grid grid-cols-2 gap-2">
                  <TextField label="Environment" placeholder="stg" autoCapitalize="none" value={r.environment} onChange={(e) => setRow(i, { environment: e.target.value })} error={errors[i]?.environment} />
                  <TextField label="Branch" optional placeholder="stg" autoCapitalize="none" spellCheck={false} value={r.branch} onChange={(e) => setRow(i, { branch: e.target.value })} error={errors[i]?.branch} />
                </div>
                <TextField label="Repo" placeholder="platform/konfersi-landing-page" autoCapitalize="none" spellCheck={false} value={r.repo} onChange={(e) => setRow(i, { repo: e.target.value })} error={errors[i]?.repo} />
                <TextField label="Label" optional placeholder="Landing stg" value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} error={errors[i]?.label} />
                {!errors[i] && r.origin && r.repo && r.environment && (
                  <div className="flex flex-wrap items-center gap-2">
                    <CopyButton value={snippet(portal, bucket ?? '', siteOf(r))} label="Copy script tag" showLabel toastMessage="Script tag copied" />
                    <CopyButton value={deployCurl(portal, siteOf(r))} label="Copy deploy hook" showLabel toastMessage="Deploy hook copied" />
                  </div>
                )}
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </div>
              </fieldset>
            ))}
            {rows.length < REPORTER_LIMITS.sites && (
              <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setRows((rs) => [...rs, emptyRow()])}>
                Add site
              </Button>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-muted">
              Direct report
              <InfoTip label="About direct report">
                Sessions a reporter can send an urgent report to (the lead). The report still becomes a ticket, so it is traced and its deployment tracked. The first is the default.
              </InfoTip>
            </h3>
            {targets.map((t, i) => (
              <div key={t.sessionId} className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <TextField label={sessionName(t.sessionId)} value={t.label} maxLength={60} onChange={(e) => setTargets((ts) => ts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                </div>
                <Button variant="ghost" aria-label="Remove" icon={<Trash2 className="size-4" />} onClick={() => setTargets((ts) => ts.filter((_, j) => j !== i))} />
              </div>
            ))}
            {unused.length > 0 && targets.length < REPORTER_LIMITS.sessionTargets && (
              <Select
                label="Add session"
                value=""
                onChange={(id) => {
                  const s = sessions.find((x) => x.id === id);
                  if (s) setTargets((ts) => [...ts, { sessionId: s.id, label: s.title.slice(0, 60) }]);
                }}
                options={[{ value: '', label: 'Pick a live session' }, ...unused.map((s) => ({ value: s.id, label: `${s.title} · ${s.workspaceId}` }))]}
              />
            )}
            {!targets.length && !unused.length && <p className="text-[13px] text-muted">No live sessions to pick.</p>}
          </section>
        </div>
      )}
    </FormDialog>
  );
}
