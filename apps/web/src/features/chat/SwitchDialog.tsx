import { Badge, cn, FormDialog, Spinner, SwitchRow, useToast } from '@isnanme/ui';
import type { ChatSession, ChatSwitchOption, ChatSwitchOptions } from '@portal/contracts';
import { CircleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { modelChange } from '@/features/autotransfer/pure';
import { ClaudeHeadroom, NoRecommendation, RecommendedMark, recommendedId, useMoveAdvice } from '@/features/usage/claude';
import { errorText } from '@/lib/api';
import { chatApi } from './api';
import { HOME } from './shared';
import { isTrustDeclined, TrustSheet, useFolderTrust } from './TrustSheet';

const tilde = (path: string) => (path === HOME ? '~' : path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the move drops, in one line: a running turn, approvals, queued messages and agents end with the process the chat leaves. */
function droppedLine(info: ChatSwitchOptions): string | null {
  const parts: string[] = [];
  if (info.working) parts.push('Stops the running turn');
  const lost = [
    info.dropped.approvals ? plural(info.dropped.approvals, 'approval') : '',
    info.dropped.queued ? plural(info.dropped.queued, 'queued message') : '',
    info.dropped.agents ? plural(info.dropped.agents, 'agent') : '',
  ].filter(Boolean);
  if (lost.length) parts.push(`Drops ${lost.join(', ')}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Move a chat to another Claude on its workspace (Workspace Claudes FR9, FR10): the chat stays the same
 * session and the Claude Code session underneath changes. What the portal would refuse is shown here, before
 * the confirm: each Claude says whether a session can start there now. The handoff is on unless the Claude
 * the chat runs on can't be asked. Confirming closes the dialog; the move shows in the chat itself.
 */
export function SwitchDialog({
  session,
  open,
  onClose,
  onConfirm,
  preselect = null,
}: {
  session: ChatSession | null;
  open: boolean;
  onClose: () => void;
  onConfirm: (claudeId: string, handoff: 'ask' | 'skip', model?: string) => void;
  /** A Claude chosen up front (auto move's Undo: the Claude the chat left), when it can take the chat. */
  preselect?: string | null;
}) {
  const [info, setInfo] = useState<ChatSwitchOptions | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [touched, setTouched] = useState(false);
  const [ask, setAsk] = useState(true);
  const id = session?.id ?? null;
  // The Claude the portal recommends (what each has left, when it resets): the default choice until the person picks, marked in the list.
  const advice = useMoveAdvice(session?.workspaceId ?? null, session?.claudeId || null, open);

  useEffect(() => {
    if (!open || !id) return;
    let current = true;
    setInfo(null);
    setFailed(null);
    setPick('');
    setTouched(!!preselect);
    setAsk(true);
    chatApi.switchOptions(id).then(
      (r) => {
        if (!current) return;
        setInfo(r);
        // A Claude that keeps the chat's model first (T-109), then any that can take it.
        const first = r.options.find((o) => o.ok && !modelChange(o)) ?? r.options.find((o) => o.ok);
        setPick((preselect && r.options.find((o) => o.ok && o.claude.id === preselect)?.claude.id) || (first?.claude.id ?? ''));
      },
      (e: unknown) => current && setFailed(errorText(e, 'Couldn’t check where this chat can move.')),
    );
    return () => {
      current = false;
    };
  }, [open, id, preselect]);

  useEffect(() => {
    const rec = recommendedId(advice);
    if (!touched && rec && info?.options.some((o) => o.ok && o.claude.id === rec)) setPick(rec);
  }, [advice, info, touched]);

  const from = session?.claudeName ?? 'this Claude';
  const warning = info && droppedLine(info);
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      size="sm"
      title={
        <span className="inline-flex items-center gap-1.5">
          Move chat
          <InfoTip label="About moving a chat">
            The chat stays the same. A new Claude Code session starts on the Claude you pick, in{' '}
            <span className="font-mono break-all">{info ? tilde(info.folder) : 'the same folder'}</span>, and the conversation is carried over. Logins stay in their own directories.
          </InfoTip>
        </span>
      }
      onSubmit={() => {
        if (!pick) return;
        const change = modelChange(info?.options.find((o) => o.claude.id === pick) ?? {});
        onConfirm(pick, ask && info?.handoff.ok ? 'ask' : 'skip', change?.to ?? undefined);
      }}
      submitLabel="Move"
      submitDisabled={!pick || !info}
    >
      {failed ? (
        <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">
          {failed}
        </p>
      ) : !info ? (
        <p className="flex items-center gap-2 py-3 text-[13.5px] text-muted">
          <Spinner className="size-4" /> Checking…
        </p>
      ) : info.options.length === 0 ? (
        <p className="text-[14px] text-ink-soft">
          No other Claude on this workspace.{' '}
          <Link to="/admin/workspaces" className="font-semibold text-ink underline underline-offset-2">
            Add one
          </Link>
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Move to</legend>
            {info.options.map((o) => (
              <OptionRow
                key={o.claude.id}
                option={o}
                selected={pick === o.claude.id}
                onPick={() => (setTouched(true), setPick(o.claude.id))}
                mark={<RecommendedMark advice={advice} claudeId={o.claude.id} />}
              />
            ))}
          </fieldset>
          <NoRecommendation advice={advice} />
          <SwitchRow
            className="rounded-none py-0"
            label={
              <span className="inline-flex items-center gap-1.5">
                Ask {from} for a handoff
                <InfoTip label="About the handoff">
                  {from} writes up the goal, state, decisions and next step for the new Claude, which starts from that and the conversation. It takes up to a minute and uses {from}’s own quota. Without it, the
                  new Claude gets the conversation as the portal stored it.
                </InfoTip>
              </span>
            }
            description={info.handoff.ok ? undefined : info.handoff.reason}
            checked={ask && info.handoff.ok}
            onChange={setAsk}
            disabled={!info.handoff.ok}
          />
          {warning && (
            <p className="flex items-center gap-2 text-[13px] text-amber-700 dark:text-amber-400">
              <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
              {warning}
            </p>
          )}
        </div>
      )}
    </FormDialog>
  );
}

/** One Claude as a radio row: ready, or why it can't take the chat now, with the way out in a note. */
function OptionRow({ option: o, selected, onPick, mark }: { option: ChatSwitchOption; selected: boolean; onPick: () => void; mark?: ReactNode }) {
  const id = useId();
  const change = modelChange(o);
  const fix: ReactNode =
    o.fix === 'sign_in' ? (
      <Link to="/admin/workspaces" className="font-semibold text-ink underline underline-offset-2">
        Sign in on Workspaces
      </Link>
    ) : o.fix === 'pool' ? (
      <Link to="/admin/accounts" className="font-semibold text-ink underline underline-offset-2">
        Accounts
      </Link>
    ) : o.fix === 'start_workspace' ? (
      <Link to="/admin/workspaces" className="font-semibold text-ink underline underline-offset-2">
        Workspaces
      </Link>
    ) : null;
  return (
    <div className={cn('flex items-center gap-3 rounded-2xl border px-3.5 py-3', selected ? 'border-primary bg-accent-soft/40' : 'border-line', !o.ok && 'bg-surface-2/60')}>
      <label htmlFor={id} className={cn('flex min-w-0 flex-1 items-center gap-3', o.ok ? 'cursor-pointer' : 'cursor-not-allowed')}>
        <input id={id} type="radio" name="claude" className="size-4 shrink-0 accent-[var(--color-primary)]" checked={selected} disabled={!o.ok} onChange={onPick} />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-[14.5px] font-semibold', !o.ok && 'text-muted')}>{o.claude.name}</span>
          {/* What the destination has left, so a chat isn't moved onto a Claude that is nearly out. */}
          {o.ok && <ClaudeHeadroom claudeId={o.claude.id} className="mt-0.5" />}
          {/* T-109: a Claude without the chat's model says the model it would run on, before the move. */}
          {o.ok && change && <span className="mt-0.5 block text-[12.5px] font-medium [overflow-wrap:anywhere] text-amber-700 dark:text-amber-400">{change.text}</span>}
        </span>
        {o.ok && mark}
      </label>
      {!o.ok && (
        <>
          <Badge tone="warning">{o.fix === 'sign_in' ? 'Signed out' : o.fix === 'start_workspace' ? 'Unreachable' : 'Not ready'}</Badge>
          <InfoTip label={`Why ${o.claude.name} can’t take the chat`}>
            {o.reason} {fix}
          </InfoTip>
        </>
      )}
    </div>
  );
}

/**
 * Moving a chat from anywhere (its page, a row in the list): the dialog, and what happens after the confirm. The
 * move runs on the portal and shows in the chat; a refusal says why, and asks to trust the folder first when it must.
 */
export function useMoveChat(): { start: (session: ChatSession, preselect?: string) => void; element: ReactNode } {
  const toast = useToast();
  const [session, setSession] = useState<ChatSession | null>(null);
  const [open, setOpen] = useState(false);
  const [preselect, setPreselect] = useState<string | null>(null);
  const locate = useCallback(async () => ({ workspaceId: session!.workspaceId, folder: session!.cwd }), [session]);
  const trust = useFolderTrust(session?.id ?? '', locate);
  const confirm = (claudeId: string, handoff: 'ask' | 'skip', model?: string) => {
    if (!session) return;
    setOpen(false);
    const id = session.id;
    void trust
      .guard(async () => void (await chatApi.switch(id, { claudeId, handoff, ...(model ? { model } : {}) })))
      .catch((e: unknown) => {
        if (!isTrustDeclined(e)) toast(errorText(e, 'Couldn’t move the chat.'), 'error');
      });
  };
  return {
    start: (s, pre) => {
      setSession(s);
      setPreselect(pre ?? null);
      setOpen(true);
    },
    element: (
      <>
        <SwitchDialog session={session} open={open} onClose={() => setOpen(false)} onConfirm={confirm} preselect={preselect} />
        <TrustSheet trust={trust} />
      </>
    ),
  };
}
