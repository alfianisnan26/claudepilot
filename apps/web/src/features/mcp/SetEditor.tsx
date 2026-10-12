import { Badge, Button, Dialog, LoadError, RowsSkeleton, Select, Switch, TextField } from '@isnanme/ui';
import type { McpCatalogEntry, McpSetContent, McpSetServer, McpSlot, SecretsContent } from '@portal/contracts';
import { MCP_SERVER_KEY_MAX, MCP_SLUG_MAX, SECRET_FILE_REF, secretFileRef } from '@portal/contracts';
import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import type { PoolContentEditorProps } from '@/features/pools/types';
import { api } from '@/lib/api';
import { mcpApi } from './api';
import { KIND_ICON } from './CatalogPage';
import { KIND_LABEL, newestApproved, REVIEW } from './labels';
import { Disclosure, MONO } from './parts';

const refName = (ref: string | undefined) => (ref ? (SECRET_FILE_REF.exec(ref)?.[1] ?? ref) : '');

/** A key for a new server: the entry's own, unless the set has it already. */
function freeKey(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const k = `${base.slice(0, MCP_SERVER_KEY_MAX - String(n).length - 1)}-${n}`;
    if (!taken.includes(k)) return k;
  }
}

/**
 * The set editor (MCP set PRD §15): a row per server with its catalog version, its secret slots (a
 * Secrets & env entry name each, never a value), its settings and an on switch. "Preview files" in the
 * shared editor shows exactly what a workspace gets.
 */
export function SetEditor({ value, onChange, errors, pool, disabled }: PoolContentEditorProps<McpSetContent>) {
  const [catalog, setCatalog] = useState<McpCatalogEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      setCatalog(await mcpApi.catalog());
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  // Secret names the Secrets sets hold, for the slot pickers (PRD §15). Names only, never values.
  const [secretNames, setSecretNames] = useState<string[] | null>(null);
  useEffect(() => {
    api.pools.list('secrets').then(
      (sets) => setSecretNames([...new Set(sets.flatMap((p) => ((p.content as SecretsContent | null)?.entries ?? []).filter((e) => e.kind === 'secret').map((e) => e.name)))].sort()),
      () => setSecretNames([]),
    );
  }, []);

  const servers = value.servers ?? [];
  const setServer = (i: number, next: McpSetServer) => onChange({ ...value, servers: servers.map((s, j) => (j === i ? next : s)) });
  const err = (key: string) => errors[key];
  const delivered = !!pool && pool.revision > 0 && pool.workspaces > 0;

  return (
    <div className="flex flex-col gap-4">
      <TextField
        label="ID"
        hint={`cpm-${value.slug || '…'} · fixed once assigned`}
        placeholder="From the name"
        value={value.slug ?? ''}
        onChange={(e) => onChange({ ...value, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
        error={err('slug')}
        maxLength={MCP_SLUG_MAX}
        disabled={disabled || delivered}
        autoComplete="off"
      />
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold text-ink-soft">Servers</span>
          <div className="flex items-center gap-1">
            <Link to="/admin/pools/mcp/catalog" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-semibold text-muted hover:text-ink">
              Catalog <ExternalLink className="size-3.5" />
            </Link>
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} disabled={disabled || !catalog}>
              Add server
            </Button>
          </div>
        </div>
        {err('servers') && <p className="text-[12.5px] text-danger">{err('servers')}</p>}
        {failed && <LoadError onRetry={load} />}
        {!catalog && !failed && <RowsSkeleton rows={2} lines={1} trailing />}
        {catalog && servers.length === 0 && <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">No servers yet. Add approved servers from the catalog.</p>}
        {catalog &&
          servers.map((s, i) => (
            <ServerRow
              key={i}
              index={i}
              server={s}
              entry={catalog.find((e) => e.id === s.entry)}
              secretNames={secretNames}
              errors={errors}
              disabled={disabled}
              onChange={(next) => setServer(i, next)}
              onRemove={() => onChange({ ...value, servers: servers.filter((_, j) => j !== i) })}
            />
          ))}
      </div>
      <AddServerDialog
        open={adding}
        catalog={catalog ?? []}
        onClose={() => setAdding(false)}
        onPick={(e) => {
          const v = newestApproved(e);
          if (!v) return;
          setAdding(false);
          onChange({ ...value, servers: [...servers, { key: freeKey(e.key, servers.map((x) => x.key)), entry: e.id, version: v.version, enabled: true, config: {}, secrets: {} }] });
        }}
      />
    </div>
  );
}

function ServerRow({
  index: i,
  server: s,
  entry,
  secretNames,
  errors,
  disabled,
  onChange,
  onRemove,
}: {
  index: number;
  server: McpSetServer;
  entry: McpCatalogEntry | undefined;
  secretNames: string[] | null;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (s: McpSetServer) => void;
  onRemove: () => void;
}) {
  const version = entry?.versions.find((v) => v.version === s.version);
  const newest = entry && newestApproved(entry);
  const prefix = `servers.${i}`;
  const rowErrors = Object.keys(errors).filter((k) => k === prefix || k.startsWith(`${prefix}.`));
  const Icon = entry ? KIND_ICON[entry.kind] : null;
  // Approved versions to pick from, plus the one it's on (a deprecated or revoked one stays only where it is).
  const options = (entry?.versions ?? []).filter((v) => v.reviewState === 'approved' || v.version === s.version);
  return (
    <Disclosure
      defaultOpen={rowErrors.length > 0 || Object.keys(s.secrets).length === 0}
      tone={version?.reviewState === 'revoked' ? 'danger' : undefined}
      summary={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {Icon && <Icon className="size-3.5 text-muted" />}
          <span className="text-sm font-semibold" style={{ fontFamily: MONO }}>
            {s.key}
          </span>
          <span className="text-[12.5px] text-ink-soft">
            {entry?.displayName ?? 'Missing from the catalog'} {s.version}
          </span>
          {!s.enabled && <Badge>Off</Badge>}
          {version && version.reviewState !== 'approved' && <Badge tone={REVIEW[version.reviewState].tone}>{REVIEW[version.reviewState].label}</Badge>}
          {newest && version && newest.version !== version.version && version.reviewState !== 'draft' && <Badge tone="warning">Upgrade available: {newest.version}</Badge>}
          {rowErrors.length > 0 && <Badge tone="danger">Check this</Badge>}
        </span>
      }
      trailing={<Switch checked={s.enabled} onChange={(on) => onChange({ ...s, enabled: on })} label={`${s.key} on`} disabled={disabled} />}
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Key"
            hint={
              <span className="inline-flex items-center gap-1">
                Renaming makes it a new server.
                <InfoTip label="About renaming">Rules and usage history start fresh, and tool lists naming the old tools stop matching.</InfoTip>
              </span>
            }
            value={s.key}
            onChange={(e) => onChange({ ...s, key: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
            error={errors[`${prefix}.key`]}
            maxLength={MCP_SERVER_KEY_MAX}
            disabled={disabled}
            autoComplete="off"
          />
          <Select
            label="Version"
            value={s.version}
            onChange={(v) => onChange({ ...s, version: v })}
            error={errors[`${prefix}.version`]}
            disabled={disabled || !entry}
            options={options.map((v) => ({ value: v.version, label: `${v.version}${v.reviewState === 'approved' ? '' : ` (${REVIEW[v.reviewState].label.toLowerCase()})`}` }))}
          />
        </div>
        {entry && <p className="text-[12px] text-muted">{KIND_LABEL[entry.kind]} · {version?.command}</p>}
        {(version?.slots ?? []).map((slot) => {
          const field = `${prefix}.${slot.secret ? 'secrets' : 'config'}.${slot.name}`;
          return slot.secret ? (
            <SecretSlotField
              key={slot.name}
              slot={slot}
              names={secretNames}
              value={refName(s.secrets[slot.name])}
              onChange={(name) => {
                const { [slot.name]: _, ...rest } = s.secrets;
                onChange({ ...s, secrets: name ? { ...rest, [slot.name]: secretFileRef(name) } : rest });
              }}
              error={errors[field]}
              disabled={disabled}
            />
          ) : (
            <TextField
              key={slot.name}
              label={slot.name}
              optional={!slot.required || !!slot.default}
              hint={slot.description}
              placeholder={slot.default}
              value={s.config[slot.name] ?? ''}
              onChange={(e) => {
                const { [slot.name]: _, ...rest } = s.config;
                onChange({ ...s, config: e.target.value ? { ...rest, [slot.name]: e.target.value } : rest });
              }}
              error={errors[field]}
              disabled={disabled}
              autoComplete="off"
            />
          );
        })}
        {rowErrors
          .filter((k) => k === prefix || k === `${prefix}.version`)
          .map((k) => (
            <p key={k} className="text-[12.5px] text-danger">
              {errors[k]}
            </p>
          ))}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={onRemove} disabled={disabled}>
            Remove from set
          </Button>
        </div>
      </div>
    </Disclosure>
  );
}

function AddServerDialog({ open, catalog, onClose, onPick }: { open: boolean; catalog: McpCatalogEntry[]; onClose: () => void; onPick: (e: McpCatalogEntry) => void }) {
  const ready = catalog.filter((e) => newestApproved(e));
  const waiting = catalog.length - ready.length;
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Add a server" description="Approved catalog servers, at their newest approved version.">
      {ready.length === 0 ? (
        <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">
          No approved servers yet.{' '}
          <Link className="font-semibold text-accent" to="/admin/pools/mcp/catalog">
            Open the catalog
          </Link>
          .
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-2xl border border-line">
          {ready.map((e) => {
            const Icon = KIND_ICON[e.kind];
            return (
              <li key={e.id}>
                <button type="button" onClick={() => onPick(e)} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-surface-2/60">
                  <Icon className="size-4 shrink-0 text-accent" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{e.displayName}</span>
                    <span className="block truncate text-[12px] text-muted">
                      {KIND_LABEL[e.kind]} · {newestApproved(e)!.version}
                    </span>
                  </span>
                  <Plus className="size-4 text-muted" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {waiting > 0 && <p className="mt-3 text-[12px] text-muted">{waiting} more waiting for review in the catalog.</p>}
    </Dialog>
  );
}

const OTHER = '\u0000other';

/**
 * A secret slot's Secrets & env entry (FR10, PRD §15): a pick of the secret names the Secrets sets hold,
 * or another name typed in (a set that provides it may come later; the server is left out until then).
 * The set stores `{{secret-file:NAME}}`, never a value.
 */
function SecretSlotField({
  slot,
  names,
  value,
  onChange,
  error,
  disabled,
}: {
  slot: McpSlot;
  names: string[] | null;
  value: string;
  onChange: (name: string) => void;
  error?: string;
  disabled: boolean;
}) {
  // Still loading the names counts as known: only a name no Secrets set holds opens the text field.
  const known = !value || names === null || names.includes(value);
  const [typing, setTyping] = useState(!known);
  useEffect(() => {
    if (!known) setTyping(true);
  }, [known]);
  const label = `${slot.name}${slot.target === 'path' ? ' (file path)' : ''}`;
  const hint = (
    <>
      {slot.description ?? 'The Secrets entry each workspace gets it from. The set never holds the value.'}{' '}
      {/* A tab of its own: leaving here would drop the unsaved set. */}
      <Link className="font-semibold text-accent" to="/admin/pools?tab=secrets" target="_blank" rel="noreferrer">
        Create secret
      </Link>
    </>
  );
  if (typing || !names || names.length === 0)
    return (
      <TextField
        label={label}
        optional={!slot.required}
        hint={
          <>
            {hint}
            {names && names.length > 0 && (
              <>
                {' · '}
                <button type="button" className="font-semibold text-accent" onClick={() => (setTyping(false), names.includes(value) || onChange(''))}>
                  Pick from the list
                </button>
              </>
            )}
          </>
        }
        prefix={<span className="text-[12px] text-muted">secret</span>}
        placeholder="ENTRY_NAME"
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        error={error}
        disabled={disabled}
        autoComplete="off"
      />
    );
  return (
    <Select
      label={label}
      optional={!slot.required}
      hint={hint}
      placeholder="Pick a secret"
      value={value}
      onChange={(v) => (v === OTHER ? setTyping(true) : onChange(v))}
      error={error}
      disabled={disabled}
      options={[...names.map((n) => ({ value: n, label: n })), { value: OTHER, label: 'Another name…' }]}
    />
  );
}
