import { RowsSkeleton } from '@isnanme/ui';
import type { VaultHealth } from '@portal/contracts';
import { ChevronDown } from 'lucide-react';
import { InfoTip } from '@/components/InfoTip';
import { knowledgeApi } from './api';
import { useLoad } from './hooks';

function Group({ title, count, tip, children }: { title: string; count: number; tip?: string; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <details className="group rounded-2xl border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-3 text-[14.5px] font-semibold">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {tip && <InfoTip label={title}>{tip}</InfoTip>}
        <span className="text-[13px] font-medium text-muted">{count}</span>
        <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="border-t border-line px-1.5 py-1.5">{children}</div>
    </details>
  );
}

const Row = ({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) => (
  <button type="button" onClick={onClick} className="press flex w-full min-w-0 flex-col rounded-xl px-2.5 py-2 text-left hover:bg-surface-2/70">
    {children}
  </button>
);

/** Links that don't resolve, names that repeat, notes nothing links to: what to tidy. */
export function HealthPane({ vaultId, tick, onOpen }: { vaultId: string; tick: number; onOpen: (path: string) => void }) {
  const h = useLoad<VaultHealth>(`health|${vaultId}|${tick}`, () => knowledgeApi.health(vaultId));
  if (!h.data)
    return (
      <div className="p-4">
        <RowsSkeleton rows={4} lines={1} />
      </div>
    );
  const d = h.data;
  const total = d.unresolved.length + d.ambiguous.length + d.anchors.length + d.embeds.length + d.orphans.length + d.duplicates.length + d.issues.length;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 p-3 sm:p-5">
      {total === 0 && <p className="py-10 text-center text-[14px] text-muted">All links resolve</p>}
      <Group title="Unresolved links" count={d.unresolved.length} tip="Links to notes that don’t exist.">
        {d.unresolved.map((u) => (
          <Row key={u.target} onClick={() => u.sources[0] && onOpen(u.sources[0])}>
            <span className="truncate text-[14px] font-medium">{u.target}</span>
            <span className="truncate text-[12.5px] text-muted">
              {u.count}× · {u.sources.join(', ')}
            </span>
          </Row>
        ))}
      </Group>
      <Group title="Same name" count={d.duplicates.length} tip="Notes sharing a name: links to the name pick the nearest one.">
        {d.duplicates.map((x) => (
          <div key={x.name} className="px-2.5 py-2">
            <div className="text-[14px] font-medium">{x.name}</div>
            {x.paths.map((p) => (
              <Row key={p} onClick={() => onOpen(p)}>
                <span className="truncate text-[12.5px] text-muted">{p}</span>
              </Row>
            ))}
          </div>
        ))}
      </Group>
      <Group title="Ambiguous links" count={d.ambiguous.length} tip="Links whose name more than one note has.">
        {d.ambiguous.map((u) => (
          <Row key={u.target} onClick={() => u.sources[0] && onOpen(u.sources[0])}>
            <span className="truncate text-[14px] font-medium">{u.target}</span>
            <span className="truncate text-[12.5px] text-muted">{u.count}× · {u.sources.join(', ')}</span>
          </Row>
        ))}
      </Group>
      <Group title="Missing headings" count={d.anchors.length}>
        {d.anchors.map((a, i) => (
          <Row key={i} onClick={() => onOpen(a.path)}>
            <span className="truncate text-[14px] font-medium">
              {a.target}#{a.heading ?? `^${a.block}`}
            </span>
            <span className="truncate text-[12.5px] text-muted">
              {a.path}:{a.line}
            </span>
          </Row>
        ))}
      </Group>
      <Group title="Broken embeds" count={d.embeds.length}>
        {d.embeds.map((a, i) => (
          <Row key={i} onClick={() => onOpen(a.path)}>
            <span className="truncate text-[14px] font-medium">{a.target}</span>
            <span className="truncate text-[12.5px] text-muted">
              {a.path}:{a.line}
            </span>
          </Row>
        ))}
      </Group>
      <Group title="Orphans" count={d.orphans.length} tip="Notes with no links in or out.">
        {d.orphans.map((p) => (
          <Row key={p} onClick={() => onOpen(p)}>
            <span className="truncate text-[14px]">{p}</span>
          </Row>
        ))}
      </Group>
      <Group title="Skipped files" count={d.issues.length} tip="Files the scan left out: links, case clashes, unsupported types.">
        {d.issues.map((i) => (
          <div key={`${i.kind}|${i.path}`} className="px-2.5 py-1.5">
            <div className="truncate text-[13.5px]">{i.path || '(vault)'}</div>
            <div className="text-[12.5px] text-muted">
              {i.kind} · {i.detail}
            </div>
          </div>
        ))}
      </Group>
    </div>
  );
}
