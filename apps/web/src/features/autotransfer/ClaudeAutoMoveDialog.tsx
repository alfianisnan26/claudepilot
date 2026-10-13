// A Claude's own auto move choices (FR20, the Claudes list's ⋯ "Auto move…"): its threshold, and where its chats may go, in order.
// An empty list means any Claude of the workspace that can take the chat; a list is an allowlist, tried in that order.
import { FormDialog, TextField } from '@isnanme/ui';
import { AUTO_BOUNDS, type AutoClaudeConfig } from '@portal/contracts';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { autoApi, type AutoOverview } from './api';
import { moveItem, parseThreshold, toggleItem } from './pure';

const iconButton =
  'press inline-flex size-9 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-surface hover:text-ink disabled:opacity-40 tap:size-11';

export function ClaudeAutoMoveDialog({ claudeId, onClose }: { claudeId: string | null; onClose: () => void }) {
  const [data, setData] = useState<AutoOverview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [threshold, setThreshold] = useState('');
  const [dests, setDests] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!claudeId) return;
    let live = true;
    setData(null);
    setFailed(null);
    setError(undefined);
    autoApi.overview().then(
      (o) => {
        if (!live) return;
        const own = o.claudes.find((c) => c.claudeId === claudeId);
        setData(o);
        setThreshold(own?.thresholdPct == null ? '' : String(own.thresholdPct));
        setDests(own?.destinations ?? []);
      },
      (e: unknown) => live && setFailed(errorText(e, 'Couldn’t load auto move.')),
    );
    return () => void (live = false);
  }, [claudeId]);

  const own: AutoClaudeConfig | undefined = data?.claudes.find((c) => c.claudeId === claudeId);
  const others = own ? data!.claudes.filter((c) => c.workspaceId === own.workspaceId && c.claudeId !== own.claudeId) : [];
  const name = (id: string) => others.find((c) => c.claudeId === id)?.claudeName ?? id;
  const b = AUTO_BOUNDS.thresholdPct;

  const save = async () => {
    if (!claudeId || !own) return;
    const t = parseThreshold(threshold);
    if (t === 'invalid') return setError(`A whole number from ${b.min} to ${b.max}, or empty.`);
    setSaving(true);
    try {
      await autoApi.setClaude(claudeId, { thresholdPct: t, destinations: dests });
      onClose();
    } catch (e) {
      setFailed(errorText(e, 'Couldn’t save.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={!!claudeId}
      onClose={onClose}
      size="sm"
      title={own ? `Auto move · ${own.claudeName}` : 'Auto move'}
      onSubmit={save}
      saving={saving}
      submitDisabled={!own}
      error={failed}
    >
      {!data && !failed ? (
        <div className="skeleton h-24 rounded-xl" aria-busy="true" />
      ) : data && !own ? (
        <p className="text-[13px] text-muted">Not used on an account pool.</p>
      ) : own ? (
        <div className="flex flex-col gap-4">
          {data!.platform.mode === 'off' && (
            <p className="text-[13px] text-muted">
              Auto move is off.{' '}
              <Link to="/admin/settings" onClick={onClose} className="font-semibold text-ink underline underline-offset-2">
                Settings
              </Link>
            </p>
          )}
          <TextField
            label="Threshold %"
            inputMode="numeric"
            autoComplete="off"
            placeholder={`${data!.effective.thresholdPct} (default)`}
            value={threshold}
            onChange={(e) => (setThreshold(e.target.value), setError(undefined))}
            error={error}
          />
          <div className="flex flex-col gap-1.5">
            <p className="flex items-center gap-1 text-[13px] font-semibold">
              Destinations
              <InfoTip label="About destinations">
                None chosen: any Claude of this workspace that can take the chat, the one with the most left first. Chosen: only these, tried in this order.
              </InfoTip>
            </p>
            {others.length === 0 && <p className="text-[13px] text-muted">No other Claude on this workspace.</p>}
            <ul className="flex flex-col gap-1">
              {dests.map((id, i) => (
                <li key={id} className="flex min-w-0 items-center gap-1 rounded-xl bg-surface-2 py-1 pr-1 pl-3">
                  <span className="w-5 shrink-0 text-[13px] text-muted tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">{name(id)}</span>
                  <button type="button" className={iconButton} aria-label={`Move ${name(id)} up`} disabled={i === 0} onClick={() => setDests(moveItem(dests, i, -1))}>
                    <ArrowUp className="size-4" aria-hidden="true" />
                  </button>
                  <button type="button" className={iconButton} aria-label={`Move ${name(id)} down`} disabled={i === dests.length - 1} onClick={() => setDests(moveItem(dests, i, 1))}>
                    <ArrowDown className="size-4" aria-hidden="true" />
                  </button>
                  <button type="button" className={iconButton} aria-label={`Remove ${name(id)}`} onClick={() => setDests(toggleItem(dests, id))}>
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
              {others
                .filter((c) => !dests.includes(c.claudeId))
                .map((c) => (
                  <li key={c.claudeId}>
                    <button
                      type="button"
                      onClick={() => setDests(toggleItem(dests, c.claudeId))}
                      className="press flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl px-3 text-left text-sm text-ink-soft hover:bg-surface-2 hover:text-ink"
                    >
                      <Plus className="size-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 [overflow-wrap:anywhere]">{c.claudeName}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        </div>
      ) : null}
    </FormDialog>
  );
}
