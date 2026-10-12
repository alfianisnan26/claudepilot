import { Button, EmptyState, LoadError, Menu, RowsSkeleton, useToast, type MenuItem } from '@isnanme/ui';
import type { VaultSummary } from '@portal/contracts';
import { Bot, ChevronRight, FileUp, FolderInput, Library, Lock, Network, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { timeAgo } from '@/lib/format';
import { knowledgeApi } from './api';
import { ImportDialog, NewVaultDialog } from './dialogs';
import { useLoad } from './hooks';
import { vaultHref } from './labels';

/** The vaults: one row each. Opening one goes full screen. */
export function KnowledgePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const vaults = useLoad('vaults', () => knowledgeApi.vaults());
  const sources = useLoad('sources', () => knowledgeApi.sources());
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  // Counts fill in while a vault is still being indexed.
  const scanning = vaults.data?.some((v) => v.indexState === 'scanning') ?? false;
  useEffect(() => {
    if (!scanning) return;
    const id = setInterval(() => void vaults.reload(), 2000);
    return () => clearInterval(id);
  }, [scanning, vaults]);

  const items: MenuItem[] = [
    { label: 'Import zip', icon: <FileUp className="size-4" />, onSelect: () => setImporting(true) },
    ...((sources.data?.length ?? 0) > 0 ? [{ label: 'Folder source', icon: <FolderInput className="size-4" />, onSelect: () => setCreating(true) }] : []),
    { label: 'Graph', icon: <Network className="size-4" />, onSelect: () => navigate('/admin/knowledge/graph') },
  ];
  // With no vault yet the empty state holds the one New; the menu (Import zip, Graph) stays up here.
  const empty = vaults.data?.length === 0;
  const add = (
    <div className="flex items-center gap-1.5">
      {!empty && (
        <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New
        </Button>
      )}
      <Menu label="More" items={items} align="right" />
    </div>
  );

  return (
    <>
      <PageHeader title="Knowledge" action={add} />
      {vaults.error && !vaults.data && <LoadError onRetry={vaults.reload} />}
      {!vaults.data && !vaults.error && <RowsSkeleton rows={3} lines={1} trailing icon="rounded-2xl" />}
      {vaults.data &&
        (vaults.data.length === 0 ? (
          <EmptyState icon={<Library className="size-6" />} title="No vaults" action={<Button onClick={() => setCreating(true)}>New vault</Button>}>
            Notes you and your agents share.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {vaults.data.map((v) => (
              <VaultRow key={v.id} vault={v} onOpen={() => navigate(vaultHref(v.id))} />
            ))}
          </ul>
        ))}
      <NewVaultDialog
        open={creating}
        sources={sources.data ?? []}
        onClose={() => setCreating(false)}
        onCreated={(v) => {
          setCreating(false);
          toast(`${v.name} created`);
          navigate(vaultHref(v.id));
        }}
      />
      <ImportDialog
        open={importing}
        onClose={() => setImporting(false)}
        onDone={(r) => {
          void vaults.reload();
          navigate(vaultHref(r.vaultId));
        }}
      />
    </>
  );
}

function VaultRow({ vault: v, onOpen }: { vault: VaultSummary; onOpen: () => void }) {
  const detail = [`${v.counts.notes.toLocaleString('en')} notes`, v.counts.files > 0 ? `${v.counts.files.toLocaleString('en')} files` : '', v.indexState === 'scanning' ? 'indexing' : v.lastChangeAt ? timeAgo(v.lastChangeAt) : ''].filter(Boolean).join(' · ');
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-center gap-3 rounded-2xl border border-line bg-surface px-3.5 py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Library className="size-[18px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{v.name}</span>
          <span className="block truncate text-[13px] text-muted">{v.problem ?? detail}</span>
        </span>
        {v.readOnly && <Lock className="size-4 shrink-0 text-muted" aria-label="Read-only" />}
        {v.agentWrites7d > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[12px] font-semibold text-ink-soft" title="Agent changes this week">
            <Bot className="size-3.5" aria-hidden="true" />
            {v.agentWrites7d}
          </span>
        )}
        <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" />
      </button>
    </li>
  );
}
