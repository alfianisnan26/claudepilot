import { Badge, Button, useToast } from '@isnanme/ui';
import type { ContextContent, PersonaContent, PoolSummary } from '@portal/contracts';
import { GitCompare, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { errorText } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { personasApi, type PersonaRevision } from './api';
import { LineDiff } from './Diff';
import { Disclosure, MONO } from './parts';

/** What differs between two personas besides their instructions, one short phrase each: "model sonnet → opus", "+style Verbose". */
export function partsChanges(from: PersonaContent, to: PersonaContent): string[] {
  const out: string[] = [];
  const names = (a: { name: string }[], b: { name: string }[], what: string) => {
    const a1 = new Set(a.map((x) => x.name));
    const b1 = new Set(b.map((x) => x.name));
    for (const n of b1) if (!a1.has(n)) out.push(`+${what} ${n}`);
    for (const n of a1) if (!b1.has(n)) out.push(`−${what} ${n}`);
  };
  names(from.styles, to.styles, 'style');
  names(from.agents, to.agents, 'subagent');
  for (const s of to.styles) {
    const was = from.styles.find((x) => x.name === s.name);
    if (was && JSON.stringify(was) !== JSON.stringify(s)) out.push(`style ${s.name} changed`);
  }
  for (const a of to.agents) {
    const was = from.agents.find((x) => x.name === a.name);
    if (was && JSON.stringify(was) !== JSON.stringify(a)) out.push(`subagent ${a.name} changed`);
  }
  if (from.defaultStyle !== to.defaultStyle) out.push(`default style ${from.defaultStyle ?? 'none'} → ${to.defaultStyle ?? 'none'}`);
  if (from.model !== to.model) out.push(`model ${from.model ?? 'default'} → ${to.model ?? 'default'}`);
  if (from.effort !== to.effort) out.push(`effort ${from.effort ?? 'default'} → ${to.effort ?? 'default'}`);
  if (JSON.stringify(from.contexts) !== JSON.stringify(to.contexts)) out.push('contexts changed');
  if (from.chatPrompt !== to.chatPrompt) out.push('chat prompt changed');
  return out;
}

const textOf = (c: PersonaContent | ContextContent): string => ('instructions' in c ? c.instructions : c.body);

/**
 * A persona's or context's revisions (Persona PRD §14, P3): what each one said, a diff between it and what the
 * editor holds now, and a restore that puts it back in the editor to be saved or published. History is never
 * rewritten: restoring and publishing makes a new revision that equals the old one.
 */
export function HistoryPanel<C extends PersonaContent | ContextContent>({ pool, value, onRestore }: { pool: PoolSummary; value: C; onRestore: (content: C) => void }) {
  const toast = useToast();
  const [list, setList] = useState<PersonaRevision[] | null>(null);
  const [shown, setShown] = useState<{ revision: number; content: C } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const open = (isOpen: boolean) => {
    if (isOpen && !list) personasApi.revisions(pool.id).then(setList, (e: unknown) => toast(errorText(e, 'Could not load the history.'), 'error'));
  };
  const fetchContent = async (r: number) => (await personasApi.revision<C>(pool.id, r)).content;
  const compare = async (r: number) => {
    if (shown?.revision === r) return setShown(null);
    setBusy(r);
    try {
      setShown({ revision: r, content: await fetchContent(r) });
    } catch (e) {
      toast(errorText(e, 'Could not load it.'), 'error');
    } finally {
      setBusy(null);
    }
  };
  const restore = async (r: number) => {
    setBusy(r);
    try {
      onRestore(await fetchContent(r));
      toast(`r${r} is in the editor: save or publish it`);
    } catch (e) {
      toast(errorText(e, 'Could not load it.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Disclosure summary={<span className="text-sm font-semibold">History</span>} onOpenChange={open}>
      {!list ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {list.map((r) => (
            <li key={r.revision} className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-[12.5px] font-semibold text-ink-soft" style={{ fontFamily: MONO }}>
                  r{r.revision}
                </span>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                  {r.current ? <Badge tone="success">Current</Badge> : r.status !== 'deliverable' && <Badge>Draft</Badge>}
                  <span className="text-[12px] text-muted">{timeAgo(r.createdAt)}</span>
                  {r.note && <span className="min-w-0 truncate text-[12.5px] text-ink-soft">{r.note}</span>}
                </div>
                <Button size="sm" variant="ghost" aria-label={`Compare r${r.revision} with the editor`} title="Compare with the editor" icon={<GitCompare className="size-4" />} onClick={() => void compare(r.revision)} loading={busy === r.revision} />
                <Button size="sm" variant="ghost" aria-label={`Restore r${r.revision} into the editor`} title="Restore into the editor" icon={<RotateCcw className="size-4" />} onClick={() => void restore(r.revision)} disabled={busy === r.revision} />
              </div>
              {shown?.revision === r.revision && (
                <div className="flex flex-col gap-2">
                  <LineDiff before={textOf(shown.content)} after={textOf(value)} max={30} />
                  {'instructions' in shown.content && 'instructions' in value && (
                    <ul className="flex flex-wrap gap-1.5 text-[12px] text-ink-soft">
                      {partsChanges(shown.content, value).map((c) => (
                        <li key={c} className="rounded-full bg-surface-2 px-2.5 py-0.5">
                          {c}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Disclosure>
  );
}
