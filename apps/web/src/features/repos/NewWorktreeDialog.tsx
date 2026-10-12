import { FormDialog, SwitchRow, TextField } from '@isnanme/ui';
import type { CreateRepoWorktreeResult, RepoNode } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { ApiError, errorText } from '@/lib/api';
import { reposApi } from './api';
import { useEscapeTop } from './escape';

/**
 * A worktree of a repository, made by the portal's own hardened git (the same one a chat's worktree goes through): Branch and From
 * as in the chat's "New session", both optional. "Keep synced" fast-forwards it from its upstream while it is clean.
 */
export function NewWorktreeDialog({ repo, onClose, onCreated, onRefused }: { repo: RepoNode | null; onClose: () => void; onCreated: (r: CreateRepoWorktreeResult) => void; onRefused?: (e: unknown) => void }) {
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [sync, setSync] = useState(false);
  const [errors, setErrors] = useState<{ branch?: string; base?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);
  const id = repo?.id;
  useEffect(() => {
    setBranch('');
    setBase('');
    setSync(false);
    setErrors({});
  }, [id]);
  useEscapeTop(!!repo, () => !saving && onClose());

  const submit = async () => {
    if (!repo) return;
    setSaving(true);
    setErrors({});
    try {
      const made = await reposApi.createWorktree(repo.id, { branch: branch.trim() || undefined, base: base.trim() || undefined, sync: sync || undefined });
      onCreated(made);
    } catch (e) {
      onRefused?.(e);
      const d = e instanceof ApiError ? (e.details as { branch?: unknown; base?: unknown } | undefined) : undefined;
      const field = (v: unknown) => (typeof v === 'string' ? v : undefined);
      if (field(d?.branch) || field(d?.base)) setErrors({ branch: field(d?.branch), base: field(d?.base), form: errorText(e, '') || undefined });
      else setErrors({ form: errorText(e, 'Couldn’t make the worktree.') });
    } finally {
      setSaving(false);
    }
  };

  const mono = '[&_input]:font-mono';
  return (
    <FormDialog
      open={!!repo}
      onClose={() => !saving && onClose()}
      size="sm"
      title={
        <span className="inline-flex items-center gap-1">
          New worktree
          <InfoTip label="About worktrees">
            A branch of <span className="font-mono [overflow-wrap:anywhere]">{repo?.name}</span> in a folder of its own beside it, so work there stays apart from the working folder and from sessions. Leave Branch empty and the portal names one; From is the branch, tag or commit it starts from (default: the current commit).
          </InfoTip>
        </span>
      }
      onSubmit={submit}
      submitLabel="Create"
      saving={saving}
      // The field errors say what to fix; the form line is for what isn't about a field.
      error={errors.branch || errors.base ? undefined : errors.form}
    >
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Branch"
          optional
          placeholder="wt/…"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={100}
          className={mono}
          value={branch}
          error={errors.branch}
          onChange={(e) => (setBranch(e.target.value), setErrors((x) => ({ ...x, branch: undefined })))}
        />
        <TextField
          label="From"
          optional
          placeholder="current commit"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={100}
          className={mono}
          value={base}
          error={errors.base}
          onChange={(e) => (setBase(e.target.value), setErrors((x) => ({ ...x, base: undefined })))}
        />
      </div>
      <SwitchRow
        label={
          <span className="inline-flex items-center gap-1">
            Keep synced
            <InfoTip label="About keeping synced">
              The portal fetches the upstream branch now and then and fast-forwards this worktree when it has no changes. It never merges, rebases or discards anything, and shows ahead, behind and diverged instead.
            </InfoTip>
          </span>
        }
        checked={sync}
        onChange={setSync}
        className="-my-1"
      />
    </FormDialog>
  );
}
