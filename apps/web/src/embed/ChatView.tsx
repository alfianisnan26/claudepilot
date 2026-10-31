import { REPORTER_LIMITS, type ReporterChatMessage, type ReporterChatState } from '@portal/contracts';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { chatStatus, mergeLines, newUuid, sessionTitle } from './chatModel';
import { Composer } from './Composer';
import { usePanel, type ChatOpen } from './context';
import { useBottomList } from './hooks';
import { Icon } from './icons';
import { Md } from './markdown';
import { AuthImg, IconBtn, Notice } from './ui';
import { Viewer } from './Viewer';

const toBase64 = async (b: Blob): Promise<string> => {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The current shot as a chat image, when it is a type and size a chat takes (else it is not offered). */
async function chatImage(b: Blob | null) {
  if (!b || !/^image\/(png|jpeg|webp)$/.test(b.type) || b.size > 3_750_000) return null;
  return { mediaType: b.type as 'image/png' | 'image/jpeg' | 'image/webp', dataBase64: await toBase64(b) };
}

/**
 * Chat in the widget (PILOT-1111): one session of the bucket, newest first loaded and older on scroll up, live while open (the session's
 * stream, polling while it is down), and a composer that sends as the token's person. Approvals are never answered here: a banner links
 * out to pilot. A direct ask lands here with its ticket as a header chip, and a failed delivery stays visible with Retry.
 */
export function ChatView({ open, onBack }: { open: ChatOpen; onBack: () => void }) {
  const { client, coarse, capture, select, setTab, openChat, notify } = usePanel();
  const id = open.sessionId;
  const [lines, setLines] = useState<ReporterChatMessage[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [session, setSession] = useState<ReporterChatState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [attach, setAttach] = useState(false);
  const [pending, setPending] = useState<{ uuid: string; text: string }[]>([]);
  const [view, setView] = useState<string | null>(null);
  const [lateFail, setLateFail] = useState<string | null>(null);
  const lastSeq = useRef(0);
  const loadingOlder = useRef(false);
  const list = useRef<HTMLDivElement>(null);

  const take = useCallback((items: ReporterChatMessage[], s: ReporterChatState) => {
    setSession(s);
    if (items.length) {
      setLines((cur) => mergeLines(cur, items));
      lastSeq.current = Math.max(lastSeq.current, ...items.map((m) => m.seq));
      // A sent message is shown once it is in the transcript.
      setPending((p) => (p.length ? p.filter((x) => !items.some((m) => m.kind === 'user' && m.text === x.text)) : p));
    }
    lastSeq.current = Math.max(lastSeq.current, s.lastSeq);
  }, []);

  // The newest page.
  useEffect(() => {
    let live = true;
    client.chatPage(id, { limit: REPORTER_LIMITS.chatPage }).then(
      (p) => {
        if (!live) return;
        setLines(p.items);
        setBefore(p.before);
        setSession(p.session);
        lastSeq.current = Math.max(p.session.lastSeq, ...p.items.map((m) => m.seq), 0);
      },
      (e: { status?: number; message: string }) => {
        if (!live) return;
        if (e.status === 404) setGone(true);
        else setFailed(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, [client, id]);

  // Live: the stream while it is up, a poll every 5 s while it is down.
  useEffect(() => {
    if (gone) return;
    const ctl = new AbortController();
    let up = false;
    let backoff = 2000;
    const run = async () => {
      while (!ctl.signal.aborted) {
        try {
          up = true;
          await client.chatStream(
            id,
            lastSeq.current,
            (l) => {
              backoff = 2000;
              if (l.type === 'update') take(l.items, l.session);
              else if (l.type === 'hello') setSession(l.session);
              else if (l.type === 'gone') setGone(true);
            },
            ctl.signal,
          );
        } catch (e) {
          if ((e as { status?: number }).status === 404) return setGone(true);
        }
        up = false;
        if (ctl.signal.aborted) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    };
    void run();
    const poll = setInterval(() => {
      if (up || document.visibilityState === 'hidden') return;
      client.chatPage(id, { after: lastSeq.current }).then((p) => take(p.items, p.session), () => undefined);
    }, 5000);
    return () => {
      ctl.abort();
      clearInterval(poll);
    };
  }, [client, id, gone, take]);

  const { atBottom, jump, older } = useBottomList(list, lines.length + pending.length, () => {
    if (before === null || loadingOlder.current) return;
    loadingOlder.current = true;
    client.chatPage(id, { before, limit: REPORTER_LIMITS.chatPage }).then(
      (p) => {
        older();
        setLines((cur) => mergeLines(cur, p.items));
        setBefore(p.before);
        loadingOlder.current = false;
      },
      () => {
        loadingOlder.current = false;
      },
    );
  });

  const send = async (body: string, image: Blob | null) => {
    const uuid = newUuid();
    setSending(true);
    setPending((p) => [...p, { uuid, text: body }]);
    try {
      await client.chatSend(id, { uuid, text: body, image: await chatImage(image) });
      jump();
      return true;
    } catch (e) {
      setPending((p) => p.filter((x) => x.uuid !== uuid));
      notify((e as Error).message, 'error');
      return false;
    } finally {
      setSending(false);
    }
  };

  // A direct ask is delivered in the background (it waits for its files): watch the ticket for a minute so a failure shows here.
  useEffect(() => {
    const key = open.ticketKey;
    if (!key || !open.retry || open.failed) return;
    let n = 0;
    const timer = setInterval(() => {
      if (++n > 20) return clearInterval(timer);
      client.ticket(key).then(
        (t) => {
          if (t.target.kind !== 'session') return clearInterval(timer);
          if (t.target.status === 'delivery-failed') {
            setLateFail('The session did not get it; the ticket stays in the queue.');
            clearInterval(timer);
          }
        },
        () => undefined,
      );
    }, 3000);
    return () => clearInterval(timer);
  }, [client, open.ticketKey, open.retry, open.failed]);

  const failure = open.failed ?? (lateFail ? { reason: lateFail } : null);
  const st = chatStatus(session);
  const ended = session?.state === 'ended';
  const ticketKey = open.ticketKey ?? session?.ticketKey ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-line pr-12 pl-1">
        <IconBtn icon="chevronLeft" label="Back" onClick={onBack} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold" title={session?.title}>
            {session ? sessionTitle(session.title) : 'Session'}
          </p>
          <p className="flex items-center gap-1.5 text-[12px] text-muted">
            <span aria-hidden="true" className={`size-2 rounded-full ${st.tone === 'busy' ? 'bg-flame' : st.tone === 'wait' ? 'bg-gold' : st.tone === 'off' ? 'bg-line-strong' : 'bg-accent'}`} />
            {st.word}
          </p>
        </div>
        {ticketKey && (
          <button
            type="button"
            onClick={() => {
              select(ticketKey);
              setTab('tickets');
            }}
            className="inline-flex min-h-11 items-center rounded-full px-2 text-[12.5px] font-semibold whitespace-nowrap text-accent tabular-nums focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
          >
            {ticketKey}
          </button>
        )}
        {session && (
          <a href={session.url} target="_blank" rel="noopener noreferrer" aria-label="Open in pilot" title="Open in pilot" className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
            <Icon name="externalLink" className="size-[18px]" />
          </a>
        )}
      </header>

      {failure && (
        <div className="shrink-0 px-3 pt-2">
          <Notice tone="error">
            <span className="block">Not delivered: {failure.reason}</span>
            {open.retry && !ended && (
              <button
                type="button"
                disabled={sending}
                onClick={() => {
                  const r = open.retry!;
                  void send(r.text, r.image).then((ok) => {
                    if (!ok) return;
                    setLateFail(null);
                    openChat({ ...open, failed: null, retry: null });
                  });
                }}
                className="mt-1 inline-flex min-h-11 items-center font-semibold underline"
              >
                Retry
              </button>
            )}
          </Notice>
        </div>
      )}
      {session && st.tone === 'wait' && (
        <div className="shrink-0 px-3 pt-2">
          <Notice tone="info">
            <span className="block break-words">Waiting for approval{session.waitingFor ? `: ${session.waitingFor}` : ''}</span>
            <a href={session.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-semibold text-accent underline">
              Answer in pilot
            </a>
          </Notice>
        </div>
      )}

      <div ref={list} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2" aria-live="polite" aria-busy={!session && !failed && !gone}>
        {gone && <p className="py-8 text-center text-[13.5px] text-muted">This session is not available here.</p>}
        {failed && <Notice tone="error">{failed}</Notice>}
        {!session && !failed && !gone && <div className="skeleton h-24 rounded-2xl" />}
        {before !== null && <p className="py-2 text-center text-[12px] text-muted">Scroll up for older</p>}
        {session && !lines.length && !pending.length && <p className="py-8 text-center text-[13.5px] text-muted">No messages yet.</p>}
        <ol className="flex flex-col gap-1.5">
          {lines.map((m) => (
            <Line key={m.seq} m={m} onImage={setView} />
          ))}
          {pending.map((p) => (
            <li key={p.uuid} className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-3 py-2 text-[14px] break-words whitespace-pre-line opacity-70">
              {p.text}
              <span className="sr-only"> (sending)</span>
            </li>
          ))}
        </ol>
        {!atBottom && (
          <button type="button" onClick={jump} className="sticky bottom-2 left-1/2 mx-auto mt-2 flex min-h-11 -translate-x-0 items-center gap-1 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-ink shadow-md focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
            <Icon name="arrowDown" className="size-4" />
            Latest
          </button>
        )}
      </div>

      {!gone && (
        <Composer
          value={text}
          onChange={setText}
          coarse={coarse}
          busy={sending}
          disabled={!session || ended}
          maxLength={REPORTER_LIMITS.chatChars}
          label="Message"
          placeholder={ended ? 'This session has ended' : 'Message'}
          onSend={() => {
            const body = text.trim();
            if (!body) return;
            void send(body, attach ? (capture?.screenshot ?? null) : null).then((ok) => {
              if (ok) {
                setText('');
                setAttach(false);
              }
            });
          }}
          extra={
            capture ? (
              <button
                type="button"
                aria-pressed={attach}
                aria-label={attach ? 'Do not attach the shot' : 'Attach the current shot'}
                title="Attach the current shot"
                onClick={() => setAttach(!attach)}
                className={`inline-flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden ${attach ? 'bg-accent-soft text-accent' : 'text-muted'}`}
              >
                <Icon name="camera" className="size-[18px]" />
              </button>
            ) : undefined
          }
        />
      )}
      {view && <Viewer src={view} alt="Image" onClose={() => setView(null)} />}
    </div>
  );
}

/** One line: the person's and the assistant's text as bubbles, a tool call as one muted line, an approval or an error as a marked line. */
const Line = memo(function Line({ m, onImage }: { m: ReporterChatMessage; onImage: (url: string) => void }) {
  const { client } = usePanel();
  const images = m.images.length ? (
    <span className="mt-1 flex flex-wrap gap-1">
      {m.images.slice(0, 4).map((i) => (
        <button key={i.url} type="button" onClick={() => onImage(i.url)} aria-label="View image" className="rounded-lg focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
          <AuthImg client={client} src={i.url} alt="" className="h-24 w-32 rounded-lg" />
        </button>
      ))}
    </span>
  ) : null;
  if (m.kind === 'tool')
    return (
      <li className="flex min-w-0 items-center gap-1.5 px-1 text-[12px] text-muted">
        <Icon name="terminal" className="size-3.5 shrink-0" />
        <span className="shrink-0 font-semibold">{m.tool}</span>
        {m.text && <span className="min-w-0 truncate font-mono">{m.text}</span>}
      </li>
    );
  if (m.kind === 'approval' || m.kind === 'error')
    return (
      <li className={`flex items-start gap-1.5 rounded-xl px-2 py-1.5 text-[12.5px] break-words ${m.kind === 'error' ? 'bg-danger-soft text-danger' : 'bg-gold-soft text-ink'}`}>
        <Icon name="triangleAlert" className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0">{m.kind === 'approval' ? `Approval: ${m.text}` : m.text}</span>
      </li>
    );
  if (m.kind === 'user')
    return (
      <li className="ml-auto flex max-w-[85%] flex-col items-end">
        {m.from && <span className="mb-0.5 text-[11.5px] text-muted">{m.from}</span>}
        <span className="rounded-2xl rounded-br-md bg-accent-soft px-3 py-2 text-[14px] break-words whitespace-pre-line">{m.text}</span>
        {images}
      </li>
    );
  return (
    <li className="mr-auto max-w-[92%] rounded-2xl rounded-bl-md bg-surface-2 px-3 py-2 text-[14px]">
      <Md text={m.text} />
      {images}
    </li>
  );
});
