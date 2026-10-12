import { Button, Dialog, FormDialog, Segmented, Select, TextField } from '@isnanme/ui';
import { PORTAL_TOKEN_LABEL_MAX, type CreatedPortalToken, type PortalScope } from '@portal/contracts';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorText } from '@/lib/api';
import { portalMcpApi } from './api';
import { DAYS, SCOPE_HELP, SCOPE_LABEL } from './labels';
import { CodeBlock, Disclosure } from './parts';

const SCOPES: PortalScope[] = ['read', 'operate', 'admin'];

/** Makes a token: a label, what it may do, how long it lives. */
export function NewTokenDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (t: CreatedPortalToken) => void }) {
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<PortalScope>('read');
  const [days, setDays] = useState('90');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    setLabel('');
    setScope('read');
    setDays('90');
    setError(null);
    setLabelError(undefined);
  }, [open]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    setLabelError(undefined);
    try {
      onCreated(await portalMcpApi.createToken({ label: label.trim(), scope, expiresInDays: Number(days) as 7 | 30 | 90 | 365 }));
    } catch (e) {
      const details = (e as { details?: { label?: string } }).details;
      if (details?.label) setLabelError(details.label);
      else setError(errorText(e, 'Couldn’t make the token.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog open={open} onClose={onClose} size="sm" title="New token" onSubmit={submit} submitLabel="Create" saving={saving} error={error} dirty={label.trim() !== ''}>
      <div className="flex flex-col gap-4">
        <TextField label="Label" placeholder="Claude Code, laptop" maxLength={PORTAL_TOKEN_LABEL_MAX} autoComplete="off" value={label} onChange={(e) => (setLabel(e.target.value), setLabelError(undefined))} error={labelError} />
        <div className="flex flex-col gap-1.5">
          <Segmented<PortalScope> label="Scope" value={scope} onChange={setScope} options={SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s] }))} />
          <p className="text-[13px] text-muted">{SCOPE_HELP[scope]}</p>
        </div>
        <Select label="Expires" value={days} onChange={setDays} options={DAYS.map((d) => ({ value: String(d), label: `${d} days` }))} />
      </div>
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
