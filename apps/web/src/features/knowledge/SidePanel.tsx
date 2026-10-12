import { Button, RowsSkeleton, Segmented } from '@isnanme/ui';
import type { NoteView, VaultSummary } from '@portal/contracts';
import { AlertTriangle, Bot, FileText, Plus } from 'lucide-react';
import { useState } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { formatBytes, formatDateTime, timeAgo } from '@/lib/format';
import { knowledgeApi } from './api';
import { useLoad } from './hooks';
import { actorLabel } from './labels';
import { LocalGraph } from './LocalGraph';

type Tab = 'links' | 'graph' | 'outline' | 'info';

const label = (path: string) => path.replace(/\.md$/i, '').split('/').pop()!;

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="mb-3">
      <h3 className="px-2.5 pb-1 text-[12px] font-semibold tracking-wide text-muted uppercase">
        {title}
        {count !== undefined && <span className="ml-1.5 font-medium normal-case">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/** What surrounds the open note: what links to it, where it points, its headings and its properties. */
export function SidePanel({
  vault,
  note,
  onOpen,
  onCreate,
  onHeading,
  onGraph,
}: {
  vault: VaultSummary;
  note: NoteView;
  onOpen: (path: string) => void;
  onCreate: (name: string) => void;
  onHeading: (text: string) => void;
  /** The whole graph, around this note. */
  onGraph: () => void;
}) {
  const [tab, setTab] = useState<Tab>('links');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pt-2 pb-2">
        <Segmented
          label="Panel"
          value={tab}
          options={[
            { value: 'links', label: 'Links' },
            { value: 'graph', label: 'Graph' },
            { value: 'outline', label: 'Outline' },
            { value: 'info', label: 'Info' },
          ]}
          onChange={setTab}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 [scrollbar-width:thin]">
        {tab === 'links' && <Links vault={vault} note={note} onOpen={onOpen} onCreate={onCreate} />}
        {tab === 'graph' && <LocalGraph vault={vault} note={note} onOpen={onOpen} onExpand={onGraph} />}
        {tab === 'outline' && <Outline note={note} onHeading={onHeading} />}
        {tab === 'info' && <Info vault={vault} note={note} onOpen={onOpen} />}
      </div>
    </div>
  );
}

const rowCls = 'press flex w-full min-w-0 items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[14px] hover:bg-surface-2/70';

function Links({ vault, note, onOpen, onCreate }: { vault: VaultSummary; note: NoteView; onOpen: (p: string) => void; onCreate: (n: string) => void }) {
  const back = useLoad(`back|${vault.id}|${note.path}|${note.version}`, () => knowledgeApi.backlinks(vault.id, note.path));
  const sources = [...new Map((back.data ?? []).map((b) => [b.path, b])).values()];
  const out = [...new Map(note.links.filter((l) => !l.entity && l.target && l.to !== note.path).map((l) => [`${l.to ?? ''}|${l.target.toLowerCase()}`, l])).values()];
  return (
    <>
      <Section title="Linked from" count={back.data ? sources.length : undefined}>
        {!back.data ? (
          <RowsSkeleton rows={2} lines={1} />
        ) : sources.length === 0 ? (
          <p className="px-2.5 py-1 text-[13px] text-muted">None</p>
        ) : (
          <ul>
            {sources.map((b) => (
              <li key={b.path}>
                <button type="button" onClick={() => onOpen(b.path)} className={rowCls}>
                  <FileText className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Links to" count={out.length}>
        {out.length === 0 ? (
          <p className="px-2.5 py-1 text-[13px] text-muted">None</p>
        ) : (
          <ul>
            {out.map((l) => (
              <li key={`${l.to ?? ''}|${l.target}`}>
                {l.to ? (
                  <button type="button" onClick={() => onOpen(l.to!)} className={rowCls}>
                    <FileText className="size-4 shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{label(l.to)}</span>
                    {l.anchorMissing && <AlertTriangle className="size-3.5 shrink-0 text-amber-600" aria-label="Heading not found" />}
                  </button>
                ) : (
                  <button type="button" onClick={() => onCreate(l.target)} className={rowCls} title="Create">
                    <Plus className="size-4 shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-muted">{l.target}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Mentions vault={vault} note={note} onOpen={onOpen} />
    </>
  );
}

function Mentions({ vault, note, onOpen }: { vault: VaultSummary; note: NoteView; onOpen: (p: string) => void }) {
  const [asked, setAsked] = useState(false);
  const m = useLoad(`mentions|${vault.id}|${note.path}|${note.version}`, () => knowledgeApi.mentions(vault.id, note.path), asked);
  return (
    <Section title="Unlinked" count={m.data?.length}>
      {!asked ? (
        <div className="px-2">
          <Button size="sm" variant="secondary" onClick={() => setAsked(true)}>
            Find mentions
          </Button>
        </div>
      ) : !m.data ? (
        <RowsSkeleton rows={2} lines={1} />
      ) : m.data.length === 0 ? (
        <p className="px-2.5 py-1 text-[13px] text-muted">None</p>
      ) : (
        <ul>
          {m.data.map((x) => (
            <li key={x.path}>
              <button type="button" onClick={() => onOpen(x.path)} className={rowCls}>
                <FileText className="size-4 shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{x.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Outline({ note, onHeading }: { note: NoteView; onHeading: (text: string) => void }) {
  if (note.headings.length === 0) return <p className="px-2.5 py-3 text-[13px] text-muted">No headings</p>;
  const min = Math.min(...note.headings.map((h) => h.level));
  return (
    <ul>
      {note.headings.map((h, i) => (
        <li key={`${h.line}|${i}`}>
          <button type="button" onClick={() => onHeading(h.text)} style={{ paddingLeft: `${0.625 + (h.level - min) * 0.875}rem` }} className="press flex w-full min-w-0 items-center rounded-xl py-1.5 pr-2.5 text-left text-[14px] hover:bg-surface-2/70">
            <span className="truncate">{h.text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Value({ v }: { v: unknown }) {
  if (Array.isArray(v))
    return (
      <span className="flex flex-wrap gap-1">
        {v.map((x, i) => (
          <span key={i} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[12.5px]">
            {typeof x === 'object' ? JSON.stringify(x) : String(x)}
          </span>
        ))}
      </span>
    );
  if (typeof v === 'boolean') return <span>{v ? 'Yes' : 'No'}</span>;
  if (v && typeof v === 'object') return <span className="font-mono text-[12.5px] break-all">{JSON.stringify(v)}</span>;
  if (typeof v === 'string' && /^https?:\/\//.test(v))
    return (
      <a href={v} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-accent underline underline-offset-2">
        {v}
      </a>
    );
  return <span className="break-words">{String(v ?? '')}</span>;
}

function Info({ vault, note, onOpen }: { vault: VaultSummary; note: NoteView; onOpen: (p: string) => void }) {
  void vault;
  void onOpen;
  const props = Object.entries(note.frontmatter.props).filter(([k]) => k !== '_truncated');
  return (
    <>
      <Section title="Properties" count={props.length}>
        {note.frontmatter.error && (
          <p className="mx-2.5 mb-1 flex items-center gap-1.5 text-[13px] text-amber-700 dark:text-amber-500">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
            Not valid YAML
            <InfoTip label="Why">{note.frontmatter.error}</InfoTip>
          </p>
        )}
        {props.length === 0 ? (
          !note.frontmatter.error && <p className="px-2.5 py-1 text-[13px] text-muted">None</p>
        ) : (
          <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-2.5 text-[13.5px]">
            {props.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="truncate text-muted">{k}</dt>
                <dd className="min-w-0">
                  <Value v={v} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Section>
      <Section title="File">
        <dl className="grid grid-cols-[minmax(0,5rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-2.5 text-[13.5px]">
          <dt className="text-muted">Path</dt>
          <dd className="break-all">{note.path}</dd>
          <dt className="text-muted">Size</dt>
          <dd>{formatBytes(note.size)}</dd>
          <dt className="text-muted">Changed</dt>
          <dd title={formatDateTime(note.mtime)}>{timeAgo(note.mtime)}</dd>
          {note.author && (
            <>
              <dt className="text-muted">By</dt>
              <dd className="flex items-center gap-1.5">
                {actorLabel(note.author.actor)}
                {note.author.kind === 'agent' && <Bot className="size-3.5 text-muted" aria-hidden="true" />}
              </dd>
            </>
          )}
        </dl>
      </Section>
    </>
  );
}
