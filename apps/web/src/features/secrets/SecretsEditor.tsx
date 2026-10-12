import { Badge, Button, cn, Switch, SwitchRow, TextField } from '@isnanme/ui';
import {
  CLAUDE_CREDENTIAL_MESSAGE,
  SECRET_CREDENTIAL_LABEL,
  SECRET_VARIABLE_NAME,
  blankInRemoteMcp,
  hasClaudeCredential,
  secretCredentialType,
  secretFilePath,
  secretVariableReserved,
  type SecretEntryInput,
  type SecretOptions,
  type SecretsContent,
  type SecretsContentInput,
} from '@portal/contracts';
import { ChevronDown, FileKey2, History, Plus, RefreshCw, ShieldAlert, Trash2, TriangleAlert, Variable } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PoolContentEditorProps } from '@/features/pools/types';
import { RotateDialog } from './RotateDialog';
import { SecretValueField } from './SecretValueField';
import { VersionsDialog } from './VersionsDialog';

type Entry = SecretEntryInput & { id: string };

/** New entries get a temporary ID for React; the portal gives them a real one when the set is saved. */
const tempId = () => `new-${Math.random().toString(36).slice(2, 10)}`;

/** The browser sends secrets in the clear unless the page is on HTTPS or this machine (PRD §13). */
const insecure = () => typeof location !== 'undefined' && location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/**
 * A secret set's entries (FR2): plain variables, and secrets with a write-only value, each a file in
 * `/etc/claudepilot/secrets/files/`. The same checks as the portal run as you type: reserved names (FR4),
 * Claude credentials (FR5), credential-looking variables (FR6), and names remote MCP servers can't use (FR24).
 */
export function SecretsEditor({ value, onChange, errors, pool, disabled, reload, dirty }: PoolContentEditorProps<SecretsContentInput>) {
  const entries = value.entries as Entry[];
  // A field edited since the last save hides that save's error for it.
  const [edited, setEdited] = useState<Set<string>>(new Set());
  useEffect(() => setEdited(new Set()), [errors]);
  const error = (i: number, field: string) => (edited.has(`${i}.${field}`) ? undefined : errors[`entries.${i}.${field}`]);

  const update = (i: number, patch: Partial<Entry>, field?: string) => {
    if (field) setEdited((s) => new Set(s).add(`${i}.${field}`));
    onChange({ entries: entries.map((e, j) => (j === i ? { ...e, ...patch } : e)) });
  };
  const remove = (i: number) => onChange({ entries: entries.filter((_, j) => j !== i) });
  const add = (kind: Entry['kind']) =>
    onChange({ entries: [...entries, kind === 'variable' ? { id: tempId(), kind, name: '', value: '' } : { id: tempId(), kind, name: '', options: {} }] });

  // Secrets with a stored value that this edit removes (FR20: removing isn't revoking).
  const removed = useMemo(() => {
    const now = new Set(entries.map((e) => e.id));
    return ((pool?.content as SecretsContent | undefined)?.entries ?? []).filter((e) => e.kind === 'secret' && e.secret && !now.has(e.id)).length;
  }, [entries, pool]);

  const indexed = entries.map((e, i) => [e, i] as const);
  const variables = indexed.filter(([e]) => e.kind === 'variable');
  const secrets = indexed.filter(([e]) => e.kind === 'secret');

  return (
    <div className="flex flex-col gap-5">
      {insecure() && (
        <Note tone="danger" icon={<ShieldAlert className="size-4 shrink-0" />}>
          This page isn’t served over HTTPS, so secrets you type here cross the network unencrypted.
        </Note>
      )}
      <Group icon={<Variable className="size-4" />} title="Variables" description="Visible to anyone with portal access." empty={variables.length === 0}>
        {variables.map(([e, i]) => (
          <VariableRow
            key={e.id}
            entry={e}
            nameError={error(i, 'name')}
            valueError={error(i, 'value')}
            disabled={disabled}
            onChange={(patch, field) => update(i, patch, field)}
            onRemove={() => remove(i)}
            onMakeSecret={() => update(i, { kind: 'secret', newValue: e.value ?? '', value: undefined, confirmed: undefined, options: {} }, 'value')}
          />
        ))}
      </Group>
      <Group
        icon={<FileKey2 className="size-4" />}
        title="Secrets"
        description="Encrypted, never shown again. Delivered as files."
        empty={secrets.length === 0}
      >
        {secrets.map(([e, i]) => (
          <SecretRow
            key={e.id}
            entry={e}
            poolId={pool?.id ?? null}
            dirty={!!dirty}
            reload={reload}
            error={(f) => error(i, f)}
            disabled={disabled}
            onChange={(patch, field) => update(i, patch, field)}
            onRemove={() => remove(i)}
          />
        ))}
      </Group>
      {errors.entries && <p className="text-[13px] font-medium text-danger">{errors.entries}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => add('variable')} disabled={disabled}>
          Add variable
        </Button>
        <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => add('secret')} disabled={disabled}>
          Add secret
        </Button>
      </div>
      {removed > 0 && (
        <Note tone="warning" icon={<TriangleAlert className="size-4 shrink-0" />}>
          Removing is not revoking: processes, transcripts and home-folder copies may still hold {removed === 1 ? 'this value' : 'these values'}. Revoke{' '}
          {removed === 1 ? 'it' : 'them'} at the provider.
        </Note>
      )}
    </div>
  );
}

function Group({ icon, title, description, empty, children }: { icon: ReactNode; title: string; description: string; empty: boolean; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <span className="text-muted">{icon}</span>
          {title}
        </h3>
        <p className="text-[13px] text-muted">{description}</p>
      </div>
      {empty ? <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">None yet.</p> : <ul className="flex flex-col gap-2">{children}</ul>}
    </section>
  );
}

function Note({ tone, icon, children }: { tone: 'warning' | 'danger' | 'neutral'; icon?: ReactNode; children: ReactNode }) {
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-xl px-3 py-2 text-[13px]',
        tone === 'danger' ? 'bg-danger-soft text-danger' : tone === 'warning' ? 'bg-flame-soft text-ink-soft' : 'bg-surface-2 text-muted',
      )}
    >
      {icon && <span className="mt-0.5">{icon}</span>}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Why a variable name won't do, as you type: the portal's answer wins once you save. */
function nameProblem(name: string): string | undefined {
  if (!name || !SECRET_VARIABLE_NAME.test(name)) return undefined;
  const why = secretVariableReserved(name);
  return why ? `${name} is reserved. ${why}` : undefined;
}

const remoteNote = (name: string) =>
  name && blankInRemoteMcp(name) ? (
    <p className="text-[12.5px] text-muted">
      Claude Code reads <code className="font-mono">${'{'}{name}{'}'}</code> as empty in remote MCP URLs and headers; an MCP set uses it as a secret file instead.
    </p>
  ) : null;

function VariableRow({
  entry,
  nameError,
  valueError,
  disabled,
  onChange,
  onRemove,
  onMakeSecret,
}: {
  entry: Entry;
  nameError?: string;
  valueError?: string;
  disabled: boolean;
  onChange: (patch: Partial<Entry>, field: string) => void;
  onRemove: () => void;
  onMakeSecret: () => void;
}) {
  const value = entry.value ?? '';
  const claude = !!value && hasClaudeCredential(value);
  const looks = value && !claude ? secretCredentialType(value) : null;
  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-line px-3.5 py-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:items-start">
        <TextField
          label="Name"
          placeholder="REGION"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={128}
          className="[&_input]:font-mono"
          value={entry.name}
          onChange={(e) => onChange({ name: e.target.value.trim() }, 'name')}
          error={nameError ?? nameProblem(entry.name)}
          disabled={disabled}
        />
        <TextField
          label="Value"
          autoComplete="off"
          spellCheck={false}
          value={value}
          // A changed value needs its own confirmation (FR6).
          onChange={(e) => onChange({ value: e.target.value, confirmed: undefined }, 'value')}
          error={claude ? CLAUDE_CREDENTIAL_MESSAGE : looks && entry.confirmed ? undefined : valueError}
          disabled={disabled}
        />
        <Button variant="ghost" size="icon" aria-label={`Remove ${entry.name || 'this variable'}`} icon={<Trash2 className="size-4" />} onClick={onRemove} disabled={disabled} className="justify-self-end sm:mt-6" />
      </div>
      {looks && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-flame-soft px-3 py-2 text-[13px] text-ink-soft">
          <span className="flex min-w-0 flex-1 items-start gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>Looks like a {SECRET_CREDENTIAL_LABEL[looks]}. A variable is shown to anyone who can open the portal.</span>
          </span>
          <Button size="sm" variant="secondary" onClick={onMakeSecret} disabled={disabled}>
            Make it a secret
          </Button>
          <span className="flex items-center gap-2">
            <Switch checked={!!entry.confirmed} onChange={(c) => onChange({ confirmed: c || undefined }, 'value')} label="Keep as a variable" disabled={disabled} />
            <span aria-hidden>Keep as a variable</span>
          </span>
        </div>
      )}
      {remoteNote(entry.name)}
    </li>
  );
}

function SecretRow({
  entry,
  poolId,
  dirty,
  reload,
  error,
  disabled,
  onChange,
  onRemove,
}: {
  entry: Entry;
  /** The saved set this entry is in; null for a set not saved yet. */
  poolId: string | null;
  dirty: boolean;
  reload?: () => void;
  error: (field: string) => string | undefined;
  disabled: boolean;
  onChange: (patch: Partial<Entry>, field: string) => void;
  onRemove: () => void;
}) {
  const [dialog, setDialog] = useState<'rotate' | 'versions' | null>(null);
  // A saved secret with a value can be rotated and its versions seen; both act on the saved set, so not over unsaved edits.
  const saved = !!poolId && !!entry.secret?.stored && !entry.id.startsWith('new-');
  const o: SecretOptions = entry.options ?? {};
  const [open, setOpen] = useState(() => !!(o.pathVariable || o.expose || o.ownerOnly));
  const setOption = (patch: Partial<SecretOptions>) => onChange({ options: { ...o, ...patch } }, Object.keys(patch)[0] ?? 'options');
  const newValue = entry.newValue ?? '';
  const claude = !!newValue && hasClaudeCredential(newValue);
  const summary = [o.pathVariable && `path in ${o.pathVariable}`, o.expose && (o.terminals ? 'variable, terminals too' : 'also a variable'), o.ownerOnly && 'owner-only'].filter(Boolean).join(' · ');
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-line px-3.5 py-3">
      <div className="flex items-start gap-3">
        <TextField
          label="Name"
          placeholder="LINEAR_API_KEY"
          hint={
            <>
              Delivered as <code className="font-mono">{secretFilePath(entry.name || 'NAME')}</code>
            </>
          }
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={64}
          className="min-w-0 flex-1 [&_input]:font-mono"
          value={entry.name}
          onChange={(e) => onChange({ name: e.target.value.trim() }, 'name')}
          error={error('name') ?? (o.expose ? nameProblem(entry.name) : undefined)}
          disabled={disabled}
        />
        {!entry.secret && !newValue && (
          <Badge tone="warning" className="mt-7 shrink-0">
            Needs value
          </Badge>
        )}
        <Button variant="ghost" size="icon" aria-label={`Remove ${entry.name || 'this secret'}`} icon={<Trash2 className="size-4" />} onClick={onRemove} disabled={disabled} className="mt-6 shrink-0" />
      </div>
      <SecretValueField
        label="Value"
        info={entry.secret ?? null}
        value={newValue}
        onChange={(v) => onChange({ newValue: v }, 'newValue')}
        error={claude ? CLAUDE_CREDENTIAL_MESSAGE : error('newValue')}
        disabled={disabled}
      />
      {saved && (
        <div className="flex items-center gap-1 self-start">
          <Button variant="ghost" size="sm" icon={<RefreshCw className="size-4" />} onClick={() => setDialog('rotate')} disabled={disabled || dirty} title={dirty ? 'Save your changes first' : undefined}>
            Rotate
          </Button>
          <Button variant="ghost" size="sm" icon={<History className="size-4" />} onClick={() => setDialog('versions')} disabled={disabled || dirty} title={dirty ? 'Save your changes first' : undefined}>
            Versions
          </Button>
        </div>
      )}
      {saved && poolId && (
        <>
          <RotateDialog
            open={dialog === 'rotate'}
            poolId={poolId}
            entry={{ id: entry.id, name: entry.name }}
            onClose={() => setDialog(null)}
            onDone={() => {
              setDialog(null);
              reload?.();
            }}
          />
          <VersionsDialog open={dialog === 'versions'} poolId={poolId} entry={{ id: entry.id, name: entry.name }} onClose={() => setDialog(null)} />
        </>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        className="press flex items-center gap-2 self-start rounded-lg py-1 text-left text-[13px] font-semibold text-ink-soft"
      >
        Options
        {!open && summary && <span className="font-normal text-muted">{summary}</span>}
        <ChevronDown className={cn('size-4 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="flex flex-col gap-2">
          <TextField
            label="Path variable"
            optional
            placeholder={entry.name ? `${entry.name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_FILE` : 'TOKEN_FILE'}
            hint="The file’s path, for tools that take one."
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={128}
            className="[&_input]:font-mono"
            value={o.pathVariable ?? ''}
            onChange={(e) => setOption({ pathVariable: e.target.value.trim() || undefined })}
            error={error('pathVariable') ?? nameProblem(o.pathVariable ?? '')}
            disabled={disabled}
          />
          <SwitchRow
            label="Also expose as variable"
            description="Agents can print it with env. The file alone is safer."
            checked={!!o.expose}
            onChange={(c) => setOption({ expose: c || undefined, terminals: c ? o.terminals : undefined })}
            disabled={disabled}
          />
          {o.expose && (
            <SwitchRow
              label="Terminals need it"
              description="Also in terminal shells."
              checked={!!o.terminals}
              onChange={(c) => setOption({ terminals: c || undefined })}
              disabled={disabled}
            />
          )}
          <SwitchRow
            label="Owner-only"
            description="Mode 0400, owned by node (libpq and the like)."
            checked={!!o.ownerOnly}
            onChange={(c) => setOption({ ownerOnly: c || undefined })}
            disabled={disabled}
          />
          {o.expose && remoteNote(entry.name)}
        </div>
      )}
    </li>
  );
}
