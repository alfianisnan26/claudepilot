import { Badge, Button, Dialog, FormDialog, RowsSkeleton, Segmented, Select, SwitchRow, TextField, useToast } from '@isnanme/ui';
import {
  AGENT_POLICIES,
  type AgentPolicy,
  type KnowledgeSource,
  type NoteHistoryEntry,
  type NoteVersion,
  type PortalAgentWorkspace,
  type VaultImportPolicy,
  type VaultImportReport,
  type VaultSummary,
} from '@portal/contracts';
import { ArrowLeft, FileUp, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { formatBytes, timeAgo } from '@/lib/format';
import { portalMcpApi } from '../portalmcp/api';
import { settingsPayload, toastSaveWarning, toggleWorkspace, workspaceChoices } from './agentWorkspaces';
import { errorText, knowledgeApi } from './api';
import { DiffView } from './NoteEditor';
import { useLoad } from './hooks';
import { actorLabel, OP_LABEL, POLICY_HELP, POLICY_LABEL, sizeLabel } from './labels';

const POLICY_OPTIONS = AGENT_POLICIES.map((p) => ({ value: p, label: POLICY_LABEL[p] }));

function PolicyField({ value, onChange }: { value: AgentPolicy; onChange: (v: AgentPolicy) => void }) {
  return (
    <div className="flex items-end gap-1.5">
      <div className="min-w-0 flex-1">
        <Select label="Agents" value={value} onChange={(v) => onChange(v as AgentPolicy)} options={POLICY_OPTIONS} />
      </div>
      <InfoTip label="About agent access" className="mb-2.5">
        <ul className="space-y-1">
          {AGENT_POLICIES.map((p) => (
            <li key={p}>
              <b className="font-semibold text-ink">{POLICY_LABEL[p]}</b> {POLICY_HELP[p]}
            </li>
          ))}
        </ul>
      </InfoTip>
    </div>
  );
}

/** A new vault, or a folder source when the operator allowed any. */
export function NewVaultDialog({ open, sources, onClose, onCreated }: { open: boolean; sources: KnowledgeSource[]; onClose: () => void; onCreated: (v: VaultSummary) => void }) {
  const [name, setName] = useState('');
  const [agents, setAgents] = useState<AgentPolicy>('write-own');
  const [mode, setMode] = useState<'new' | 'folder'>('new');
  const [root, setRoot] = useState(sources[0]?.name ?? '');
  const [sub, setSub] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const v = await knowledgeApi.createVault(mode === 'folder' ? { name: name.trim() || undefined, agents: 'read', source: { root, sub: sub.trim() || undefined } } : { name, agents });
      setName('');
      setSub('');
      onCreated(v);
    } catch (e) {
      setError(errorText(e, 'Could not create it.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog open={open} onClose={() => !saving && onClose()} size="sm" title={mode === 'folder' ? 'Folder source' : 'New vault'} onSubmit={submit} submitLabel="Create" saving={saving} error={error} submitDisabled={mode === 'new' && !name.trim()}>
      {sources.length > 0 && (
        <Segmented
          label="Kind"
          value={mode}
          options={[
            { value: 'new', label: 'New' },
            { value: 'folder', label: 'Folder' },
          ]}
          onChange={setMode}
        />
      )}
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" optional={mode === 'folder'} />
      {mode === 'new' ? (
        <PolicyField value={agents} onChange={setAgents} />
      ) : (
        <>
          <Select label="Folder" value={root} onChange={setRoot} options={sources.map((s) => ({ value: s.name, label: `${s.name}${s.writable ? '' : ' (read-only)'}` }))} />
          <TextField label="Subfolder" value={sub} onChange={(e) => setSub(e.target.value)} autoComplete="off" optional />
        </>
      )}
    </FormDialog>
  );
}

const SKIP_LABEL: Record<string, string> = {
  hidden: 'Hidden folders',
  'not-allowed': 'Unsupported files',
  dangerous: 'Scripts and programs',
  symlink: 'Links',
  'too-large': 'Too large',
  'not-text': 'Not text',
  'invalid-name': 'Bad names',
  duplicate: 'Same name',
};

/** A zip into a new vault, or into `into`. The result stays on screen: what came in, what was skipped. */
export function ImportDialog({ open, into, onClose, onDone }: { open: boolean; into?: VaultSummary | null; onClose: () => void; onDone: (r: VaultImportReport) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [policy, setPolicy] = useState<VaultImportPolicy>('keep-both');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<VaultImportReport | null>(null);

  const reset = () => {
    setFile(null);
    setName('');
    setError(null);
    setReport(null);
  };
  const close = () => {
    if (busy) return;
    const done = report;
    reset();
    onClose();
    if (done) onDone(done);
  };

  const run = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await knowledgeApi.importZip(file, { into: into?.id, name: name.trim() || undefined, policy }));
    } catch (e) {
      setError(errorText(e, 'Could not import it.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title={report ? 'Imported' : into ? `Import into ${into.name}` : 'Import zip'}
      footer={
        report ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={run} disabled={!file} loading={busy}>
              Import
            </Button>
          </>
        )
      }
    >
      {report ? (
        <div className="space-y-2 text-[14.5px]">
          <p className="font-semibold">
            {report.notes} notes, {report.attachments} files{report.created ? ` in ${report.vaultName}` : ''}
          </p>
          {(report.renamed > 0 || report.overwritten > 0 || report.skippedExisting > 0) && (
            <p className="text-muted">
              {[report.renamed && `${report.renamed} renamed`, report.overwritten && `${report.overwritten} replaced`, report.skippedExisting && `${report.skippedExisting} already there`].filter(Boolean).join(' · ')}
            </p>
          )}
          {report.skipped.length > 0 && (
            <ul className="space-y-1">
              {report.skipped.map((s) => (
                <li key={s.reason} className="flex items-center gap-1.5 text-muted">
                  <span>
                    {SKIP_LABEL[s.reason] ?? s.reason} <b className="font-semibold text-ink">{s.count}</b>
                  </span>
                  <InfoTip label={`${SKIP_LABEL[s.reason] ?? s.reason}: examples`}>{s.examples.join(', ')}</InfoTip>
                </li>
              ))}
            </ul>
          )}
          {report.warnings.map((w) => (
            <p key={w} className="text-[13px] text-muted">
              {w}
            </p>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button variant="secondary" icon={<FileUp className="size-4" />} onClick={() => input.current?.click()}>
            {file ? file.name : 'Choose a zip'}
          </Button>
          {file && <p className="text-[13px] text-muted">{formatBytes(file.size)}</p>}
          {into ? (
            <Select
              label="If a name exists"
              value={policy}
              onChange={(v) => setPolicy(v as VaultImportPolicy)}
              options={[
                { value: 'keep-both', label: 'Keep both' },
                { value: 'skip', label: 'Skip' },
                { value: 'overwrite', label: 'Replace' },
              ]}
            />
          ) : (
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder={file ? file.name.replace(/\.zip$/i, '') : ''} optional autoComplete="off" />
          )}
          {error && (
            <p role="alert" className="text-[13.5px] text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

/**
 * T-436: which workspaces' agents may reach this vault. A tick list (each row a 44 px target) of the workspaces the portal knows; a vault no
 * workspace is ticked on is reached by no agent.
 */
function WorkspacesField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [known, setKnown] = useState<PortalAgentWorkspace[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    portalMcpApi.agents().then(
      (w) => live && setKnown(w),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);
  const rows = workspaceChoices(known ?? [], value);
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-ink-soft">
        Workspaces
        <InfoTip label="About workspaces">
          Agents in a ticked workspace can read this vault, within the Agents setting above. A vault with none ticked is reached by no agent. A workspace is the finest the list can tell apart: two programs that share one workspace share its notes.
        </InfoTip>
      </legend>
      {known === null && !failed && <p className="text-[13px] text-muted">Loading…</p>}
      {failed && <p className="text-[13px] text-danger">Couldn’t list workspaces.</p>}
      <ul className="divide-y divide-line rounded-xl border border-line">
        {rows.map((r) => (
          <li key={r.workspaceId}>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-[14px] text-ink">
              <input type="checkbox" className="size-5 shrink-0 accent-[var(--color-accent)]" checked={r.checked} onChange={(e) => onChange(toggleWorkspace(value, r.workspaceId, e.target.checked))} />
              <span className="min-w-0 break-all">{r.workspaceId}</span>
              {r.invalid ? <span className="shrink-0 text-[12.5px] text-danger">not valid, untick it</span> : r.gone && <span className="shrink-0 text-[12.5px] text-muted">gone</span>}
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** Name, agent access, daily notes, links and labels; deleting the vault is in here too. */
export function VaultSettingsDialog({ vault, onClose, onSaved, onDelete }: { vault: VaultSummary | null; onClose: () => void; onSaved: (v: VaultSummary) => void; onDelete: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState<{ name: string; agents: AgentPolicy; dailyFolder: string; timezone: string; rewrite: boolean; labels: 'filename' | 'heading'; agentWorkspaces: string[] } | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if ((vault?.id ?? null) !== openFor) {
    setOpenFor(vault?.id ?? null);
    setError(null);
    setForm(vault ? { name: vault.name, agents: vault.agents, dailyFolder: vault.dailyFolder, timezone: vault.timezone, rewrite: vault.settings.rewriteLinksOnRename, labels: vault.settings.labels, agentWorkspaces: vault.settings.agentWorkspaces ?? [] } : null);
  }
  if (!vault || !form) return <FormDialog open={false} onClose={onClose} title="Settings" onSubmit={() => undefined}>{null}</FormDialog>;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await knowledgeApi.updateVault(vault.id, {
        name: form.name,
        agents: form.agents,
        dailyFolder: form.dailyFolder,
        timezone: form.timezone,
        settings: settingsPayload(form),
      });
      onSaved(saved);
      toastSaveWarning(saved, toast);
    } catch (e) {
      setError(errorText(e, 'Could not save.'));
    } finally {
      setSaving(false);
    }
  };
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <FormDialog
      open
      onClose={() => !saving && onClose()}
      title="Settings"
      onSubmit={submit}
      submitLabel="Save"
      saving={saving}
      error={error}
      dirty
      extraActions={
        <Button variant="danger" onClick={onDelete}>
          Delete
        </Button>
      }
    >
      <TextField label="Name" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={60} autoComplete="off" />
      <PolicyField value={form.agents} onChange={(v) => set('agents', v)} />
      <WorkspacesField value={form.agentWorkspaces} onChange={(v) => set('agentWorkspaces', v)} />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Daily notes" value={form.dailyFolder} onChange={(e) => set('dailyFolder', e.target.value)} autoComplete="off" />
        <TextField label="Time zone" value={form.timezone} onChange={(e) => set('timezone', e.target.value)} autoComplete="off" />
      </div>
      <Segmented
        label="Names"
        value={form.labels}
        options={[
          { value: 'filename', label: 'File name' },
          { value: 'heading', label: 'Heading' },
        ]}
        onChange={(v) => set('labels', v)}
      />
      <SwitchRow label="Update links on rename" checked={form.rewrite} onChange={(v) => set('rewrite', v)} />
      {vault.kind === 'vault' && <p className="text-[12.5px] break-all text-muted">{vault.location}</p>}
    </FormDialog>
  );
}

/** Typing the name is the confirmation. A vault goes to a trash folder for 14 days; a folder source is only forgotten. */
export function DeleteVaultDialog({ vault, onClose, onDeleted }: { vault: VaultSummary | null; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open={!!vault}
      onClose={() => !saving && (setTyped(''), onClose())}
      size="sm"
      title={`Delete ${vault?.name ?? ''}`}
      danger
      submitLabel="Delete"
      submitDisabled={typed !== vault?.name}
      saving={saving}
      error={error}
      onSubmit={async () => {
        if (!vault) return;
        setSaving(true);
        try {
          await knowledgeApi.deleteVault(vault.id, typed);
          toast('Deleted');
          setTyped('');
          onDeleted();
        } catch (e) {
          setError(errorText(e, 'Could not delete it.'));
        } finally {
          setSaving(false);
        }
      }}
    >
      <p className="text-[14px] text-ink-soft">{vault?.kind === 'folder' ? 'The folder itself is not touched.' : 'Kept in a trash folder for 14 days.'}</p>
      <TextField label="Type the name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
    </FormDialog>
  );
}

/** A name or path for a note: `Name`, or `Folder/Name`. `.md` is added. */
export function NoteNameDialog({
  open,
  title,
  initial,
  submitLabel,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (path: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const key = open ? `${title}|${initial}` : null;
  if (key !== openFor) {
    setOpenFor(key);
    setValue(initial);
    setError(null);
  }
  const path = value.trim().replace(/^\/+/, '');
  return (
    <FormDialog
      open={open}
      onClose={() => !saving && onClose()}
      size="sm"
      title={title}
      submitLabel={submitLabel}
      saving={saving}
      error={error}
      submitDisabled={!path}
      onSubmit={async () => {
        setSaving(true);
        setError(null);
        try {
          await onSubmit(/\.md$/i.test(path) ? path : `${path}.md`);
        } catch (e) {
          setError(errorText(e, 'Could not do that.'));
        } finally {
          setSaving(false);
        }
      }}
    >
      <TextField label="Name" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} suffix={<span className="text-muted">.md</span>} />
    </FormDialog>
  );
}

/** A note's versions: who and when; tap one for what it changed, with Restore. */
export function HistoryDialog({ open, vaultId, path, onClose, onRestored }: { open: boolean; vaultId: string; path: string; onClose: () => void; onRestored: () => void }) {
  const toast = useToast();
  const [picked, setPicked] = useState<NoteHistoryEntry | null>(null);
  const [restoring, setRestoring] = useState(false);
  const history = useLoad(`${vaultId}|${path}|${open}`, () => knowledgeApi.history(vaultId, path), open);
  const version = useLoad(`${vaultId}|${path}|${picked?.id}`, () => knowledgeApi.version(vaultId, path, picked!.id), open && !!picked) as { data: NoteVersion | null; loading: boolean };

  const restore = async () => {
    if (!picked) return;
    setRestoring(true);
    try {
      await knowledgeApi.restore(vaultId, path, picked.id);
      toast('Restored');
      setPicked(null);
      onRestored();
    } catch (e) {
      toast(errorText(e, 'Could not restore it.'), 'error');
    } finally {
      setRestoring(false);
    }
  };

  const entries = history.data?.entries ?? [];
  return (
    <Dialog
      open={open}
      onClose={() => (setPicked(null), onClose())}
      title="History"
      leading={
        picked && (
          <button type="button" aria-label="Back" onClick={() => setPicked(null)} className="press inline-flex size-9 items-center justify-center rounded-full hover:bg-surface-2">
            <ArrowLeft className="size-5" />
          </button>
        )
      }
      stepKey={picked ? String(picked.id) : 'list'}
      footer={picked && picked.hasContent ? <Button icon={<RotateCcw className="size-4" />} onClick={restore} loading={restoring}>Restore</Button> : undefined}
    >
      {!picked ? (
        history.loading && !history.data ? (
          <RowsSkeleton rows={4} lines={1} />
        ) : entries.length === 0 ? (
          <p className="text-[14px] text-muted">No changes yet.</p>
        ) : (
          <ul className="-mx-1 flex flex-col">
            {entries.map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => setPicked(e)} className="press flex w-full items-center gap-2 rounded-xl px-2 py-2.5 text-left hover:bg-surface-2/70">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-medium">{e.note === 'original' ? 'Original' : `${OP_LABEL[e.op]} · ${actorLabel(e.actor)}`}</span>
                    <span className="block truncate text-[12.5px] text-muted">
                      {timeAgo(e.at)}
                      {e.note && e.note !== 'original' ? ` · ${e.note}` : ''}
                    </span>
                  </span>
                  {e.actorKind === 'agent' && <Badge>Agent</Badge>}
                  <span className="shrink-0 text-[12.5px] text-muted">{sizeLabel(e.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : version.loading && !version.data ? (
        <RowsSkeleton rows={3} lines={1} />
      ) : version.data?.content !== null && version.data ? (
        <div className="space-y-2">
          <p className="text-[13px] text-muted">
            {picked.note === 'original' ? 'Original' : `${OP_LABEL[picked.op]} · ${actorLabel(picked.actor)}`} · {timeAgo(picked.at)}
          </p>
          <DiffView before={version.data.previous ?? ''} after={version.data.content ?? ''} />
        </div>
      ) : (
        <p className="text-[14px] text-muted">{OP_LABEL[picked.op]}{picked.fromPath ? ` from ${picked.fromPath}` : ''}.</p>
      )}
    </Dialog>
  );
}
