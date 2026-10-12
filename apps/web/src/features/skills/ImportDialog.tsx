import { Badge, Button, Dialog, isTouchFirst } from '@isnanme/ui';
import { SKILL_UPLOAD_LIMITS, type SkillImportResult } from '@portal/contracts';
import { FileArchive, FolderUp, TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorText } from '@/lib/api';
import { skillsApi } from './api';
import { MONO, REVIEW } from './labels';

/**
 * Import (Skillset FR1): a .zip, or a folder on desktop browsers. The portal unpacks and scans it and
 * shows what it found: each skill's review state and findings, command files turned into skills (old
 * and new command), what was refused (FR5) and what a skillset doesn't carry (§4). Nothing is delivered
 * before a person approves each version.
 */
export function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SkillImportResult | null>(null);
  const zip = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const close = () => {
    if (busy) return;
    setResult(null);
    setError(null);
    onClose();
  };
  const run = async (task: () => Promise<SkillImportResult>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await task();
      setResult(r);
      onImported();
    } catch (e) {
      setError(errorText(e, 'Could not import it.'));
    } finally {
      setBusy(false);
    }
  };
  const takeZip = (file: File | undefined) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) return setError('Pick a .zip file, or a folder.');
    if (file.size > SKILL_UPLOAD_LIMITS.bytes) return setError(`Uploads can be up to ${SKILL_UPLOAD_LIMITS.bytes / 1024 / 1024} MB.`);
    void run(() => skillsApi.importZip(file));
  };
  const takeFolder = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = [...list].map((file) => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }));
    if (files.length > SKILL_UPLOAD_LIMITS.files) return setError(`The folder has more than ${SKILL_UPLOAD_LIMITS.files.toLocaleString('en')} files.`);
    void run(() => skillsApi.importFolder(files));
  };

  const first = result?.skills.find((s) => s.review === 'needs_review');
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Import skills"
      description="A zip or a folder. Each skill is reviewed before any workspace gets it."
      footer={
        result ? (
          <>
            <Button variant="secondary" onClick={close}>
              Done
            </Button>
            {first && (
              <Button
                onClick={() => {
                  close();
                  navigate(`/admin/pools/skills/review/${first.versionId}`);
                }}
              >
                Review {first.name}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {!result && (
        <div className="flex flex-col gap-3">
          <div
            onDragOver={(e) => (e.preventDefault(), setOver(true))}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              takeZip(e.dataTransfer.files[0]);
            }}
            className={`flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors ${over ? 'border-accent bg-accent-soft' : 'border-line-strong'}`}
          >
            <FileArchive className="size-7 text-muted" />
            <p className="text-[14px] text-ink-soft">Drop a .zip here, or choose one.</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={() => zip.current?.click()} loading={busy}>
                Choose a zip
              </Button>
              {!isTouchFirst() && (
                <Button variant="secondary" icon={<FolderUp className="size-4" />} onClick={() => folder.current?.click()} disabled={busy}>
                  Choose a folder
                </Button>
              )}
            </div>
            <p className="text-[12px] text-muted">
              Up to {SKILL_UPLOAD_LIMITS.bytes / 1024 / 1024} MB and {SKILL_UPLOAD_LIMITS.files.toLocaleString('en')} files. Skills, plugins and marketplaces are found up to {SKILL_UPLOAD_LIMITS.depth} levels deep.
            </p>
          </div>
          <input ref={zip} type="file" accept=".zip,application/zip" hidden aria-label="Zip file" onChange={(e) => (takeZip(e.target.files?.[0]), (e.target.value = ''))} />
          <input
            ref={(el) => {
              folder.current = el;
              // The folder picker isn't in React's types.
              el?.setAttribute('webkitdirectory', '');
            }}
            type="file"
            multiple
            hidden
            aria-label="Folder"
            onChange={(e) => (takeFolder(e.target.files), (e.target.value = ''))}
          />
          {error && (
            <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-danger">
              {error}
            </p>
          )}
        </div>
      )}
      {result && <Result result={result} />}
    </Dialog>
  );
}

function Result({ result }: { result: SkillImportResult }) {
  const { skills, refused, notImported } = result;
  return (
    <div className="flex flex-col gap-4">
      {skills.length === 0 ? (
        <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">No skills found: a skill is a folder with a SKILL.md.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {skills.map((s) => (
            <li key={s.versionId} className="rounded-xl border border-line px-3.5 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-semibold" style={{ fontFamily: MONO }}>
                  {s.name}
                </span>
                <Badge tone={REVIEW[s.review].tone}>{REVIEW[s.review].label}</Badge>
                {s.status === 'existing' && <Badge>Already imported</Badge>}
                {s.scripted && <Badge tone="warning">Scripted</Badge>}
                {s.findings.high > 0 && <Badge tone="danger">{s.findings.high} high</Badge>}
                {s.findings.medium > 0 && <Badge tone="warning">{s.findings.medium} medium</Badge>}
                {s.findings.low > 0 && <Badge>{s.findings.low} low</Badge>}
              </div>
              {s.command && (
                <p className="mt-1 text-[12.5px] text-ink-soft">
                  Command file turned into a skill:{' '}
                  <span style={{ fontFamily: MONO }}>
                    {s.command.from} → {s.command.to}
                  </span>
                </p>
              )}
              {s.warnings.map((w) => (
                <p key={w} className="mt-1 flex items-start gap-1.5 text-[12.5px] text-muted">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-flame" />
                  {w}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
      {refused.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-semibold text-ink-soft">Not imported: refused</p>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {refused.map((r) => (
              <li key={r.path} className="rounded-xl bg-danger-soft px-3 py-2 text-danger">
                <span style={{ fontFamily: MONO }}>{r.path}</span>: {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {notImported.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-semibold text-ink-soft">Not part of a skillset</p>
          <ul className="flex flex-col gap-1.5 text-[13px] text-muted">
            {notImported.map((r) => (
              <li key={r.path}>
                <span style={{ fontFamily: MONO }}>{r.path}</span>: {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
