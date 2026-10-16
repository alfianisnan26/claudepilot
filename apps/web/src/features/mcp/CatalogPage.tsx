import { Badge, Button, EmptyState, LoadError, RowsSkeleton, useToast } from '@isnanme/ui';
import type { McpCatalogEntry, McpEntryKind } from '@portal/contracts';
import { Bot, ChevronLeft, ChevronRight, Globe, Package, Plus, Terminal, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { useLive } from '@/lib/live';
import { mcpApi } from './api';
import { BuiltinShelf } from './BuiltinShelf';
import { EntryDialog, type EntryDialogMode } from './EntryDialog';
import { authLabel, KIND_LABEL, newestApproved, REVIEW } from './labels';
import { MONO } from './parts';

export const KIND_ICON: Record<McpEntryKind, LucideIcon> = { npm: Package, pypi: Package, remote: Globe, command: Terminal };

/**
 * The catalog (MCP set PRD §15, `/admin/pools/mcp/catalog`): reviewed servers sets can use. A row shows
 * kind, version, review state, auth and where it's used; the entry's page holds the review.
 */
export function CatalogPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<McpCatalogEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<EntryDialogMode | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setEntries(await mcpApi.catalog());
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useLive('pools', () => void load());

  const proposed = (entries ?? []).reduce((n, e) => n + e.versions.filter((v) => v.proposal && v.reviewState === 'draft').length, 0);
  const add = (
    <Button icon={<Plus className="size-4" />} onClick={() => setDialog({ kind: 'create' })}>
      Add manually
    </Button>
  );
  return (
    <>
      <Link to="/admin/pools?tab=mcp" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink">
        <ChevronLeft className="size-4" />
        MCP sets
      </Link>
      <PageHeader title="MCP catalog" description="Reviewed servers that sets can use. Every version is pinned and approved before it reaches a workspace." action={entries && entries.length > 0 && add} />
      {proposed > 0 && (
        <p className="mb-4 flex items-start gap-2 rounded-xl bg-amber-500/10 px-3.5 py-2.5 text-[13px] text-ink-soft">
          <Bot className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
          <span>
            {proposed} server{proposed === 1 ? ' was' : 's were'} proposed by an agent or a token and {proposed === 1 ? 'waits' : 'wait'} for your review. Nothing reaches a workspace until you approve it.
          </span>
        </p>
      )}
      <BuiltinShelf onChanged={() => void load()} />
      {failed && <LoadError onRetry={load} />}
      {!entries && !failed && <RowsSkeleton rows={3} lines={2} trailing icon="rounded-2xl" />}
      {entries &&
        (entries.length === 0 ? (
          <EmptyState icon={<Package className="size-6" />} title="No servers yet" action={add}>
            <InfoTip label="About adding servers">Add an npm package at an exact version, a remote URL, or a command in the image.</InfoTip>
          </EmptyState>
        ) : (
          <section aria-labelledby="catalog-servers">
            <h2 id="catalog-servers" className="mb-2 px-1 text-[13px] font-semibold text-muted">
              Servers
            </h2>
            <ul className="flex flex-col gap-2">
              {entries.map((e) => (
                <EntryRow key={e.id} entry={e} onOpen={() => navigate(`/admin/pools/mcp/catalog/${e.id}`)} />
              ))}
            </ul>
          </section>
        ))}
      <EntryDialog
        mode={dialog}
        onClose={() => setDialog(null)}
        onSaved={(e) => {
          setDialog(null);
          toast(`${e.displayName} saved as a draft`);
          navigate(`/admin/pools/mcp/catalog/${e.id}`);
        }}
      />
    </>
  );
}

function EntryRow({ entry: e, onOpen }: { entry: McpCatalogEntry; onOpen: () => void }) {
  const Icon = KIND_ICON[e.kind];
  const current = newestApproved(e) ?? e.versions[0];
  const drafts = e.versions.filter((v) => v.reviewState === 'draft');
  const auth = authLabel(current);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-start gap-3 rounded-2xl border border-line bg-surface px-3.5 py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold">{e.displayName}</span>
            <span className="text-[11.5px] text-muted" style={{ fontFamily: MONO }}>
              {e.key}
            </span>
            {current && (
              <span className="text-[12px] text-ink-soft" style={{ fontFamily: MONO }}>
                {current.version}
              </span>
            )}
            {current && <Badge tone={REVIEW[current.reviewState].tone}>{REVIEW[current.reviewState].label}</Badge>}
            {drafts.length > 0 && current?.reviewState !== 'draft' && <Badge tone="warning">{drafts.length === 1 ? `${drafts[0]!.version} waiting for review` : `${drafts.length} drafts`}</Badge>}
            {drafts.some((d) => d.proposal) && <Badge tone="warning">Proposed by an agent</Badge>}
            {current?.flags.some((f) => f.code !== 'not_pinned') && <Badge tone="danger">{current.flags.length} flagged</Badge>}
          </span>
          {e.description && <span className="mt-0.5 line-clamp-2 block text-[13px] text-ink-soft">{e.description}</span>}
          <span className="mt-0.5 block text-[12px] text-muted">
            {[KIND_LABEL[e.kind], auth, e.sets.length ? `In ${e.sets.length} set${e.sets.length === 1 ? '' : 's'}` : 'In no set', e.workspaces ? `${e.workspaces} workspace${e.workspaces === 1 ? '' : 's'}` : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <ChevronRight className="mt-2 size-4 shrink-0 text-muted" />
      </button>
    </li>
  );
}
