import { Button, LoadError, Menu, RowsSkeleton, useToast, type MenuItem } from '@isnanme/ui';
import type { McpBuiltinAdded, McpBuiltinItem, PoolDetail, PoolSummary } from '@portal/contracts';
import { Check, Pencil, Plus, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { api, errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { AssignWorkspacesDialog } from '@/features/pools/AssignWorkspacesDialog';
import { forbiddenReason } from './access';
import { mcpApi } from './api';
import { BuiltinDialog, type BuiltinTarget } from './BuiltinDialog';
import { BuiltinIcon } from './BuiltinIcon';
import { NotesTip } from './BuiltinNotes';
import { AUTH_MODE } from './labels';
import { WithReason } from './WithReason';

/**
 * The built-in shelf at the top of the catalog (built-in catalogue PRD FR16): one flat card per template, with its notes
 * behind an ⓘ and one action, Add. A template that was added lists its instances under it: each shows Update when the
 * template is newer, and Assign and Edit in a menu. Add, Update and Edit open the same dialog, which shows the exact URL
 * before anything is made; "Assign" then reuses the Pools hub's assign dialog. Rights are never assumed (multi-user): when the
 * portal answers 403 the actions it refused are shown off with its reason, on the control and behind an ⓘ by the title.
 */
export function BuiltinShelf({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<McpBuiltinItem[] | null>(null);
  const [sets, setSets] = useState<Map<string, PoolSummary>>(new Map());
  const [failed, setFailed] = useState(false);
  // 403s: the list itself, adding or changing built-in servers, and assigning a set.
  const [noAccess, setNoAccess] = useState<string | null>(null);
  const [addBlocked, setAddBlocked] = useState<string | null>(null);
  const [assignBlocked, setAssignBlocked] = useState<string | null>(null);
  const [dialog, setDialog] = useState<BuiltinTarget | null>(null);
  const [assigning, setAssigning] = useState<PoolDetail | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [list, pools] = await Promise.all([mcpApi.builtin(), api.pools.list('mcpset').catch(() => [] as PoolSummary[])]);
      setItems(list);
      setSets(new Map(pools.map((p) => [p.id, p])));
      setNoAccess(null);
    } catch (e) {
      const refused = forbiddenReason(e);
      if (refused) setNoAccess(refused);
      else setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useLive('pools', () => void load());

  const assign = async (poolId: string) => {
    setDialog(null);
    try {
      setAssigning(await api.pools.get('mcpset', poolId));
    } catch (e) {
      const refused = forbiddenReason(e);
      if (refused) setAssignBlocked(refused);
      toast(refused ?? errorText(e, 'Could not open the set.'), 'error');
    }
  };

  const why = addBlocked ?? assignBlocked;
  return (
    <section aria-labelledby="builtin-title" className="mb-6">
      <h2 id="builtin-title" className="mb-2 flex items-center gap-0.5 px-1 text-[13px] font-semibold text-muted">
        Built-in
        {why && !noAccess && <InfoTip label="Why some actions are off">{why}</InfoTip>}
      </h2>
      {noAccess && <p className="rounded-2xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">{noAccess}</p>}
      {failed && !items && !noAccess && <LoadError onRetry={load} />}
      {!items && !failed && !noAccess && <RowsSkeleton rows={2} lines={1} trailing icon="rounded-2xl" />}
      {items && !noAccess && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {items.map((item) => (
            <TemplateCard
              key={item.template.id}
              item={item}
              sets={sets}
              addBlocked={addBlocked}
              assignBlocked={assignBlocked}
              onAdd={() => setDialog({ template: item.template, instance: null, existing: item.added.length })}
              onChange={(instance) => setDialog({ template: item.template, instance, existing: item.added.length })}
              onAssign={(instance) => void assign(instance.poolId)}
            />
          ))}
        </ul>
      )}
      <BuiltinDialog
        target={dialog}
        onClose={() => setDialog(null)}
        onChanged={() => {
          void load();
          onChanged();
        }}
        onAssign={(poolId) => void assign(poolId)}
        onBlocked={setAddBlocked}
      />
      <AssignWorkspacesDialog
        type="mcpset"
        pool={assigning}
        onClose={() => setAssigning(null)}
        onDone={(message) => {
          setAssigning(null);
          toast(message);
          void load();
        }}
      />
    </section>
  );
}

function TemplateCard({
  item,
  sets,
  addBlocked,
  assignBlocked,
  onAdd,
  onChange,
  onAssign,
}: {
  item: McpBuiltinItem;
  sets: Map<string, PoolSummary>;
  /** The portal's reason when this person may not add or change built-in servers; null while nothing says so. */
  addBlocked: string | null;
  assignBlocked: string | null;
  onAdd: () => void;
  onChange: (instance: McpBuiltinAdded) => void;
  onAssign: (instance: McpBuiltinAdded) => void;
}) {
  const { template, added } = item;
  // A grid, so the instance lines can run under the Add button's column too: names are not squeezed on a phone.
  return (
    <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 rounded-2xl border border-line bg-surface px-3.5 py-3">
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
        <BuiltinIcon id={template.icon} />
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-0.5">
          <h3 className="truncate text-sm font-semibold">{template.name}</h3>
          <NotesTip template={template} />
        </div>
        <p className="line-clamp-2 text-[13px] text-ink-soft">{template.summary}</p>
      </div>
      <WithReason reason={addBlocked}>
        {added.length === 0 ? (
          <Button size="sm" variant="secondary" aria-label={`Add ${template.name}`} onClick={onAdd} disabled={!!addBlocked}>
            Add
          </Button>
        ) : (
          <Button size="icon" variant="ghost" aria-label={`Add another ${template.name}`} title={addBlocked ?? 'Add another'} onClick={onAdd} disabled={!!addBlocked} className="-mr-1.5">
            <Plus className="size-[18px]" />
          </Button>
        )}
      </WithReason>
      {added.length > 0 && (
        <ul className="col-span-2 col-start-2 mt-1 flex flex-col">
          {added.map((instance) => (
            <InstanceLine
              key={instance.id}
              instance={instance}
              set={sets.get(instance.poolId)}
              addBlocked={addBlocked}
              assignBlocked={assignBlocked}
              onChange={() => onChange(instance)}
              onAssign={() => onAssign(instance)}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * An instance of a template: its set (a link to the set's page), how it signs in, and its next step. One button at most:
 * Update when the template is newer, else Assign while no workspace has the set; Assign and Edit are always in the menu.
 */
function InstanceLine({
  instance,
  set,
  addBlocked,
  assignBlocked,
  onChange,
  onAssign,
}: {
  instance: McpBuiltinAdded;
  set?: PoolSummary;
  addBlocked: string | null;
  assignBlocked: string | null;
  onChange: () => void;
  onAssign: () => void;
}) {
  const items: MenuItem[] = [
    { label: 'Assign…', icon: <Users className="size-4" />, onSelect: onAssign, disabled: !!assignBlocked },
    { label: 'Edit…', icon: <Pencil className="size-4" />, onSelect: onChange, disabled: !!addBlocked },
  ];
  const next = instance.updateAvailable ? 'Update' : set && set.workspaces === 0 ? 'Assign' : null;
  const nextReason = next === 'Update' ? addBlocked : assignBlocked;
  return (
    <li className="flex min-h-9 items-center gap-1.5 text-[13px]">
      <Check className="size-4 shrink-0 text-accent" strokeWidth={2.75} aria-hidden="true" />
      <Link to={`/admin/pools/mcp/${instance.poolId}/edit`} className="min-w-0 truncate font-medium text-ink hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
        {instance.poolName}
      </Link>
      <span className="shrink-0 text-muted">{AUTH_MODE[instance.auth]}</span>
      <span className="flex-1" />
      {next && (
        <WithReason reason={nextReason}>
          <Button size="sm" variant="secondary" onClick={next === 'Update' ? onChange : onAssign} aria-label={`${next} ${instance.poolName}`} disabled={!!nextReason}>
            {next}
          </Button>
        </WithReason>
      )}
      <span className="-mr-2">
        <Menu label={`Actions for ${instance.poolName}`} items={items} />
      </span>
    </li>
  );
}
