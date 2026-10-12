import { Badge, Button, Dialog, LoadError, RowsSkeleton, Select, SwitchRow, TextField } from '@isnanme/ui';
import { SKILL_LISTING_BUDGET, SKILLSET_PREFIX_MAX, type SkillLibrary, type SkillsetContentView, type SkillsetEntryView, type SkillVersionSummary } from '@portal/contracts';
import { ExternalLink, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import type { PoolContentEditorProps } from '@/features/pools/types';
import { skillsApi } from './api';
import { chars, MODE, MONO, REVIEW } from './labels';
import { Check, Meter } from './parts';

/**
 * The skillset editor (Skillset PRD §13): the command prefix with a live `/prefix:name` for each skill, a
 * row per skill with On, Manual or Off and "Remove pre-approved tools", the skill listing's share of its
 * budget (§12), and "Add skills" from the library. A skill that isn't approved yet can be turned on:
 * the revision then waits for review (FR14), and the row says so. "Preview files" in the shared editor
 * shows exactly what a workspace gets.
 */
export function SkillsetEditor({ value, onChange, errors, pool, name = '', disabled }: PoolContentEditorProps<SkillsetContentView>) {
  const [library, setLibrary] = useState<SkillLibrary | null>(null);
  // A new set's prefix follows its name until it's edited by hand.
  const [typed, setTyped] = useState(false);
  const derived = prefixFromName(name);
  useEffect(() => {
    if (!pool && !typed && value.prefix !== derived) onChange({ ...value, prefix: derived });
  }, [pool, typed, derived, value, onChange]);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      setLibrary(await skillsApi.library());
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const skills = value.skills ?? [];
  const set = (i: number, next: SkillsetEntryView) => onChange({ ...value, skills: skills.map((s, j) => (j === i ? next : s)) });
  const delivered = !!pool && pool.revision > 0 && pool.workspaces > 0;
  // §12: only skills Claude can invoke have a description in the listing; Manual and Off ones don't.
  const listing = skills.filter((s) => s.mode === 'on').reduce((n, s) => n + s.listingChars, 0);
  const waiting = skills.filter((s) => s.mode !== 'off' && s.review !== 'approved');

  return (
    <div className="flex flex-col gap-4">
      <TextField
        label="Prefix"
        hint={
          <>
            <span style={{ fontFamily: MONO }}>/{value.prefix || '…'}:skill</span>
            {delivered ? ` · renaming changes ${pool!.workspaces} workspace${pool!.workspaces === 1 ? '' : 's'}` : ''}
          </>
        }
        placeholder="From the name"
        value={value.prefix ?? ''}
        onChange={(e) => (setTyped(true), onChange({ ...value, prefix: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
        error={errors.prefix}
        maxLength={SKILLSET_PREFIX_MAX}
        disabled={disabled}
        autoComplete="off"
      />
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold text-ink-soft">Skills</span>
          <div className="flex items-center gap-1">
            <Link to="/admin/pools/skills/library" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-semibold text-muted hover:text-ink">
              Library <ExternalLink className="size-3.5" />
            </Link>
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} disabled={disabled || !library}>
              Add skills
            </Button>
          </div>
        </div>
        {errors.skills && <p className="text-[12.5px] text-danger">{errors.skills}</p>}
        {failed && <LoadError onRetry={load} />}
        {!library && !failed && <RowsSkeleton rows={2} lines={1} trailing />}
        {library && skills.length === 0 && <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">No skills yet. Add approved skills from the library.</p>}
        {skills.map((s, i) => (
          <SkillRow
            key={s.versionId}
            skill={s}
            prefix={value.prefix}
            disabled={disabled}
            onChange={(next) => set(i, next)}
            onRemove={() => onChange({ ...value, skills: skills.filter((_, j) => j !== i) })}
          />
        ))}
      </div>
      {skills.length > 0 && (
        <div className="flex items-start gap-2 rounded-2xl bg-surface-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <Meter label="Skill listing" value={`${chars(listing)} of ${chars(SKILL_LISTING_BUDGET)} characters`} fraction={listing / SKILL_LISTING_BUDGET} />
            {listing / SKILL_LISTING_BUDGET > 0.75 && <p className="mt-1.5 text-[12.5px] text-muted">Nearly full: set rarely used skills to Manual.</p>}
          </div>
          <InfoTip label="About the skill listing">
            Names and descriptions of the skills Claude can pick on its own; Manual and Off skills aren’t listed. When it is full, Claude Code drops the descriptions of the least used skills, so it stops choosing them.
          </InfoTip>
        </div>
      )}
      {waiting.length > 0 && (
        <p className="rounded-xl bg-amber-500/12 px-3.5 py-2.5 text-[13px] font-medium text-amber-700 dark:text-amber-400">
          {waiting.map((w) => w.name).join(', ')} {waiting.length === 1 ? 'isn’t' : 'aren’t'} approved: this revision waits for review.
        </p>
      )}
      <AddSkillsDialog
        open={adding}
        library={library}
        taken={skills}
        onClose={() => setAdding(false)}
        onAdd={(picked) => {
          setAdding(false);
          onChange({ ...value, skills: [...skills, ...picked.map(entryOf)] });
        }}
      />
    </div>
  );
}

/** `Frontend Tools` → `frontend-tools`: a prefix is lowercase words joined by single dashes. */
const prefixFromName = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SKILLSET_PREFIX_MAX)
    .replace(/-+$/, '');

const entryOf = (v: SkillVersionSummary): SkillsetEntryView => ({
  versionId: v.id,
  mode: 'on',
  stripAllowedTools: false,
  name: v.name,
  description: v.description,
  treeHash: v.treeHash,
  scripted: v.scripted,
  risk: v.risk,
  review: v.review,
  allowedTools: v.allowedTools,
  listingChars: v.listingChars,
});

function SkillRow({ skill: s, prefix, disabled, onChange, onRemove }: { skill: SkillsetEntryView; prefix: string; disabled: boolean; onChange: (s: SkillsetEntryView) => void; onRemove: () => void }) {
  const review = REVIEW[s.review];
  return (
    <div className={`rounded-2xl border bg-surface px-3.5 py-3 ${s.mode === 'off' ? 'border-line opacity-70' : 'border-line'}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold" style={{ fontFamily: MONO }}>
              {s.name}
            </span>
            {s.missing ? <Badge tone="danger">Removed from the library</Badge> : <Badge tone={review.tone}>{review.label}</Badge>}
            {s.scripted && <Badge tone="warning">Scripted</Badge>}
          </div>
          {s.description && <p className="mt-0.5 line-clamp-2 text-[13px] text-ink-soft">{s.description}</p>}
          <p className="mt-0.5 text-[12px] text-muted" style={{ fontFamily: MONO }}>
            /{prefix || '…'}:{s.name}
            {s.mode === 'manual' ? ` · typed only` : ''}
          </p>
        </div>
        <Button variant="ghost" size="sm" aria-label={`Remove ${s.name}`} icon={<Trash2 className="size-4" />} onClick={onRemove} disabled={disabled} />
      </div>
      <div className="mt-2 flex flex-col gap-1.5 sm:flex-row sm:items-end sm:gap-3">
        <Select
          label="When"
          className="sm:w-60"
          value={s.mode}
          onChange={(mode) => onChange({ ...s, mode: mode as SkillsetEntryView['mode'] })}
          options={MODE.map((m) => ({ value: m.value, label: m.label }))}
          disabled={disabled}
        />
        {s.review !== 'approved' && s.mode !== 'off' && !s.missing && (
          <Link to={`/admin/pools/skills/review/${s.versionId}`} className="pb-2.5 text-[12.5px] font-semibold text-accent hover:underline">
            Review it
          </Link>
        )}
      </div>
      {s.allowedTools && s.mode !== 'off' && (
        <SwitchRow
          label="Remove pre-approved tools"
          description="Pre-approval only; commands still need review."
          checked={s.stripAllowedTools}
          onChange={(stripAllowedTools) => onChange({ ...s, stripAllowedTools })}
          disabled={disabled}
        />
      )}
    </div>
  );
}

function AddSkillsDialog({
  open,
  library,
  taken,
  onClose,
  onAdd,
}: {
  open: boolean;
  library: SkillLibrary | null;
  taken: SkillsetEntryView[];
  onClose: () => void;
  onAdd: (picked: SkillVersionSummary[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) {
      setQuery('');
      setPicked(new Set());
    }
  }, [open]);
  const names = new Set(taken.map((t) => t.name));
  const ids = new Set(taken.map((t) => t.versionId));
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (library?.versions ?? [])
      .filter((v) => v.review !== 'revoked' && v.review !== 'rejected')
      .filter((v) => !q || v.name.toLowerCase().includes(q) || v.description.toLowerCase().includes(q))
      .sort((a, b) => Number(b.review === 'approved') - Number(a.review === 'approved') || a.name.localeCompare(b.name));
  }, [library, query]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add skills"
      description="Library skills. One that needs review makes the revision wait."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={picked.size === 0} onClick={() => onAdd((library?.versions ?? []).filter((v) => picked.has(v.id)))}>
            {picked.size ? `Add ${picked.size}` : 'Add'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField label="Search" placeholder="Name or description" prefix={<Search className="size-4" />} value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
        {!library ? (
          <RowsSkeleton rows={3} lines={1} trailing={false} />
        ) : rows.length === 0 ? (
          <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">
            {library.versions.length === 0 ? (
              <>
                The library is empty. <Link to="/admin/pools/skills/library" className="font-semibold text-accent">Import skills</Link> first.
              </>
            ) : (
              'No skill matches.'
            )}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line">
            {rows.map((v) => {
              const inSet = ids.has(v.id);
              const clash = !inSet && names.has(v.name);
              return (
                <li key={v.id} className="px-3.5">
                  <Check checked={picked.has(v.id) || inSet} disabled={inSet || clash} onChange={(on) => setPicked((s) => (on ? new Set(s).add(v.id) : new Set([...s].filter((x) => x !== v.id))))}>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-semibold" style={{ fontFamily: MONO }}>
                        {v.name}
                      </span>
                      <Badge tone={REVIEW[v.review].tone}>{REVIEW[v.review].label}</Badge>
                      {v.scripted && <Badge tone="warning">Scripted</Badge>}
                    </span>
                    {v.description && <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-muted">{v.description}</span>}
                    {inSet && <span className="mt-0.5 block text-[12px] text-muted">Already in this set</span>}
                    {clash && <span className="mt-0.5 block text-[12px] text-muted">The set has a skill with this name</span>}
                  </Check>
                </li>
              );
            })}
          </ul>
        )}
        <p className="flex items-center gap-1.5 text-[12px] text-muted">
          <Sparkles className="size-3.5" /> {library?.versions.length ?? 0} in the library
        </p>
      </div>
    </Dialog>
  );
}
