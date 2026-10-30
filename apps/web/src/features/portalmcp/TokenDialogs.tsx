import { Button, Dialog, FormDialog, Segmented, Select, TextField } from '@isnanme/ui';
import {
  PORTAL_TOKEN_LABEL_IN_USE,
  PORTAL_TOKEN_LABEL_MAX,
  type CreatedPortalToken,
  type PortalAgentWorkspace,
  type PortalScope,
  type PortalToken,
  type PortalTokenLabelConflict,
  type PortalTokenLifetime,
} from '@portal/contracts';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { errorText } from '@/lib/api';
import { portalMcpApi } from './api';
import { LIFETIMES, SCOPE_HELP, SCOPE_LABEL } from './labels';
import { CodeBlock, Disclosure } from './parts';

const SCOPES: PortalScope[] = ['read', 'operate', 'admin'];

/** Makes a token: a label, what it may do, how long it lives. */
export function NewTokenDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (t: CreatedPortalToken) => void }) {
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<PortalScope>('read');
  const [life, setLife] = useState<PortalTokenLifetime>('90d');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | undefined>();
  /** The label has live tokens: replace them or add another (T-258). */
  const [inUse, setInUse] = useState<PortalTokenLabelConflict | null>(null);

  useEffect(() => {
    if (!open) return;
    setLabel('');
    setScope('read');
    setLife('90d');
    setError(null);
    setLabelError(undefined);
    setInUse(null);
  }, [open]);

  const submit = async (choice?: 'replace' | 'addAnother') => {
    setSaving(true);
    setError(null);
    setLabelError(undefined);
    try {
      onCreated(await portalMcpApi.createToken({ label: label.trim(), scope, expiresIn: life, ...(choice ? { [choice]: true } : {}) }));
    } catch (e) {
      const { code, details } = e as { code?: string; details?: { label?: unknown } };
      if (code === PORTAL_TOKEN_LABEL_IN_USE) setInUse(details as PortalTokenLabelConflict);
      else if (typeof details?.label === 'string' && !code?.startsWith('TOKEN_')) setLabelError(details.label);
      else setError(errorText(e, 'Couldn’t make the token.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog open={open} onClose={onClose} size="sm" title="New token" onSubmit={() => submit()} submitLabel="Create" saving={saving} error={error} dirty={label.trim() !== ''}>
      <div className="flex flex-col gap-4">
        <TextField
          label="Label"
          placeholder="Claude Code, laptop"
          suffix={<InfoTip label="About the label">The name shown everywhere this client acts: chats, tickets, CI and the audit. Required, one line.</InfoTip>}
          maxLength={PORTAL_TOKEN_LABEL_MAX}
          autoComplete="off"
          value={label}
          onChange={(e) => (setLabel(e.target.value), setLabelError(undefined), setInUse(null))}
          error={labelError}
        />
        {inUse && (
          <div role="alert" className="flex flex-col gap-2 rounded-xl bg-gold-soft px-3 py-2.5">
            <p className="text-[13px] font-semibold break-words text-ink-soft">
              {inUse.live} live with this label
              <InfoTip label="About labels">A label names one client. Replace revokes its live tokens; Add another keeps them (admin tokens up to the limit in Settings).</InfoTip>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="danger" disabled={saving} onClick={() => void submit('replace')}>
                Replace
              </Button>
              <Button size="sm" variant="secondary" disabled={saving} onClick={() => void submit('addAnother')}>
                Add another
              </Button>
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Segmented<PortalScope> label="Scope" value={scope} onChange={setScope} options={SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s] }))} />
          <p className="text-[13px] text-muted">{SCOPE_HELP[scope]}</p>
        </div>
        <Select
          label="Expires"
          value={life}
          onChange={(v) => setLife(v as PortalTokenLifetime)}
          options={LIFETIMES}
          hint={
            <span className="inline-flex items-center gap-1">
              Scripts: 1 hour
              <InfoTip label="About expiry">Automation should mint one token per run, valid 1 hour, and revoke it at the end. Long lifetimes are for a person’s own Claude Code.</InfoTip>
            </span>
          }
        />
      </div>
    </FormDialog>
  );
}

/** T-1105: where the token's tickets go when a call names no workspace. */
export function TokenWorkspaceDialog({ token, workspaces, onClose, onSaved }: { token: PortalToken | null; workspaces: PortalAgentWorkspace[] | null; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setValue(token.defaultWorkspaceId ?? '');
    setError(null);
  }, [token]);

  const known = workspaces ?? [];
  const current = token?.defaultWorkspaceId;
  // A default whose workspace is gone stays selectable, so it can be seen and cleared.
  const options = [
    { value: '', label: 'None' },
    ...known.map((w) => ({ value: w.workspaceId, label: w.name })),
    ...(current && !known.some((w) => w.workspaceId === current) ? [{ value: current, label: current }] : []),
  ];

  const submit = async () => {
    if (!token) return;
    setSaving(true);
    setError(null);
    try {
      await portalMcpApi.updateToken(token.id, { defaultWorkspaceId: value || null });
      onSaved();
    } catch (e) {
      setError(errorText(e, 'Couldn’t change it.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog open={!!token} onClose={onClose} size="sm" title="Workspace" onSubmit={() => submit()} submitLabel="Save" saving={saving} error={error} dirty={value !== (current ?? '')}>
      <Select
        label="Tickets go to"
        value={value}
        onChange={setValue}
        options={options}
        hint={
          <span className="inline-flex items-center gap-1">
            When a ticket names none
            <InfoTip label="About the workspace">Tickets this token makes without a workspace land here, so that workspace’s lead and crew can take them. None: the shared queue.</InfoTip>
          </span>
        }
      />
    </FormDialog>
  );
}

/** The secret, once, with the command that uses it. */
export function CreatedTokenDialog({ created, onClose }: { created: CreatedPortalToken | null; onClose: () => void }) {
  return (
    <Dialog open={!!created} onClose={onClose} title="Token created" footer={<Button onClick={onClose}>Done</Button>}>
      {created && (
        <div className="flex flex-col gap-4">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-ink-soft">
            <TriangleAlert className="size-4 shrink-0 text-gold" />
            Shown once. Copy it now.
          </p>
          <CodeBlock value={created.secret} secret label="Copy token" />
          <div>
            <p className="mb-1.5 text-[13px] font-semibold text-muted">Claude Code</p>
            <CodeBlock value={created.connect.claudeCode} label="Copy command" />
          </div>
          <Disclosure summary="Other ways">
            <div className="flex flex-col gap-3">
              <CodeBlock value={created.connect.claudeCodeHelper} label="Copy commands" />
              <CodeBlock value={created.connect.curl} label="Copy command" />
            </div>
          </Disclosure>
        </div>
      )}
    </Dialog>
  );
}
