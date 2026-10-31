import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUSES,
  TICKET_STATUS_LABEL,
  TICKET_TYPES,
  TICKET_TYPE_LABEL,
  type ReporterTicket,
  type ReporterTicketComment,
  type ReporterTicketList,
  type TicketPriority,
  type TicketType,
} from '@portal/contracts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEPLOY_REASON, OBSERVED_NOTE, SEVERITIES, isObserved, pathnameOf, shortCommit } from '@/features/reporter/shared';
import { usePanel } from './context';
import { Icon } from './icons';
import { Md } from './markdown';
import {
  SORT_LABEL,
  activeFilterCount,
  buildQuery,
  capturesHere,
  effectiveOrder,
  effectiveSort,
  groupByPage,
  parsePrefs,
  playlist,
  samePageHref,
  type ListPrefs,
  type Sort,
} from './model';
import { AuthImg, Btn, Chip, EnvStrip, IconBtn, Notice, PhaseChip, Seg, inputClass } from './ui';

const prefsKey = (bucket: string) => `pilot-reporter:prefs:${bucket}`;

export function TicketsTab() {
  const p = usePanel();
  return p.selected ? <TicketDetail key={p.selected} ticketKey={p.selected} /> : <TicketList />;
}

function TicketList() {
  const { client, bucket, page, tick, select, focus, status, post, focused } = usePanel();
  const [prefs, setPrefsState] = useState<ListPrefs>(() => {
    try {
      return parsePrefs(localStorage.getItem(prefsKey(bucket)));
    } catch {
      return parsePrefs(null);
    }
  });
  const setPrefs = (next: ListPrefs) => {
    setPrefsState(next);
    try {
      localStorage.setItem(prefsKey(bucket), JSON.stringify({ ...next, q: '' }));
    } catch {
      // per-viewer convenience only
    }
  };
  const [list, setList] = useState<ReporterTicketList | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'filter' | 'sort' | null>(null);
  const [q, setQ] = useState(prefs.q);
  const path = page ? safePathname(page.url) : null;

  // Search waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => q !== prefs.q && setPrefsState((cur) => ({ ...cur, q })), 300);
    return () => clearTimeout(t);
  }, [q, prefs.q]);

  useEffect(() => {
    let live = true;
    client.tickets(buildQuery(prefs, path)).then(
      (l) => {
        if (!live) return;
        setList(l);
        setFailed(null);
      },
      (e: Error) => live && setFailed(e.message),
    );
    return () => {
      live = false;
    };
  }, [client, prefs, path, tick]);

  // Play all: every capture on this page, top to bottom; the host's caption card can also end it.
  const [play, setPlay] = useState<{ items: { key: string; captureId: string }[]; at: number } | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!play) return;
    const item = play.items[play.at];
    if (item) post({ type: 'pilot-reporter:focus', key: item.key, captureId: item.captureId, spotlight: true });
  }, [play, post]);
  useEffect(() => {
    if (focused) started.current = true;
    else if (started.current && play) {
      started.current = false;
      setPlay(null);
    }
  }, [focused, play]);

  const items = list?.items ?? [];
  const env = status.site?.environment ?? null;
  const filters = activeFilterCount(prefs);
  const grouped = prefs.scope === 'grouped' ? groupByPage(items) : null;

  const open = (t: ReporterTicket) => {
    const here = path ? capturesHere(t, path)[0] : undefined;
    focus(t.key, here?.captureId ?? null);
    select(t.key);
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <Seg
        label="Scope"
        value={prefs.scope}
        onChange={(scope) => setPrefs({ ...prefs, scope })}
        options={[
          { value: 'page', label: `This page${list && prefs.scope === 'page' ? ` ${list.counts.onPath || items.length}` : ''}` },
          { value: 'all', label: 'All' },
          { value: 'grouped', label: 'By page' },
        ]}
      />
      <div className="flex items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search</span>
          <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className={`${inputClass} pl-9`} />
        </label>
        <button
          type="button"
          onClick={() => setSheet(sheet === 'filter' ? null : 'filter')}
          aria-expanded={sheet === 'filter'}
          aria-label={`Filter${filters ? `, ${filters} on` : ''}`}
          title="Filter"
          className="relative inline-flex size-11 items-center justify-center rounded-xl bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
        >
          <Icon name="slidersHorizontal" />
          {filters > 0 && <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10.5px] leading-4 font-bold text-primary-ink">{filters}</span>}
        </button>
        <button
          type="button"
          onClick={() => setSheet(sheet === 'sort' ? null : 'sort')}
          aria-expanded={sheet === 'sort'}
          aria-label={`Sort: ${SORT_LABEL[effectiveSort(prefs)]}`}
          title="Sort"
          className="inline-flex size-11 items-center justify-center rounded-xl bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
        >
          <Icon name="arrowUpDown" />
        </button>
      </div>

      {sheet === 'filter' && <FilterSheet prefs={prefs} counts={list?.counts ?? null} onChange={setPrefs} onClose={() => setSheet(null)} />}
      {sheet === 'sort' && <SortSheet prefs={prefs} onChange={setPrefs} onClose={() => setSheet(null)} />}

      {prefs.scope === 'page' && path && items.length > 0 && (
        <div className="flex items-center gap-2">
          {play ? (
            <>
              <IconBtn icon="chevronLeft" label="Previous" disabled={play.at === 0} onClick={() => setPlay({ ...play, at: play.at - 1 })} />
              <span className="flex-1 text-center text-[13px] text-muted tabular-nums">
                {play.at + 1} of {play.items.length}
              </span>
              <IconBtn icon="chevronRight" label="Next" disabled={play.at >= play.items.length - 1} onClick={() => setPlay({ ...play, at: play.at + 1 })} />
              <IconBtn
                icon="square"
                label="Stop"
                onClick={() => {
                  setPlay(null);
                  post({ type: 'pilot-reporter:focus-clear' });
                }}
              />
            </>
          ) : (
            <Btn icon="play" onClick={() => setPlay({ items: playlist(items, path), at: 0 })} className="w-full">
              Play all
            </Btn>
          )}
        </div>
      )}

      {failed && <Notice tone="error">{failed}</Notice>}
      {!list && !failed && <div className="skeleton h-32 rounded-2xl" aria-busy="true" />}
      {list && items.length === 0 && <p className="py-6 text-center text-[13.5px] text-muted">{prefs.scope === 'page' ? 'Nothing reported on this page.' : 'No tickets.'}</p>}

      {grouped
        ? grouped.map((g) => (
            <section key={g.path} className="flex flex-col gap-1">
              <h2 className="px-1 text-[12.5px] font-semibold break-all text-muted">{g.path || 'No page'}</h2>
              <ul className="flex flex-col gap-1">
                {g.items.map((t) => (
                  <Row key={t.key} t={t} path={path} env={env} onOpen={() => open(t)} />
                ))}
              </ul>
            </section>
          ))
        : list && (
            <ul className="flex flex-col gap-1">
              {items.map((t) => (
                <Row key={t.key} t={t} path={path} env={env} onOpen={() => open(t)} />
              ))}
            </ul>
          )}
    </div>
  );
}

function Row({ t, path, env, onOpen }: { t: ReporterTicket; path: string | null; env: string | null; onOpen: () => void }) {
  const { client } = usePanel();
  const here = path ? capturesHere(t, path) : [];
  const thumb = (here[0] ?? t.captures[0])?.screenshotUrl ?? null;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-3 rounded-xl p-2 text-left hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
      >
        <AuthImg client={client} src={thumb} alt="" className="size-14 shrink-0 rounded-lg" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-[12px] text-muted">
            <span className="font-semibold tabular-nums">{t.key}</span>
            <span aria-hidden="true">·</span>
            <span>{TICKET_PRIORITY_LABEL[t.priority]}</span>
            {t.captures.length > 1 && <span className="rounded-full bg-surface-2 px-1.5 tabular-nums">{t.captures.length} shots</span>}
            {t.target.kind === 'session' && <span className="font-semibold text-danger">Urgent</span>}
            {t.awaitingReporter && <span className="ml-auto size-2 rounded-full bg-danger" aria-label="Waiting for your reply" />}
            {!t.awaitingReporter && t.unread > 0 && <span className="ml-auto rounded-full bg-accent px-1.5 text-[11px] font-bold text-primary-ink tabular-nums">{t.unread}</span>}
          </span>
          <span className="line-clamp-2 text-[14px] font-semibold break-words">{t.summary}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <PhaseChip phase={t.phase} />
            <EnvStrip deployments={t.deployments} current={env} />
          </span>
        </span>
      </button>
    </li>
  );
}

function SheetFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[14px] font-bold">{title}</h2>
        <IconBtn icon="x" label="Done" onClick={onClose} />
      </div>
      {children}
    </div>
  );
}

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function FilterSheet({ prefs, counts, onChange, onClose }: { prefs: ListPrefs; counts: ReporterTicketList['counts'] | null; onChange: (p: ListPrefs) => void; onClose: () => void }) {
  const [tag, setTag] = useState('');
  const statusOptions: { value: ListPrefs['status']; label: string }[] = [
    { value: 'open', label: 'Open' },
    { value: 'closed', label: 'Closed' },
    { value: 'all', label: 'All' },
    // 'open' as a query means every open status (the contract's group), so the status itself is not offered twice.
    ...TICKET_STATUSES.filter((s) => s !== 'open').map((s) => ({ value: s, label: TICKET_STATUS_LABEL[s] })),
  ];
  return (
    <SheetFrame title="Filter" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Group label="Status">
          {statusOptions.map((o) => (
            <Chip key={o.value} on={prefs.status === o.value} onClick={() => onChange({ ...prefs, status: o.value })} count={counts?.status[o.value]}>
              {o.label}
            </Chip>
          ))}
        </Group>
        <Group label="Priority">
          {TICKET_PRIORITIES.map((v) => (
            <Chip key={v} on={prefs.priority.includes(v)} onClick={() => onChange({ ...prefs, priority: toggle<TicketPriority>(prefs.priority, v) })} count={counts?.priority[v]}>
              {TICKET_PRIORITY_LABEL[v]}
            </Chip>
          ))}
        </Group>
        <Group label="Type">
          {TICKET_TYPES.map((v) => (
            <Chip key={v} on={prefs.type.includes(v)} onClick={() => onChange({ ...prefs, type: toggle<TicketType>(prefs.type, v) })} count={counts?.type[v]}>
              {TICKET_TYPE_LABEL[v]}
            </Chip>
          ))}
        </Group>
        <Group label="Tags">
          {prefs.tags.map((t) => (
            <Chip key={t} on onClick={() => onChange({ ...prefs, tags: prefs.tags.filter((x) => x !== t) })}>
              {t} ×
            </Chip>
          ))}
          <form
            className="flex min-w-0 flex-1 gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const v = tag.trim().toLowerCase();
              if (v && !prefs.tags.includes(v)) onChange({ ...prefs, tags: [...prefs.tags, v] });
              setTag('');
            }}
          >
            <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Add tag" aria-label="Add tag" className={`${inputClass} min-w-24 flex-1`} autoCapitalize="none" />
          </form>
        </Group>
        <Group label="Who">
          <Chip on={prefs.mine} onClick={() => onChange({ ...prefs, mine: !prefs.mine })}>
            Mine
          </Chip>
        </Group>
        {activeFilterCount(prefs) > 0 && (
          <Btn tone="ghost" onClick={() => onChange({ ...prefs, status: 'open', priority: [], type: [], tags: [], mine: false })}>
            Clear filters
          </Btn>
        )}
      </div>
    </SheetFrame>
  );
}

function SortSheet({ prefs, onChange, onClose }: { prefs: ListPrefs; onChange: (p: ListPrefs) => void; onClose: () => void }) {
  const sorts = (Object.keys(SORT_LABEL) as Sort[]).filter((s) => s !== 'position' || prefs.scope === 'page');
  const current = effectiveSort(prefs);
  return (
    <SheetFrame title="Sort" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          {sorts.map((s) => (
            <Chip key={s} on={current === s} onClick={() => onChange({ ...prefs, sort: s, order: null })}>
              {SORT_LABEL[s]}
            </Chip>
          ))}
        </div>
        <Seg
          label="Order"
          value={effectiveOrder(prefs)}
          onChange={(order) => onChange({ ...prefs, sort: current, order })}
          options={[
            { value: 'asc', label: current === 'position' ? 'Top first' : 'Oldest first' },
            { value: 'desc', label: current === 'position' ? 'Bottom first' : 'Newest first' },
          ]}
        />
      </div>
    </SheetFrame>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-[12.5px] font-semibold text-muted">{label}</legend>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </fieldset>
  );
}

/** The ticket card: status, where it stands per environment, its captures (each one focusable on the page) and the thread. */
function TicketDetail({ ticketKey }: { ticketKey: string }) {
  const { client, select, page, focus, missing, origin, tick, status, post } = usePanel();
  const [t, setT] = useState<ReporterTicket | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [thread, setThread] = useState<ReporterTicketComment[] | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const path = page ? safePathname(page.url) : null;

  useEffect(() => {
    let live = true;
    client.ticket(ticketKey).then(
      (v) => live && (setT(v), setFailed(null)),
      (e: Error) => live && setFailed(e.message),
    );
    // Reading the thread marks it read.
    client.comments(ticketKey).then(
      (c) => live && setThread(c),
      () => live && setThread([]),
    );
    return () => {
      live = false;
    };
  }, [client, ticketKey, tick]);

  const back = () => {
    select(null);
    post({ type: 'pilot-reporter:focus-clear' });
  };
  const send = async () => {
    if (!reply.trim()) return;
    setSending(true);
    try {
      await client.reply(ticketKey, reply.trim());
      setReply('');
      setThread(await client.comments(ticketKey));
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const env = status.site?.environment ?? null;
  const missingHere = missing && missing.key === ticketKey ? missing : null;
  const missingCapture = missingHere?.captureId ? t?.captures.find((c) => c.captureId === missingHere.captureId) : undefined;
  const otherPage = missingHere?.reason === 'other-page' ? (missingCapture ?? (t && path ? t.captures.find((c) => pathnameOf(c.anchor.path) !== pathnameOf(path)) : undefined)) : undefined;
  const otherHref = otherPage ? samePageHref(origin, otherPage.anchor.path) : null;
  const orderedThread = useMemo(() => [...(thread ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [thread]);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-1">
        <IconBtn icon="chevronLeft" label="Back" onClick={back} />
        <span className="flex-1 text-[13px] font-semibold text-muted tabular-nums">{ticketKey}</span>
        {t && (
          <a href={t.url} target="_blank" rel="noopener noreferrer" aria-label="Open in pilot" title="Open in pilot" className="inline-flex size-11 items-center justify-center rounded-xl focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
            <Icon name="externalLink" />
          </a>
        )}
      </div>
      {failed && <Notice tone="error">{failed}</Notice>}
      {!t && !failed && <div className="skeleton h-40 rounded-2xl" aria-busy="true" />}
      {t && (
        <>
          <div>
            <h2 className="text-[16px] font-bold break-words">{t.summary}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
              <PhaseChip phase={t.phase} />
              <span>{TICKET_STATUS_LABEL[t.status]}</span>
              <span>{TICKET_PRIORITY_LABEL[t.priority]}</span>
              {t.site && <span>reported on {t.site.environment}</span>}
            </div>
          </div>

          {t.target.kind === 'session' &&
            (t.target.status === 'delivery-failed' ? (
              <Notice tone="error">
                <strong>{t.target.label}</strong> did not get this report; the ticket is kept in the queue.
              </Notice>
            ) : (
              <Notice tone="info">
                Sent to <strong>{t.target.label}</strong> · {t.target.status}
              </Notice>
            ))}
          {t.site?.declaredMismatch && (
            <Notice tone="error">
              The page declared {t.site.declaredMismatch.repo ?? t.site.repo} / {t.site.declaredMismatch.environment ?? t.site.environment}; the site record says {t.site.repo} / {t.site.environment}.
            </Notice>
          )}

          <section className="rounded-2xl border border-line p-3">
            <h3 className="mb-1.5 text-[12.5px] font-semibold text-muted">Deployed</h3>
            {t.deployments.length === 0 ? (
              <p className="text-[13px] text-muted">Unknown: no environment of this repo is known yet.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-[13px]">
                {t.deployments.map((d) => (
                  <li key={d.environment} className={`flex flex-wrap items-baseline gap-x-2 ${d.environment === env ? 'font-semibold' : ''}`}>
                    <span className="w-12 shrink-0">{d.environment}</span>
                    <span className={d.status === 'deployed' ? 'text-accent' : d.status === 'not-deployed' ? 'text-danger' : 'text-muted'}>
                      {d.status === 'deployed' ? (isObserved(d) ? 'Deployed*' : 'Deployed') : d.status === 'not-deployed' ? 'Not yet' : 'Unknown'}
                    </span>
                    <span className="min-w-0 text-[12px] font-normal break-words text-muted">
                      {d.status === 'unknown' && d.reason ? DEPLOY_REASON[d.reason] : d.currentCommit ? `live ${shortCommit(d.currentCommit)}${isObserved(d) ? ` · ${OBSERVED_NOTE}` : ''}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {t.fixCommits.length > 0 && <p className="mt-1.5 text-[12px] break-all text-muted">Fix {t.fixCommits.map((c) => shortCommit(c)).join(', ')}</p>}
          </section>

          {SEVERITIES.some((s) => t.checkCounts[s] > 0) && (
            <p className="flex flex-wrap gap-1.5 text-[12px]">
              {SEVERITIES.filter((s) => t.checkCounts[s] > 0).map((s) => (
                <span key={s} className={`rounded-full px-2 py-0.5 font-semibold ${s === 'critical' || s === 'serious' ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-ink-soft'}`}>
                  {t.checkCounts[s]} {s}
                </span>
              ))}
            </p>
          )}

          {t.captures.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-[12.5px] font-semibold text-muted">Shots</h3>
              <ul className="flex gap-2 overflow-x-auto pb-1">
                {t.captures.map((c) => (
                  <li key={c.captureId} className="shrink-0">
                    <button type="button" onClick={() => focus(t.key, c.captureId)} className="flex w-28 flex-col gap-1 rounded-xl p-1 text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden" aria-label={`Show shot ${c.index} on the page`}>
                      <AuthImg client={client} src={c.screenshotUrl} alt={`Shot ${c.index}`} className="h-20 w-full rounded-lg" />
                      <span className="truncate text-[11.5px] text-muted">
                        {c.index} · {pathnameOf(c.anchor.path)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {missingHere && (
            <Notice tone="info">
              {missingHere.reason === 'other-page' ? 'That shot is on another page.' : 'That area is not on the page any more.'}
              {otherHref && (
                <button type="button" className="ml-2 font-semibold text-accent underline" onClick={() => window.open(otherHref, '_top')}>
                  Open that page
                </button>
              )}
            </Notice>
          )}

          {t.repro && t.repro.steps.length > 0 && (
            <details className="rounded-2xl border border-line p-3">
              <summary className="flex min-h-11 cursor-pointer items-center text-[13px] font-semibold">Steps</summary>
              <ol className="mt-2 list-decimal pl-5 text-[13px]">
                {t.repro.steps.map((s, i) => (
                  <li key={i} className="break-words">
                    {s}
                  </li>
                ))}
              </ol>
            </details>
          )}

          <section className="flex flex-col gap-2">
            <h3 className="text-[12.5px] font-semibold text-muted">Thread</h3>
            {thread === null && <div className="skeleton h-16 rounded-xl" aria-busy="true" />}
            {thread && orderedThread.length === 0 && <p className="text-[13px] text-muted">No comments yet.</p>}
            {orderedThread.map((c) => (
              <article key={c.id} className={`rounded-xl p-2.5 text-[13.5px] ${c.authorKind === 'reporter' ? 'bg-accent-soft' : 'bg-surface-2'}`}>
                <p className="mb-1 text-[12px] font-semibold text-muted">
                  {c.authorKind === 'agent' && <Icon name="bot" className="mr-1 inline size-3.5" />}
                  {c.author}
                </p>
                <Md text={c.body} />
              </article>
            ))}
            <div className="sticky bottom-0 flex items-end gap-2 bg-bg pt-1 pb-[env(safe-area-inset-bottom)]">
              <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} maxLength={4000} placeholder="Reply" aria-label="Reply" className={`${inputClass} min-h-11 flex-1 resize-none`} />
              <IconBtn icon="send" label="Send reply" disabled={!reply.trim() || sending} onClick={() => void send()} className="bg-primary text-primary-ink" />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function safePathname(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}
