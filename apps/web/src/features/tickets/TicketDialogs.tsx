import { FormDialog, Segmented, Select, Switch, TextArea, TextField } from '@isnanme/ui';
import {
  TICKET_LIMITS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABEL,
  TICKET_TYPES,
  TICKET_TYPE_LABEL,
  type CreateTicketRequest,
  type BumpMode,
  type StartTicketSessionResult,
  type TicketBumpResult,
  type TicketAssignee,
  type TicketItem,
  type TicketPriority,
  type TicketType,
  type Workspace,
} from '@portal/contracts';
import { useEffect, useState } from 'react';
import { BumpDialog } from '@/components/BumpDialog';
import { InfoTip } from '@/components/InfoTip';
import { chatApi } from '@/features/chat/api';
import { api, errorText } from '@/lib/api';
import { ticketsApi } from './api';
import { Disclosure, MONO } from '@/features/portalmcp/parts';

/** Field errors the server names (`details: { summary: '…' }`), and what is left over for the form. */
type Fields<K extends string> = Partial<Record<K, string>>;
function fieldErrors<K extends string>(e: unknown, keys: readonly K[]): { fields: Fields<K>; message: string | null } {
  const details = (e as { details?: Record<string, unknown> }).details;
  const fields: Fields<K> = {};
  let found = false;
  for (const k of keys) {
    const v = details?.[k];
    if (typeof v === 'string') ((fields[k] = v), (found = true));
  }
  return { fields, message: found ? null : errorText(e, 'That didn’t work.') };
}

const tagsOf = (raw: string) =>
  raw
    .split(/[,\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

/** Existing tags as quick picks under the tag field. */
function TagPicks({ value, onPick }: { value: string; onPick: (tag: string) => void }) {
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  useEffect(() => {
    let current = true;
    ticketsApi.tags().then(
      (t) => current && setTags(t.slice(0, 12)),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  const have = new Set(tagsOf(value));
  const picks = tags.filter((t) => !have.has(t.tag));
  if (!picks.length) return null;
  return (
    <div className="-mt-2 flex flex-wrap gap-1.5">
      {picks.map((t) => (
        <button
          key={t.tag}
          type="button"
          onClick={() => onPick(t.tag)}
          className="press rounded-md bg-surface-2 px-2 py-1 text-[12px] font-medium text-ink-soft hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
        >
          + {t.tag}
        </button>
      ))}
    </div>
  );
}

const NO_WORKSPACE = '';

/** Makes a ticket (tickets PRD §13): what it is, how urgent, and who takes it. */
export function NewTicketDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (t: TicketItem) => void }) {
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<TicketType>('task');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [tags, setTags] = useState('');
  const [mine, setMine] = useState<'queue' | 'me'>('queue');
  const [workspaceId, setWorkspaceId] = useState(NO_WORKSPACE);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Fields<'summary' | 'description' | 'tags'>>({});

  useEffect(() => {
    if (!open) return;
    setSummary('');
    setDescription('');
    setType('task');
    setPriority('normal');
    setTags('');
    setMine('queue');
    setWorkspaceId(NO_WORKSPACE);
    setError(null);
    setErrors({});
    let current = true;
    api.workspaces.list().then(
      (list) => current && setWorkspaces(list),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [open]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    setErrors({});
    try {
      const body: CreateTicketRequest = {
        summary: summary.trim(),
        description,
        type,
        priority,
        tags: tagsOf(tags),
        assignee: mine === 'me' ? ({ kind: 'user', name: '' } satisfies TicketAssignee) : null,
        workspaceId: workspaceId || null,
      };
      onCreated(await ticketsApi.create(body));
    } catch (e) {
      const { fields, message } = fieldErrors(e, ['summary', 'description', 'tags'] as const);
      setErrors(fields);
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="New ticket"
      onSubmit={submit}
      submitLabel="Create"
      saving={saving}
      error={error}
      dirty={!!summary.trim() || !!description.trim()}
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="Summary"
          placeholder="Fix the login redirect"
          maxLength={TICKET_LIMITS.summary}
          autoComplete="off"
          value={summary}
          onChange={(e) => (setSummary(e.target.value), setErrors((x) => ({ ...x, summary: undefined })))}
          error={errors.summary}
        />
        <TextArea
          label="Description"
          optional
          rows={5}
          maxLength={TICKET_LIMITS.description}
          value={description}
          onChange={(e) => (setDescription(e.target.value), setErrors((x) => ({ ...x, description: undefined })))}
          error={errors.description}
          hint="No keys or passwords."
        />
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Type"
            value={type}
            onChange={(v) => setType(v as TicketType)}
            options={TICKET_TYPES.map((t) => ({ value: t, label: TICKET_TYPE_LABEL[t] }))}
          />
          <Select
            label="Priority"
            value={priority}
            onChange={(v) => setPriority(v as TicketPriority)}
            options={TICKET_PRIORITIES.map((p) => ({ value: p, label: TICKET_PRIORITY_LABEL[p] }))}
          />
        </div>
        <TextField
          label="Tags"
          optional
          placeholder="frontend, login"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={tags}
          onChange={(e) => (setTags(e.target.value), setErrors((x) => ({ ...x, tags: undefined })))}
          error={errors.tags}
        />
        <TagPicks value={tags} onPick={(t) => setTags((v) => `${v.trim()}${v.trim() ? ', ' : ''}${t}`)} />
        <Segmented<'queue' | 'me'>
          label="Assign to"
          value={mine}
          onChange={setMine}
          options={[
            { value: 'queue', label: 'Unassigned' },
            { value: 'me', label: 'Me' },
          ]}
        />
        <Select
          label="Workspace"
          optional
          value={workspaceId}
          onChange={setWorkspaceId}
          options={[{ value: NO_WORKSPACE, label: 'Any' }, ...workspaces.map((w) => ({ value: w.id, label: w.id }))]}
        />
      </div>
    </FormDialog>
  );
}

/** Retitles a ticket and rewrites its description. */
export function EditTicketDialog({
  ticket,
  onClose,
  onSaved,
}: {
  ticket: TicketItem | null;
  onClose: () => void;
  onSaved: (t: TicketItem) => void;
}) {
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Fields<'summary' | 'description'>>({});
  useEffect(() => {
    if (!ticket) return;
    setSummary(ticket.summary);
    setDescription(ticket.description);
    setError(null);
    setErrors({});
  }, [ticket]);
  const submit = async () => {
    if (!ticket) return;
    setSaving(true);
    setError(null);
    setErrors({});
    try {
      onSaved(await ticketsApi.update(ticket.id, { summary: summary.trim(), description }));
    } catch (e) {
      const { fields, message } = fieldErrors(e, ['summary', 'description'] as const);
      setErrors(fields);
      setError(message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <FormDialog
      open={!!ticket}
      onClose={onClose}
      title={ticket ? `Edit ${ticket.id}` : 'Edit ticket'}
      onSubmit={submit}
      saving={saving}
      error={error}
      dirty={!!ticket && (summary.trim() !== ticket.summary || description !== ticket.description)}
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="Summary"
          maxLength={TICKET_LIMITS.summary}
          autoComplete="off"
          value={summary}
          onChange={(e) => (setSummary(e.target.value), setErrors((x) => ({ ...x, summary: undefined })))}
          error={errors.summary}
        />
        <TextArea
          label="Description"
          rows={8}
          maxLength={TICKET_LIMITS.description}
          value={description}
          onChange={(e) => (setDescription(e.target.value), setErrors((x) => ({ ...x, description: undefined })))}
          error={errors.description}
        />
      </div>
    </FormDialog>
  );
}

/** Tags, as one comma-separated field with the ones already in use as quick picks. */
export function TagsDialog({
  ticket,
  onClose,
  onSaved,
}: {
  ticket: TicketItem | null;
  onClose: () => void;
  onSaved: (t: TicketItem) => void;
}) {
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ticket) return;
    setTags(ticket.tags.join(', '));
    setError(null);
  }, [ticket]);
  const submit = async () => {
    if (!ticket) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await ticketsApi.update(ticket.id, { tags: tagsOf(tags) }));
    } catch (e) {
      setError(fieldErrors(e, ['tags'] as const).fields.tags ?? errorText(e, 'Couldn’t save the tags.'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <FormDialog open={!!ticket} onClose={onClose} size="sm" title="Tags" onSubmit={submit} saving={saving} error={error}>
      <div className="flex flex-col gap-4">
        <TextField
          label="Tags"
          placeholder="frontend, login"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <TagPicks value={tags} onPick={(t) => setTags((v) => `${v.trim()}${v.trim() ? ', ' : ''}${t}`)} />
      </div>
    </FormDialog>
  );
}

type Who = 'queue' | 'user' | 'session';

/** Who has the ticket: nobody (the agents' queue), a person, or a live session. */
export function AssignDialog({
  ticket,
  onClose,
  onSaved,
}: {
  ticket: TicketItem | null;
  onClose: () => void;
  onSaved: (t: TicketItem) => void;
}) {
  const [who, setWho] = useState<Who>('queue');
  const [name, setName] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [sessions, setSessions] = useState<{ id: string; title: string; workspaceId: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ticket) return;
    setWho(ticket.assignee?.kind ?? 'queue');
    setName(ticket.assignee?.kind === 'user' ? ticket.assignee.name : 'admin');
    setSessionId(ticket.assignee?.kind === 'session' ? ticket.assignee.sessionId : '');
    setError(null);
    let current = true;
    chatApi.listAll().then(
      (list) =>
        current &&
        setSessions(
          list.filter((s) => s.state !== 'ended' && !s.archivedAt).map((s) => ({ id: s.id, title: s.title, workspaceId: s.workspaceId })),
        ),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [ticket]);
  const submit = async () => {
    if (!ticket) return;
    setSaving(true);
    setError(null);
    try {
      const assignee: TicketAssignee | null =
        who === 'queue' ? null : who === 'user' ? { kind: 'user', name: name.trim() || 'admin' } : { kind: 'session', sessionId };
      if (who === 'session' && !sessionId) return setError('Pick a session.');
      onSaved(await ticketsApi.update(ticket.id, { assignee }));
    } catch (e) {
      setError(fieldErrors(e, ['assignee'] as const).fields.assignee ?? errorText(e, 'Couldn’t assign it.'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <FormDialog
      open={!!ticket}
      onClose={onClose}
      size="sm"
      title="Assign"
      description={ticket ? ticket.id : undefined}
      onSubmit={submit}
      saving={saving}
      error={error}
    >
      <div className="flex flex-col gap-4">
        <Segmented<Who>
          label="Assign to"
          value={who}
          onChange={setWho}
          options={[
            { value: 'queue', label: 'Unassigned' },
            { value: 'user', label: 'Person' },
            { value: 'session', label: 'Session' },
          ]}
        />
        {who === 'user' && <TextField label="Name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />}
        {who === 'session' && (
          <Select
            label="Session"
            value={sessionId}
            onChange={setSessionId}
            placeholder={sessions.length ? 'Pick a session' : 'No running sessions'}
            options={sessions.map((s) => ({ value: s.id, label: `${s.title} · ${s.workspaceId}` }))}
          />
        )}
      </div>
    </FormDialog>
  );
}

/** Closes a ticket with a short summary of what came of it (tickets PRD FR6). */
export function CloseDialog({
  ticket,
  onClose,
  onClosed,
}: {
  ticket: TicketItem | null;
  onClose: () => void;
  onClosed: (t: TicketItem) => void;
}) {
  const [outcome, setOutcome] = useState<'done' | 'wont_do'>('done');
  const [summary, setSummary] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ticket) return;
    setOutcome('done');
    setSummary('');
    setError(null);
  }, [ticket]);
  const submit = async () => {
    if (!ticket) return;
    setSaving(true);
    setError(null);
    try {
      onClosed(await ticketsApi.close(ticket.id, { outcome, summary: summary.trim() || undefined }));
    } catch (e) {
      setError(fieldErrors(e, ['summary'] as const).fields.summary ?? errorText(e, 'Couldn’t close it.'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <FormDialog
      open={!!ticket}
      onClose={onClose}
      size="sm"
      title={ticket ? `Close ${ticket.id}` : 'Close ticket'}
      onSubmit={submit}
      submitLabel="Close ticket"
      saving={saving}
      error={error}
      dirty={!!summary.trim()}
    >
      <div className="flex flex-col gap-4">
        <Segmented<'done' | 'wont_do'>
          label="Outcome"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'done', label: 'Done' },
            { value: 'wont_do', label: 'Won’t do' },
          ]}
        />
        <TextArea
          label="What came of it"
          optional
          rows={4}
          maxLength={TICKET_LIMITS.closing}
          placeholder="What was done, or why not."
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>
    </FormDialog>
  );
}

/** Starts a session for a ticket (tickets PRD FR15): where, as which Claude, whether in a worktree, and exactly what it is told. */
export function StartSessionDialog({
  ticket,
  onClose,
  onStarted,
}: {
  ticket: TicketItem | null;
  onClose: () => void;
  onStarted: (r: StartTicketSessionResult) => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [claudes, setClaudes] = useState<{ id: string; name: string }[]>([]);
  const [claudeId, setClaudeId] = useState('');
  const [worktree, setWorktree] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticket) return;
    setError(null);
    setWorktree(false);
    setClaudeId('');
    setOpening(null);
    let current = true;
    api.workspaces.list().then(
      (list) => {
        if (!current) return;
        const running = list.filter((w) => w.status === 'running');
        setWorkspaces(running);
        setWorkspaceId(running.find((w) => w.id === ticket.workspaceId)?.id ?? running[0]?.id ?? '');
      },
      () => current && setWorkspaces([]),
    );
    ticketsApi.opening(ticket.id).then(
      (r) => current && setOpening(r.text),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [ticket]);

  useEffect(() => {
    if (!workspaceId) return setClaudes([]);
    let current = true;
    chatApi.claudes(workspaceId).then(
      (list) => current && (setClaudes(list.filter((c) => !c.removedAt).map((c) => ({ id: c.id, name: c.name }))), setClaudeId('')),
      () => current && setClaudes([]),
    );
    return () => {
      current = false;
    };
  }, [workspaceId]);

  const submit = async () => {
    if (!ticket) return;
    setSaving(true);
    setError(null);
    try {
      onStarted(
        await ticketsApi.startSession(ticket.id, { workspaceId, claudeId: claudeId || undefined, worktree: worktree || undefined }),
      );
    } catch (e) {
      const code = (e as { code?: string }).code;
      const details = (e as { details?: { folder?: string } }).details;
      setError(
        code === 'FOLDER_UNTRUSTED'
          ? `${details?.folder ? `${details.folder} isn’t` : 'That folder isn’t'} trusted yet. Start a session there from Sessions once.`
          : errorText(e, 'Couldn’t start the session.'),
      );
    } finally {
      setSaving(false);
    }
  };

  const fromAgent = ticket?.source === 'agent';
  return (
    <FormDialog
      open={!!ticket}
      onClose={onClose}
      title="Start a session"
      description={ticket ? `${ticket.id} · ${ticket.summary}` : undefined}
      onSubmit={submit}
      submitLabel="Start session"
      submitDisabled={!workspaceId}
      saving={saving}
      error={error}
    >
      <div className="flex flex-col gap-4">
        {fromAgent && (
          <p className="rounded-xl bg-gold-soft px-3 py-2 text-[13px] text-ink-soft">Written by an agent: check the opening message.</p>
        )}
        <Select
          label="Workspace"
          value={workspaceId}
          onChange={setWorkspaceId}
          placeholder={workspaces === null ? 'Loading…' : workspaces.length ? undefined : 'No running workspace'}
          options={(workspaces ?? []).map((w) => ({ value: w.id, label: w.id }))}
        />
        {claudes.length > 1 && (
          <Select
            label="Claude"
            value={claudeId}
            onChange={setClaudeId}
            options={[{ value: '', label: 'Default' }, ...claudes.map((c) => ({ value: c.id, label: c.name }))]}
          />
        )}
        <div className="flex items-center gap-3">
          <p className="flex min-w-0 flex-1 items-center gap-1 text-sm font-semibold">
            Own git worktree
            <InfoTip label="About worktrees">The session gets its own branch, so other work isn’t touched.</InfoTip>
          </p>
          <Switch label="Own git worktree" checked={worktree} onChange={setWorktree} />
        </div>
        <Disclosure summary="Opening message">
          <pre className="max-h-64 overflow-auto text-[12.5px] leading-relaxed whitespace-pre-wrap" style={{ fontFamily: MONO }}>
            {opening ?? 'Loading…'}
          </pre>
        </Disclosure>
      </div>
    </FormDialog>
  );
}

/** The two ways, in the dialog's one ⓘ (tickets PRD FR28). */
const BUMP_HELP: Record<BumpMode, string> = {
  prioritise: 'the session takes it as its next work. It is assigned to that session and set in progress.',
  ask: 'a question. The session answers in a comment here; the ticket stays as it is.',
};

/** Bump (FR28): the shared Bump dialog over this ticket's sessions; its assigned session comes first. */
export function TicketBumpDialog({
  ticket,
  onClose,
  onBumped,
}: {
  ticket: TicketItem | null;
  onClose: () => void;
  onBumped: (r: TicketBumpResult) => void;
}) {
  const id = ticket?.id ?? '';
  return (
    <BumpDialog
      open={!!ticket}
      onClose={onClose}
      subject={ticket ? `${ticket.id} · ${ticket.summary}` : undefined}
      modeHelp={BUMP_HELP}
      load={() => ticketsApi.bumpTargets(id)}
      onBump={async (req) => onBumped(await ticketsApi.bump(id, req))}
    />
  );
}
