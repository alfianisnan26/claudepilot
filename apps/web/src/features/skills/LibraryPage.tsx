import { Badge, Button, ChipGroup, ConfirmDialog, EmptyState, LoadError, Menu, RowsSkeleton, useToast, type MenuItem } from '@isnanme/ui';
import type { SkillLibrary, SkillSourceSummary, SkillVersionSummary } from '@portal/contracts';
import { ChevronLeft, ChevronRight, FileUp, Sparkles, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { PageHeader } from '@/components/PageHeader';
import { errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useLive } from '@/lib/live';
import { skillsApi } from './api';
import { ImportDialog } from './ImportDialog';
import { MONO, REVIEW, shortHash, size, SOURCE_KIND } from './labels';

type Filter = 'all' | 'review' | 'scripted';

/**
 * The skill library (Skillset PRD §13, `/admin/pools/skills/library`): a row per imported skill version
 * with its source, short hash, badges and review state, filters for what needs review or runs code, and
 * the sources they came from. A row opens its review page.
 */
export function LibraryPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [lib, setLib] = useState<SkillLibrary | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<{ source: SkillSourceSummary; versions: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setLib(await skillsApi.library());
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);
  useLive('pools', () => void load());

  const shown = useMemo(() => {
    const all = lib?.versions ?? [];
    return filter === 'review' ? all.filter((v) => v.review === 'needs_review') : filter === 'scripted' ? all.filter((v) => v.scripted) : all;
  }, [lib, filter]);

  const removeSource = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await skillsApi.removeSource(removing.source.id, removing.versions);
      toast(removing.versions ? `${removing.source.label} and its versions removed` : `${removing.source.label} removed from the list`);
      setRemoving(null);
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not remove it.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const importButton = (
    <Button icon={<Upload className="size-4" />} onClick={() => setImporting(true)}>
      Import
    </Button>
  );
  return (
    <>
      <Link to="/admin/pools?tab=skills" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink">
        <ChevronLeft className="size-4" />
        Skills
      </Link>
      <PageHeader
        title="Skill library"
        description="Imported skills, each version reviewed before it can reach a workspace."
        action={lib && lib.versions.length > 0 && importButton}
      />
      {failed && <LoadError onRetry={load} />}
      {!lib && !failed && <RowsSkeleton rows={4} lines={2} trailing icon="rounded-2xl" />}
      {lib &&
        (lib.versions.length === 0 ? (
          <EmptyState icon={<Sparkles className="size-6" />} title="No skills yet" action={importButton}>
            <InfoTip label="About importing skills">Upload a zip or a folder of skills. You read what each one does, and approve it, before any workspace gets it.</InfoTip>
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-5">
            <ChipGroup
              label="Show"
              hideLabel
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All', detail: lib.versions.length },
                { value: 'review', label: 'Needs review', detail: lib.toReview },
                { value: 'scripted', label: 'Scripted', detail: lib.versions.filter((v) => v.scripted).length },
              ]}
            />
            {shown.length === 0 ? (
              <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">{filter === 'review' ? 'Nothing is waiting for review.' : 'No skill matches.'}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {shown.map((v) => (
                  <VersionRow key={v.id} version={v} onOpen={() => navigate(`/admin/pools/skills/review/${v.id}`)} />
                ))}
              </ul>
            )}
            <Sources sources={lib.sources} onRemove={(source, versions) => setRemoving({ source, versions })} />
          </div>
        ))}
      <ImportDialog open={importing} onClose={() => setImporting(false)} onImported={() => void load()} />
      <ConfirmDialog
        open={!!removing}
        title={removing?.versions ? `Remove ${removing.source.label} and its versions?` : `Remove ${removing?.source.label ?? ''}?`}
        description={
          removing?.versions
            ? 'Its versions are deleted from the library. The portal refuses while a skillset lists one of them.'
            : 'It leaves this list and stops being checked. Its versions stay in the library: they never change, and skillsets may use them.'
        }
        confirmLabel="Remove"
        loading={busy}
        onConfirm={() => void removeSource()}
        onClose={() => !busy && setRemoving(null)}
      />
    </>
  );
}

function VersionRow({ version: v, onOpen }: { version: SkillVersionSummary; onOpen: () => void }) {
  const review = REVIEW[v.review];
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-start gap-3 rounded-2xl border border-line bg-surface px-3.5 py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Sparkles className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold" style={{ fontFamily: MONO }}>
              {v.name}
            </span>
            <span className="text-[11.5px] text-muted" style={{ fontFamily: MONO }}>
              {shortHash(v.treeHash)}
            </span>
            <Badge tone={review.tone}>{review.label}</Badge>
            {v.scripted && <Badge tone="warning">Scripted</Badge>}
            {v.network && <Badge tone="warning">Network</Badge>}
            {v.hooks && <Badge tone="danger">Hooks</Badge>}
            {v.proposal && v.review === 'needs_review' && <Badge tone="warning">Proposed</Badge>}
            {v.convertedFrom && <Badge>Was {v.convertedFrom}</Badge>}
          </span>
          {v.description && <span className="mt-0.5 line-clamp-2 block text-[13px] text-ink-soft">{v.description}</span>}
          <span className="mt-0.5 block text-[12px] text-muted">
            {[v.sourceLabel, v.fileCount === 1 ? '1 file' : `${v.fileCount} files`, size(v.sizeBytes), v.sets ? `In ${v.sets} set${v.sets === 1 ? '' : 's'}` : 'In no set']
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <ChevronRight className="mt-2 size-4 shrink-0 text-muted" />
      </button>
    </li>
  );
}

function Sources({ sources, onRemove }: { sources: SkillSourceSummary[]; onRemove: (source: SkillSourceSummary, withVersions: boolean) => void }) {
  if (sources.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-[13px] font-semibold text-ink-soft">Sources</h3>
      <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
        {sources.map((s) => {
          const items: MenuItem[] = [
            { label: 'Remove from the list', icon: <FileUp className="size-4" />, onSelect: () => onRemove(s, false) },
            { label: 'Remove with its versions', icon: <Trash2 className="size-4" />, onSelect: () => onRemove(s, true), danger: true },
          ];
          return (
            <li key={s.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{s.label}</p>
                <p className="text-[12px] text-muted">
                  {SOURCE_KIND[s.kind]} · {s.versions} version{s.versions === 1 ? '' : 's'} · imported {timeAgo(s.createdAt)}
                  {s.ref ? ` · ${s.ref}` : ''}
                  {s.resolved ? ` → ${s.resolved.slice(0, 7)}` : ''}
                </p>
              </div>
              <Menu label={`Actions for ${s.label}`} items={items} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
