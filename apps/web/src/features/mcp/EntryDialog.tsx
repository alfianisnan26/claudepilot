import { Button, FormDialog, Segmented, Select, SwitchRow, TextArea, TextField } from '@isnanme/ui';
import type { McpCatalogEntry, McpCatalogVersion, McpEntryKind, McpSlotInput, McpSlotTarget, McpVersionSpec } from '@portal/contracts';
import { MCP_SERVER_KEY_MAX } from '@portal/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, errorText } from '@/lib/api';
import { mcpApi } from './api';

interface SlotDraft {
  name: string;
  target: McpSlotTarget;
  secret: boolean;
  required: boolean;
  description: string;
  default: string;
  template: string;
}

interface Draft {
  key: string;
  displayName: string;
  description: string;
  kind: McpEntryKind;
  version: string;
  package: string;
  bin: string;
  args: string;
  allowScripts: boolean;
  path: string;
  url: string;
  transport: 'http' | 'sse';
  auth: 'none' | 'headers' | 'oauth';
  clientId: string;
  callbackPort: string;
  scopes: string;
  allowPrivateNetwork: boolean;
  slots: SlotDraft[];
}

const EMPTY: Draft = {
  key: '',
  displayName: '',
  description: '',
  kind: 'npm',
  version: '',
  package: '',
  bin: '',
  args: '',
  allowScripts: false,
  path: '',
  url: '',
  transport: 'http',
  auth: 'none',
  clientId: '',
  callbackPort: '',
  scopes: '',
  allowPrivateNetwork: false,
  slots: [],
};

function fromVersion(entry: McpCatalogEntry, v: McpCatalogVersion | undefined): Draft {
  const s = v?.spec ?? {};
  return {
    ...EMPTY,
    key: entry.key,
    displayName: entry.displayName,
    description: entry.description,
    kind: entry.kind,
    version: v && entry.kind === 'npm' ? v.version : '',
    package: s.package ?? '',
    bin: s.bin ?? '',
    args: (s.args ?? []).join('\n'),
    allowScripts: !!s.allowScripts,
    path: s.path ?? '',
    url: s.url ?? '',
    transport: s.transport ?? 'http',
    auth: s.auth ?? 'none',
    clientId: s.oauth?.clientId ?? '',
    callbackPort: s.oauth?.callbackPort ? String(s.oauth.callbackPort) : '',
    scopes: (s.oauth?.scopes ?? []).join(' '),
    allowPrivateNetwork: !!s.allowPrivateNetwork,
    slots: (v?.slots ?? []).map((x) => ({
      name: x.name,
      target: x.target,
      secret: x.secret,
      required: x.required,
      description: x.description ?? '',
      default: x.default ?? '',
      template: x.template ?? '',
    })),
  };
}

function toSpec(d: Draft): McpVersionSpec {
  const args = d.args
    .split('\n')
    .map((a) => a.trim())
    .filter(Boolean);
  if (d.kind === 'npm') return { package: d.package.trim(), ...(d.bin.trim() ? { bin: d.bin.trim() } : {}), args, ...(d.allowScripts ? { allowScripts: true } : {}) };
  if (d.kind === 'command') return { path: d.path.trim(), args };
  return {
    url: d.url.trim(),
    transport: d.transport,
    auth: d.auth,
    ...(d.auth === 'oauth'
      ? {
          oauth: {
            ...(d.clientId.trim() ? { clientId: d.clientId.trim() } : {}),
            ...(d.callbackPort.trim() ? { callbackPort: Number(d.callbackPort) } : {}),
            ...(d.scopes.trim() ? { scopes: d.scopes.trim().split(/\s+/) } : {}),
          },
        }
      : {}),
    ...(d.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
  };
}

const toSlots = (d: Draft): McpSlotInput[] =>
  d.slots.map((s) => ({
    name: s.name.trim(),
    target: d.kind === 'remote' ? 'header' : s.target,
    secret: s.target === 'path' || s.secret,
    required: s.required,
    ...(s.description.trim() ? { description: s.description.trim() } : {}),
    ...(!s.secret && s.default.trim() ? { default: s.default } : {}),
    ...(d.kind === 'remote' && s.template.trim() ? { template: s.template.trim() } : {}),
  }));

export type EntryDialogMode = { kind: 'create' } | { kind: 'version'; entry: McpCatalogEntry } | { kind: 'draft'; entry: McpCatalogEntry; version: McpCatalogVersion };

/**
 * "Add manually" (US1), a new version of an entry, or changes to a draft. Saving makes a draft:
 * nothing reaches a workspace until someone reviews and approves it (FR3, FR4).
 */
export function EntryDialog({ mode, onClose, onSaved }: { mode: EntryDialogMode | null; onClose: () => void; onSaved: (entry: McpCatalogEntry) => void }) {
  const [d, setD] = useState<Draft>(EMPTY);
  const [initial, setInitial] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!mode) return;
    const start =
      mode.kind === 'create' ? EMPTY : mode.kind === 'draft' ? fromVersion(mode.entry, mode.version) : { ...fromVersion(mode.entry, mode.entry.versions[0]), version: '' };
    setD(start);
    setInitial(JSON.stringify(start));
    setErrors({});
    setError(null);
  }, [mode]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    setErrors(({ [k]: _, ...rest }) => rest);
  };
  const setSlot = (i: number, patch: Partial<SlotDraft>) => setD((x) => ({ ...x, slots: x.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const err = (...keys: string[]) => keys.map((k) => errors[k]).find(Boolean);
  const creating = mode?.kind === 'create';
  const remote = d.kind === 'remote';

  const submit = async () => {
    if (!mode) return;
    setSaving(true);
    setError(null);
    try {
      const body = { version: d.kind === 'npm' ? d.version.trim() : undefined, spec: toSpec(d), slots: toSlots(d) };
      const saved =
        mode.kind === 'create'
          ? await mcpApi.create({ key: d.key.trim(), displayName: d.displayName.trim(), description: d.description.trim(), kind: d.kind, ...body })
          : mode.kind === 'version'
            ? await mcpApi.addVersion(mode.entry.id, body)
            : await mcpApi.updateVersion(mode.entry.id, mode.version.id, body);
      onSaved(saved);
    } catch (e) {
      if (e instanceof ApiError && e.details && typeof e.details === 'object') setErrors(e.details as Record<string, string>);
      setError(errorText(e, 'Could not save it.'));
    } finally {
      setSaving(false);
    }
  };

  const title = !mode ? '' : mode.kind === 'create' ? 'Add a server' : mode.kind === 'version' ? `New version of ${mode.entry.displayName}` : `Edit ${mode.entry.displayName} ${mode.version.version}`;
  return (
    <FormDialog
      open={!!mode}
      onClose={onClose}
      title={title}
      description="Saved as a draft. Nothing reaches a workspace until it’s reviewed and approved."
      onSubmit={submit}
      submitLabel="Save draft"
      saving={saving}
      error={error}
      dirty={JSON.stringify(d) !== initial}
    >
      <div className="flex flex-col gap-4">
        {creating && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold text-ink-soft">Kind</span>
              <Segmented
                label="Kind"
                value={d.kind}
                onChange={(k) => set('kind', k)}
                options={[
                  { value: 'npm', label: 'npm package' },
                  { value: 'remote', label: 'Remote URL' },
                  { value: 'command', label: 'Command' },
                ]}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Name" value={d.displayName} onChange={(e) => set('displayName', e.target.value)} error={err('displayName')} autoComplete="off" maxLength={80} data-autofocus />
              <TextField
                label="Key"
                hint="Its name in sets and tool names: lowercase, digits, dashes."
                value={d.key}
                onChange={(e) => set('key', e.target.value.toLowerCase())}
                error={err('key')}
                autoComplete="off"
                maxLength={MCP_SERVER_KEY_MAX}
              />
            </div>
            <TextField label="Description" optional value={d.description} onChange={(e) => set('description', e.target.value)} error={err('description')} autoComplete="off" maxLength={500} />
          </>
        )}

        {d.kind === 'npm' && (
          <>
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <TextField label="Package" placeholder="@scope/server" value={d.package} onChange={(e) => set('package', e.target.value)} error={err('spec.package')} autoComplete="off" />
              <TextField label="Exact version" placeholder="1.4.2" value={d.version} onChange={(e) => set('version', e.target.value)} error={err('version')} autoComplete="off" />
            </div>
            <TextField label="Command" optional hint="When the package has more than one." value={d.bin} onChange={(e) => set('bin', e.target.value)} error={err('spec.bin')} autoComplete="off" />
          </>
        )}
        {d.kind === 'command' && (
          <TextField label="Path in the image" placeholder="/usr/local/bin/server" value={d.path} onChange={(e) => set('path', e.target.value)} error={err('spec.path')} autoComplete="off" />
        )}
        {(d.kind === 'npm' || d.kind === 'command') && (
          <TextArea label="Arguments" optional hint="One per line. Never secrets: arguments show in ps and logs." rows={2} value={d.args} onChange={(e) => set('args', e.target.value)} error={err('spec.args')} />
        )}
        {d.kind === 'npm' && (
          <SwitchRow label="Run install scripts" description="Off by default: install scripts run code at install time." checked={d.allowScripts} onChange={(v) => set('allowScripts', v)} />
        )}

        {remote && (
          <>
            <TextField label="URL" placeholder="https://mcp.example.com/mcp" value={d.url} onChange={(e) => set('url', e.target.value)} error={err('spec.url')} autoComplete="off" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Select label="Transport" value={d.transport} onChange={(v) => set('transport', v as Draft['transport'])} options={[{ value: 'http', label: 'Streamable HTTP' }, { value: 'sse', label: 'SSE (deprecated)' }]} />
              <Select
                label="Auth"
                value={d.auth}
                onChange={(v) => set('auth', v as Draft['auth'])}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'headers', label: 'Headers from secrets' },
                  { value: 'oauth', label: 'OAuth sign-in in the workspace' },
                ]}
              />
            </div>
            {d.auth === 'oauth' && (
              <div className="grid gap-4 sm:grid-cols-3">
                <TextField label="Client ID" optional value={d.clientId} onChange={(e) => set('clientId', e.target.value)} error={err('spec.oauth.clientId', 'spec.oauth')} autoComplete="off" />
                <TextField label="Callback port" optional inputMode="numeric" value={d.callbackPort} onChange={(e) => set('callbackPort', e.target.value)} error={err('spec.oauth.callbackPort')} autoComplete="off" />
                <TextField label="Scopes" optional value={d.scopes} onChange={(e) => set('scopes', e.target.value)} error={err('spec.oauth.scopes')} autoComplete="off" />
              </div>
            )}
            <SwitchRow label="Allow private network" description="Only for servers inside your network. Off refuses private addresses." checked={d.allowPrivateNetwork} onChange={(v) => set('allowPrivateNetwork', v)} />
          </>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-semibold text-ink-soft">{remote ? 'Headers' : 'Variables'}</span>
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-4" />}
              onClick={() => setD((x) => ({ ...x, slots: [...x.slots, { name: '', target: remote ? 'header' : 'env', secret: true, required: true, description: '', default: '', template: remote ? 'Bearer {value}' : '' }] }))}
            >
              Add
            </Button>
          </div>
          {err('slots') && <p className="text-[12.5px] text-danger">{err('slots')}</p>}
          {d.slots.length === 0 && <p className="text-[12.5px] text-muted">{remote ? 'No headers.' : 'No variables.'} Secrets are named per set; values stay in Secrets & env.</p>}
          {d.slots.map((s, i) => (
            <div key={i} className="flex flex-col gap-3 rounded-xl border border-line p-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <TextField
                  label={remote ? 'Header' : 'Name'}
                  value={s.name}
                  onChange={(e) => setSlot(i, { name: e.target.value })}
                  error={err(`slots.${i}.name`)}
                  autoComplete="off"
                  placeholder={remote ? 'Authorization' : 'API_KEY'}
                />
                {!remote && (
                  <Select
                    label="Gets"
                    value={s.target}
                    onChange={(v) => setSlot(i, { target: v as McpSlotTarget, ...(v === 'path' ? { secret: true } : {}) })}
                    options={[
                      { value: 'env', label: 'The value' },
                      { value: 'path', label: 'The secret file’s path' },
                    ]}
                  />
                )}
              </div>
              {remote && s.secret && (
                <TextField label="Value" hint="{value} is replaced by the secret." value={s.template} onChange={(e) => setSlot(i, { template: e.target.value })} error={err(`slots.${i}.template`)} autoComplete="off" />
              )}
              {!s.secret && (
                <TextField label="Default" optional value={s.default} onChange={(e) => setSlot(i, { default: e.target.value })} error={err(`slots.${i}.default`)} autoComplete="off" />
              )}
              <TextField label="Description" optional value={s.description} onChange={(e) => setSlot(i, { description: e.target.value })} autoComplete="off" />
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <SwitchRow className="flex-1" label="Secret" checked={s.secret} disabled={s.target === 'path'} onChange={(v) => setSlot(i, { secret: v })} />
                <SwitchRow className="flex-1" label="Required" checked={s.required} onChange={(v) => setSlot(i, { required: v })} />
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setD((x) => ({ ...x, slots: x.slots.filter((_, j) => j !== i) }))}>
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </FormDialog>
  );
}
