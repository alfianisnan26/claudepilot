import { FormDialog, SwitchRow, TextArea } from '@isnanme/ui';
import { REPO_PATH_MAX, REPO_ROOTS_MAX, type RepoSettings } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { ApiError, errorText } from '@/lib/api';
import { reposApi } from './api';
import { useEscapeTop } from './escape';
import { parseRoots } from './labels';

/**
 * How a workspace is scanned: the folders to walk (one per line, inside the home folder; empty means the defaults) and whether
 * the portal scans by itself while the workspace runs. A scan at start, around chats and on request always works.
 */
export function SettingsDialog({ workspaceId, settings, open, onClose, onSaved }: { workspaceId: string; settings: RepoSettings | null; open: boolean; onClose: () => void; onSaved: (s: RepoSettings, rootsChanged: boolean) => void }) {
  const [roots, setRoots] = useState('');
  const [auto, setAuto] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setRoots((settings?.roots ?? []).join('\n'));
    setAuto(settings?.auto ?? true);
    setError(undefined);
  }, [open, settings]);
  // Stays on the stack while saving, so the key can't fall through to the sheet underneath.
  useEscapeTop(open, () => !saving && onClose());

  const list = parseRoots(roots);
  const dirty = !!settings && (auto !== settings.auto || list.join('\n') !== (settings.roots ?? []).join('\n'));
  const submit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const saved = await reposApi.saveSettings(workspaceId, { roots: list.length ? list : null, auto });
      onSaved(saved, list.join('\n') !== (settings?.roots ?? []).join('\n'));
    } catch (e) {
      const d = e instanceof ApiError ? (e.details as { roots?: unknown } | undefined) : undefined;
      setError(typeof d?.roots === 'string' ? `${errorText(e, 'Check the folders.')}` : errorText(e, 'Couldn’t save.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={() => !saving && onClose()}
      size="sm"
      title={
        <span className="inline-flex items-center gap-1">
          Scanning
          <InfoTip label="About scanning">
            The portal looks for git repos in these folders (inside the home folder, up to {REPO_ROOTS_MAX}) when the workspace starts, around sessions, on a timer while it runs and when asked. It only reads: nothing is fetched or changed.
          </InfoTip>
        </span>
      }
      onSubmit={submit}
      submitLabel="Save"
      submitDisabled={!dirty}
      saving={saving}
      error={error}
    >
      <TextArea
        label="Folders"
        optional
        rows={3}
        maxLength={REPO_ROOTS_MAX * (REPO_PATH_MAX + 1)}
        placeholder={(settings?.defaultRoots ?? ['~']).join('\n')}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="[&_textarea]:font-mono [&_textarea]:text-sm"
        value={roots}
        onChange={(e) => (setRoots(e.target.value), setError(undefined))}
      />
      <SwitchRow label="Automatic" checked={auto} onChange={setAuto} className="-my-1" />
    </FormDialog>
  );
}
