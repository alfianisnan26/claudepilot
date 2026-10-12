import { Badge, Button, Dialog, LoadError, RowsSkeleton, TextArea, useToast } from '@isnanme/ui';
import type { SkillFileInfo, SkillFinding, SkillVersionDetail } from '@portal/contracts';
import { Bot, ChevronLeft, FileCode2, FileText, OctagonAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { errorText } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { skillsApi } from './api';
import { FileViewer } from './FileViewer';
import { MONO, REVIEW, RISK, shortHash, size, TIER } from './labels';
import { Check } from './parts';

const TIERS = ['high', 'medium', 'low'] as const;

/**
 * Reviewing one skill version (Skillset PRD §11.2, §13, `/admin/pools/skills/review/:versionId`): its
 * findings by tier, each linking to its line, the file list and a read-only viewer, the frontmatter, the
 * license and a sticky Approve and Reject. A skill without High findings needs one click. With any, the
 * reviewer ticks every flagged item and says what they checked; credential material can't be approved.
 */
export function ReviewPage() {
  const { versionId = '' } = useParams();
  const toast = useToast();
  const [v, setV] = useState<SkillVersionDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [license, setLicense] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [jump, setJump] = useState<{ line: number; nonce: number } | null>(null);
  const [deciding, setDeciding] = useState<'reject' | 'revoke' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const d = await skillsApi.version(versionId);
      setV(d);
      setFile((cur) => cur ?? d.files.find((f) => f.path === 'SKILL.md')?.path ?? d.files[0]?.path ?? null);
    } catch {
      setFailed(true);
    }
  }, [versionId]);
  useEffect(() => {
    setV(null);
    setTicked(new Set());
    setNote('');
    setLicense(false);
    setFile(null);
    void load();
  }, [load]);

  const flagged = useMemo(() => (v?.findings ?? []).filter((f) => f.needsAck), [v]);
  const credential = !!v?.findings.some((f) => f.code === 'credential');
  const left = flagged.filter((f) => !ticked.has(f.id)).length;
  const needsLicense = !!v && !v.openSourceLicense;
  const approvable = !!v && !credential && left === 0 && (flagged.length === 0 || note.trim() !== '') && (!needsLicense || license);
  const why = credential
    ? 'It contains credential material, which can’t be approved.'
    : left > 0
      ? `${left} flagged item${left === 1 ? '' : 's'} left to check.`
      : flagged.length > 0 && !note.trim()
        ? 'Say what you checked in the flagged items.'
        : needsLicense && !license
          ? 'Confirm the license allows this use.'
          : null;

  const decide = async (run: () => Promise<SkillVersionDetail>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      setV(await run());
      toast(done);
      setDeciding(null);
      setReason('');
    } catch (e) {
      const text = errorText(e, 'Could not save the decision.');
      setError(text);
      toast(text, 'error');
    } finally {
      setBusy(false);
    }
  };

  const open = (f: SkillFinding) => {
    if (!f.file) return;
    setFile(f.file);
    if (f.line) setJump({ line: f.line, nonce: Date.now() });
    document.getElementById('skill-viewer')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return (
    <>
      <Link to="/admin/pools/skills/library" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink">
        <ChevronLeft className="size-4" />
        Library
      </Link>
      {failed && <LoadError onRetry={load} />}
      {!v && !failed && <RowsSkeleton rows={4} lines={2} trailing={false} />}
      {v && (
        <>
          <PageHeader
            title={<span style={{ fontFamily: MONO }}>{v.name}</span>}
            description={v.description || undefined}
            action={
              v.review === 'approved' ? (
                <Button variant="secondary" onClick={() => setDeciding('revoke')}>
                  Revoke
                </Button>
              ) : undefined
            }
          />
          <div className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <Badge tone={REVIEW[v.review].tone}>{REVIEW[v.review].label}</Badge>
            <Badge tone={RISK[v.risk].tone}>{RISK[v.risk].label}</Badge>
            {v.scripted && <Badge tone="warning">Scripted</Badge>}
            {v.network && <Badge tone="warning">Network</Badge>}
            {v.hooks && <Badge tone="danger">Hooks</Badge>}
            {v.proposal && <Badge tone={v.review === 'needs_review' ? 'warning' : 'neutral'}>Proposed</Badge>}
            <span className="text-[13px] text-muted">
              {v.sourceLabel} · <span style={{ fontFamily: MONO }}>{shortHash(v.treeHash)}</span> · {v.fileCount} file{v.fileCount === 1 ? '' : 's'}, {size(v.sizeBytes)}
              {v.license ? ` · ${v.license}${v.openSourceLicense ? '' : ' (not a recognized open-source license)'}` : ' · no license'}
            </span>
          </div>

          <div className="flex flex-col gap-7">
            {v.proposal && (
              <div className="flex flex-col gap-1 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-3 text-[13px]">
                <p className="flex items-start gap-2 font-medium text-ink">
                  <Bot className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
                  <span>
                    Proposed by <span style={{ fontFamily: MONO }}>{v.proposal.actor}</span>
                    {v.proposal.workspaceId ? (
                      <>
                        {' '}for <span style={{ fontFamily: MONO }}>{v.proposal.workspaceId}</span>
                      </>
                    ) : null}{' '}
                    {timeAgo(v.proposal.at)}
                    {v.review === 'needs_review' ? '. Not written by a person here: read every file.' : '.'}
                  </span>
                </p>
                {v.proposal.replaces && <p className="pl-6 text-ink-soft">Changes <span style={{ fontFamily: MONO }}>{v.proposal.replaces}</span></p>}
                {v.proposal.reason && <p className="pl-6 text-ink-soft">{v.proposal.reason}</p>}
              </div>
            )}
            {v.review === 'revoked' && (
              <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13.5px] font-medium text-danger">
                <OctagonAlert className="mt-0.5 size-4 shrink-0" />
                Revoked: it left every workspace and no skillset can deliver it.
              </p>
            )}
            {credential && (
              <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13.5px] font-medium text-danger">
                <OctagonAlert className="mt-0.5 size-4 shrink-0" />
                Contains credentials: it can’t be approved. Reject it, or import it again without them.
              </p>
            )}

            <Findings findings={v.findings} ticked={ticked} onTick={(id, on) => setTicked((s) => (on ? new Set(s).add(id) : new Set([...s].filter((x) => x !== id))))} onOpen={open} editable={v.review === 'needs_review' || v.review === 'rejected'} />

            <section id="skill-viewer">
              <h3 className="mb-2 text-[15px] font-semibold">Files</h3>
              <FileList files={v.files} findings={v.findings} current={file} onPick={(p) => (setFile(p), setJump(null))} />
              {file && (
                <div className="mt-3">
                  <p className="mb-1.5 text-[12.5px] font-medium text-ink-soft" style={{ fontFamily: MONO }}>
                    {file}
                  </p>
                  <FileViewer versionId={v.id} path={file} findings={v.findings.filter((f) => f.file === file)} jumpTo={jump} />
                </div>
              )}
            </section>

            <Frontmatter v={v} />
            <History v={v} />

            {(v.review === 'needs_review' || v.review === 'rejected') && (
              <section className="flex flex-col gap-3">
                <h3 className="text-[15px] font-semibold">Your decision</h3>
                <TextArea
                  label={flagged.length ? 'What you checked' : 'Note'}
                  optional={flagged.length === 0}
                  hint={flagged.length ? 'Required: what you checked.' : 'Required to reject.'}
                  value={note}
                  maxLength={500}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                />
                {needsLicense && (
                  <Check checked={license} onChange={setLicense}>
                    I confirm the license allows this.
                    <span className="mt-0.5 block text-[12.5px] text-muted">Not a recognized open-source license.</span>
                  </Check>
                )}
                {error && (
                  <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
                    {error}
                  </p>
                )}
              </section>
            )}
          </div>

          {(v.review === 'needs_review' || v.review === 'rejected') && (
            <div className="sticky bottom-[var(--tabbar-h,0px)] z-10 -mx-4 mt-6 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-bg/90 px-4 py-3 backdrop-blur-md sm:bottom-0 sm:mx-0 sm:px-0">
              <p className="mr-auto min-w-0 flex-1 text-[12.5px] text-muted">{why ?? 'Ready to approve.'}</p>
              {v.review === 'needs_review' && (
                <Button variant="secondary" onClick={() => (setDeciding('reject'), setReason(note))} disabled={busy}>
                  Reject
                </Button>
              )}
              <Button
                icon={<ShieldCheck className="size-4" />}
                disabled={!approvable || busy}
                loading={busy && !deciding}
                title={why ?? undefined}
                onClick={() => void decide(() => skillsApi.review(v.id, { decision: 'approved', note: note.trim(), acknowledged: [...ticked], licenseConfirmed: license }), `${v.name} approved`)}
              >
                Approve
              </Button>
            </div>
          )}

          <Dialog
            open={deciding !== null}
            onClose={() => !busy && setDeciding(null)}
            size="sm"
            title={deciding === 'revoke' ? `Revoke ${v.name}?` : `Reject ${v.name}?`}
            description={
              deciding === 'revoke'
                ? 'It leaves every workspace at once and its commands stay blocked for 14 days. This can’t be undone.'
                : 'It stays in the library as rejected.'
            }
            footer={
              <>
                <Button variant="secondary" onClick={() => setDeciding(null)} disabled={busy} data-autofocus>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={busy}
                  disabled={reason.trim() === ''}
                  onClick={() =>
                    void decide(
                      () => (deciding === 'revoke' ? skillsApi.revoke(v.id, reason.trim()) : skillsApi.review(v.id, { decision: 'rejected', note: reason.trim() })),
                      deciding === 'revoke' ? `${v.name} revoked` : `${v.name} rejected`,
                    )
                  }
                >
                  {deciding === 'revoke' ? 'Revoke' : 'Reject'}
                </Button>
              </>
            }
          >
            <TextArea label="Why" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} rows={3} />
          </Dialog>
        </>
      )}
    </>
  );
}

function Findings({
  findings,
  ticked,
  onTick,
  onOpen,
  editable,
}: {
  findings: SkillFinding[];
  ticked: Set<string>;
  onTick: (id: string, on: boolean) => void;
  onOpen: (f: SkillFinding) => void;
  editable: boolean;
}) {
  if (findings.length === 0)
    return (
      <section>
        <h3 className="mb-2 text-[15px] font-semibold">Findings</h3>
        <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">The scanner found nothing to flag. Read the files below before you approve.</p>
      </section>
    );
  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-[15px] font-semibold">Findings</h3>
      {TIERS.map((tier) => {
        const list = findings.filter((f) => f.tier === tier);
        if (list.length === 0) return null;
        return (
          <div key={tier}>
            <p className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-ink-soft">
              <Badge tone={TIER[tier].tone}>{TIER[tier].label}</Badge>
              {list.length} finding{list.length === 1 ? '' : 's'}
            </p>
            <ul className="flex flex-col gap-2">
              {list.map((f) => (
                <li key={f.id} className="rounded-xl border border-line bg-surface px-3.5 py-2.5">
                  <div className="flex items-start gap-2">
                    <TriangleAlert className={`mt-0.5 size-4 shrink-0 ${f.tier === 'high' ? 'text-danger' : f.tier === 'medium' ? 'text-flame' : 'text-muted'}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium">{f.title}</p>
                      {f.file && (
                        <button type="button" onClick={() => onOpen(f)} className="mt-0.5 text-left text-[12.5px] text-accent underline-offset-2 hover:underline" style={{ fontFamily: MONO }}>
                          {f.file}
                          {f.line ? `:${f.line}` : ''}
                        </button>
                      )}
                      {f.excerpt && (
                        <pre className="mt-1.5 max-h-28 overflow-auto rounded-lg bg-surface-2/70 px-2.5 py-1.5 text-[12px] break-all whitespace-pre-wrap" style={{ fontFamily: MONO }}>
                          {f.excerpt}
                        </pre>
                      )}
                    </div>
                  </div>
                  {f.needsAck && editable && f.code !== 'credential' && (
                    <Check checked={ticked.has(f.id)} onChange={(on) => onTick(f.id, on)} className="mt-1 border-t border-line pt-2">
                      I read this and it’s fine
                    </Check>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function FileList({ files, findings, current, onPick }: { files: SkillFileInfo[]; findings: SkillFinding[]; current: string | null; onPick: (path: string) => void }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {files.map((f) => {
        const hits = findings.filter((x) => x.file === f.path).length;
        const Icon = f.kind === 'script' ? FileCode2 : FileText;
        return (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => onPick(f.path)}
              aria-current={current === f.path}
              className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition-colors hover:bg-surface-2/60 ${current === f.path ? 'bg-surface-2' : ''}`}
            >
              <Icon className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate" style={{ fontFamily: MONO }}>
                {f.path}
              </span>
              {hits > 0 && <Badge tone="warning">{hits} flagged</Badge>}
              {f.kind === 'script' && <Badge tone="warning">{f.interpreter ?? 'script'}</Badge>}
              {f.mode === 0o755 && <Badge>Executable</Badge>}
              <span className="shrink-0 text-[12px] text-muted">{size(f.size)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Frontmatter({ v }: { v: SkillVersionDetail }) {
  const entries = Object.entries(v.frontmatter);
  if (entries.length === 0 && v.requirements.length === 0 && v.licenseFiles.length === 0) return null;
  const text = (x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x));
  return (
    <section>
      <h3 className="mb-2 text-[15px] font-semibold">About this skill</h3>
      <dl className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface text-[13px]">
        {entries.map(([k, val]) => (
          <div key={k} className="flex flex-col gap-0.5 px-3.5 py-2 sm:flex-row sm:gap-4">
            <dt className="w-44 shrink-0 text-muted" style={{ fontFamily: MONO }}>
              {k}
            </dt>
            <dd className="min-w-0 flex-1 break-words whitespace-pre-wrap text-ink-soft">{text(val).slice(0, 600)}</dd>
          </div>
        ))}
        {v.requirements.length > 0 && (
          <div className="flex flex-col gap-0.5 px-3.5 py-2 sm:flex-row sm:gap-4">
            <dt className="w-44 shrink-0 text-muted">Needs</dt>
            <dd className="min-w-0 flex-1 text-ink-soft">{v.requirements.join(', ')}. The workspace image has to provide these.</dd>
          </div>
        )}
        {v.licenseFiles.length > 0 && (
          <div className="flex flex-col gap-0.5 px-3.5 py-2 sm:flex-row sm:gap-4">
            <dt className="w-44 shrink-0 text-muted">License files</dt>
            <dd className="min-w-0 flex-1 text-ink-soft" style={{ fontFamily: MONO }}>
              {v.licenseFiles.join(', ')}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function History({ v }: { v: SkillVersionDetail }) {
  if (v.reviews.length === 0 && v.inSets.length === 0) return null;
  return (
    <section className="flex flex-col gap-4">
      {v.inSets.length > 0 && (
        <div>
          <h3 className="mb-2 text-[15px] font-semibold">In skillsets</h3>
          <ul className="flex flex-col gap-1 text-[13px] text-ink-soft">
            {v.inSets.map((s) => (
              <li key={s.poolId}>
                {s.poolName} <span className="text-muted">({s.revisions.map((r) => `r${r}`).join(', ')})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {v.reviews.length > 0 && (
        <div>
          <h3 className="mb-2 text-[15px] font-semibold">Decisions</h3>
          <ul className="flex flex-col gap-2">
            {v.reviews.map((r) => (
              <li key={r.at} className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[13px]">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.decision === 'approved' ? 'success' : r.decision === 'revoked' ? 'danger' : 'neutral'}>{r.decision[0]!.toUpperCase() + r.decision.slice(1)}</Badge>
                  <span className="text-muted">{formatDateTime(r.at)}</span>
                  {r.session && <span className="text-muted">· session {r.session}</span>}
                  {r.acknowledged.length > 0 && <span className="text-muted">· {r.acknowledged.length} flagged item{r.acknowledged.length === 1 ? '' : 's'} checked</span>}
                  {r.licenseConfirmed && <span className="text-muted">· license confirmed</span>}
                </p>
                {r.note && <p className="mt-1 text-ink-soft">{r.note}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
