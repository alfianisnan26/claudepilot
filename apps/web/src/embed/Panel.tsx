import {
  REPORTER_BRIDGE_VERSION,
  type ReporterBuildInfo,
  type ReporterCaptureMode,
  type ReporterConnectMessage,
  type ReporterHostMessage,
  type ReporterMe,
  type ReporterReportTarget,
  type ReporterReview,
  type ReporterSessionTargetStatus,
  type ReporterStatus,
} from '@portal/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LogoMark } from '../components/LogoMark';
import {
  clearToken,
  connectCode,
  connectPair,
  connectWindowName,
  createClient,
  memoryStorage,
  parseConnectMessage,
  readToken,
  safeStorage,
  writeToken,
  type ReporterClient,
  type StoredToken,
} from './api';
import { captureRequest, createPanelBridge, exactOrigin, targetMessage, type PanelBridge } from './bridge';
import { ChatView } from './ChatView';
import { ContextSheet } from './ContextSheet';
import { PanelContext, newId, type Capture, type ChatOpen, type PanelState, type Tab } from './context';
import { choiceKey, parseChoice } from './formModel';
import { Icon, type IconName } from './icons';
import { buildCallouts, closesPanel, isChangeEvent, parseHotkeys, pickTarget, targetNotice, type Hotkeys } from './model';
import { KnowledgeTab, SessionsTab, SettingsTab } from './OtherTabs';
import { ReportTab } from './ReportTab';
import { TicketsTab } from './TicketsTab';
import { Btn, Notice } from './ui';

const BUCKET = /^[A-Z]{2,6}$/;
const POLL_MS = 30_000;
/** Shots on one report (the form's strip). */
const REPORT_SHOTS_MAX = 6;

/**
 * The reporter panel (/reporter/v1/embed?bucket=&origin=), framed by the SDK on the host page. It answers `ready` once it knows the
 * bucket's status; a bad link, a disabled bucket or an unreachable portal means the SDK hears nothing useful and renders nothing.
 */
export function Panel() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const bucket = (params.get('bucket') ?? '').toUpperCase();
  const origin = exactOrigin(params.get('origin'));
  if (!BUCKET.test(bucket) || !origin) return <Quiet text="This link is not a reporter panel." />;
  return <PanelInner bucket={bucket} origin={origin} />;
}

function Quiet({ text }: { text: string }) {
  return <p className="p-4 text-[14px] text-muted">{text}</p>;
}

const prefKey = (bucket: string, name: string) => `pilot-reporter:${name}:${bucket}`;

function PanelInner({ bucket, origin }: { bucket: string; origin: string }) {
  const kv = useMemo(() => safeStorage() ?? memoryStorage(), []);
  const [token, setTokenState] = useState<StoredToken | null>(() => readToken(kv, bucket, origin));
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const signOut = useCallback(() => {
    clearToken(kv, bucket, origin);
    setTokenState(null);
  }, [kv, bucket, origin]);

  // The token was refused (revoked, expired, its site removed): back to Connect with one line, never a raw "Not found." on every tab.
  const [ended, setEnded] = useState(false);
  const sessionEnded = useCallback(() => {
    if (tokenRef.current) setEnded(true);
    signOut();
  }, [signOut]);
  const client = useMemo(() => createClient({ token: () => tokenRef.current?.token ?? null, onUnauthorized: sessionEnded }), [sessionEnded]);

  const [status, setStatus] = useState<ReporterStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [page, setPage] = useState<{ url: string; title: string } | null>(null);
  const [build, setBuild] = useState<ReporterBuildInfo | null>(null);
  const [sdkVersion, setSdkVersion] = useState('');
  const [tab, setTab] = useState<Tab>('tickets');
  const [selected, select] = useState<string | null>(null);
  const [missing, setMissing] = useState<PanelState['missing']>(null);
  const [focused, setFocused] = useState<PanelState['focused']>(null);
  const [review, setReview] = useState<ReporterReview | null>(null);
  const [shots, setShots] = useState<Capture[]>([]);
  const capture = shots.at(-1) ?? null;
  const appendNext = useRef(false);
  const [chat, setChat] = useState<ChatOpen | null>(null);
  const [hostContext, setHostContext] = useState<PanelState['hostContext']>(null);
  const [me, setMe] = useState<ReporterMe | null>(null);
  const [contextOpen, setContextOpen] = useState<'context' | 'carries' | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [targets, setTargets] = useState<ReporterSessionTargetStatus[]>([]);
  const [hostTarget, setHostTarget] = useState<ReporterReportTarget | null>(null);
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'error' | 'ok'; id: number } | null>(null);
  const coarse = useMemo(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches, []);
  const theme = usePanelTheme();

  const readPref = (name: string) => {
    try {
      return kv.getItem(prefKey(bucket, name));
    } catch {
      return null;
    }
  };
  const writePref = (name: string, v: string) => {
    try {
      kv.setItem(prefKey(bucket, name), v);
    } catch {
      // per-viewer convenience only
    }
  };
  const [calloutsPref, setCalloutsPref] = useState<boolean | null>(() => {
    const v = readPref('callouts');
    return v === null ? null : v === '1';
  });
  const [hotkeys, setHotkeysState] = useState<Hotkeys>(() => parseHotkeys(readPref('hotkeys')));
  const calloutsVisible = calloutsPref ?? status?.calloutsDefault ?? true;

  const connected = !!token && !!status?.enabled;

  // ---- the bridge ----
  const bridge = useRef<PanelBridge | null>(null);
  const onHost = useRef<(m: ReporterHostMessage) => void>(() => undefined);
  useEffect(() => {
    const parent = window.parent !== window ? window.parent : null;
    const b = createPanelBridge({ self: window, parent, origin, onMessage: (m) => onHost.current(m) });
    bridge.current = b;
    return () => b.dispose();
  }, [origin]);
  const post = useCallback<PanelState['post']>((msg) => bridge.current?.post(msg), []);
  // Esc closes the panel (the SDK's frame draws the only close button; a key pressed in here never reaches the host page). A control that
  // uses Esc itself (the hotkey recorder) calls preventDefault and keeps the panel open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (closesPanel(e)) post({ type: 'pilot-reporter:close' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [post]);
  // The Ticket | Session choice the SDK's capture toolbar starts on: sent after ready, on every change, and with each capture request.
  // Remembered per bucket (owner, 2026-10-31): the form and the toolbar start on the last destination the person chose.
  const [choice, setChoiceState] = useState<ReporterReportTarget>(() => {
    try {
      return parseChoice(kv.getItem(choiceKey(bucket))) ?? { kind: 'ticket' };
    } catch {
      return { kind: 'ticket' };
    }
  });
  const choiceRef = useRef<ReporterReportTarget>(choice);
  const setChoice = useCallback(
    (t: ReporterReportTarget) => {
      const m = targetMessage(t);
      if (!m || m.type !== 'pilot-reporter:target') return;
      choiceRef.current = m.target;
      setChoiceState(m.target);
      try {
        kv.setItem(choiceKey(bucket), JSON.stringify(m.target));
      } catch {
        // per-viewer convenience only
      }
      post(m);
    },
    [post, kv, bucket],
  );

  const notify = useCallback((text: string, tone: 'info' | 'error' | 'ok' = 'info') => setToast({ text, tone, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.tone === 'error' ? 7000 : toast.tone === 'ok' ? 2000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // ---- status, then ready ----
  useEffect(() => {
    let live = true;
    client.status(bucket, origin).then(
      (s) => live && setStatus(s),
      () => live && setStatusFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, bucket, origin]);

  const sendReady = useCallback(() => {
    if (!status) return;
    post({ type: 'pilot-reporter:ready', bridge: REPORTER_BRIDGE_VERSION, status, connected, actorLabel: connected ? (token?.actorLabel ?? null) : null });
    post({ type: 'pilot-reporter:settings', calloutsVisible, hotkeys, theme });
    const t = targetMessage(choiceRef.current);
    if (t) post(t);
  }, [status, connected, token, calloutsVisible, hotkeys, theme, post]);
  useEffect(() => sendReady(), [sendReady]);

  // A stored token is checked once: a 401 signs out (onUnauthorized), anything else keeps it.
  useEffect(() => {
    if (!token || !status?.enabled) return;
    client.me().then(
      (me) => {
        setMe(me);
        if (me && typeof me.actorLabel === 'string' && me.actorLabel !== tokenRef.current?.actorLabel && tokenRef.current) {
          const next = { ...tokenRef.current, actorLabel: me.actorLabel };
          writeToken(kv, origin, next);
          setTokenState(next);
        }
      },
      () => undefined,
    );
    // once per token
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.token, status?.enabled]);

  // ---- draft review, session targets ----
  const reloadReview = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const drafts = await client.reviews();
      const open = drafts.filter((r) => r.status === 'draft').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setReview((cur) => (cur ? (open.find((r) => r.id === cur.id) ?? open[0] ?? null) : (open[0] ?? null)));
    } catch {
      // keep what we have
    }
  }, [client]);
  useEffect(() => {
    if (!connected) {
      setReview(null);
      setTargets([]);
      return;
    }
    void reloadReview();
    client.sessionTargets().then(setTargets, () => setTargets([]));
  }, [connected, client, reloadReview, tick]);
  // The widget button's badges: draft comments, and the person's open tickets waiting for their reply (re-counted on every change).
  const [replies, setReplies] = useState(0);
  useEffect(() => {
    if (!connected) return setReplies(0);
    let live = true;
    client.tickets({ status: 'open', mine: true, sort: 'updated', order: 'desc', limit: 100 }).then(
      (l) => live && setReplies(l.items.filter((t) => t.awaitingReporter).length),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [connected, client, tick]);
  useEffect(() => post({ type: 'pilot-reporter:tray', count: review?.status === 'draft' ? review.comments.length : 0, replies }), [review, replies, post]);

  // ---- callouts for the current page ----
  const path = page ? safePath(page.url) : null;
  useEffect(() => {
    if (!path) return;
    if (!connected) {
      post({ type: 'pilot-reporter:callouts', path, callouts: [] });
      return;
    }
    let live = true;
    client.tickets({ status: 'all', path, sort: 'position', order: 'asc', limit: 100 }).then(
      (list) => live && post({ type: 'pilot-reporter:callouts', path, callouts: buildCallouts(list.items, path, status?.site?.environment ?? null, review) }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [connected, path, tick, review, client, post, status?.site?.environment]);

  // ---- the build this page runs, once per page load of a signed-in panel ----
  const reportedBuild = useRef(false);
  useEffect(() => {
    if (!connected || !build?.commit || !page || reportedBuild.current) return;
    reportedBuild.current = true;
    client.observedBuild({ build, pageUrl: page.url }).catch(() => undefined);
  }, [connected, build, page, client]);

  // ---- live updates: the events stream, polling every 30 s while it is down ----
  const streamUp = useRef(false);
  useEffect(() => {
    if (!connected) return;
    const ctl = new AbortController();
    let backoff = 2000;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const bump = (e: unknown) => {
      if (!isChangeEvent(e)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(refresh, 400);
    };
    const run = async () => {
      while (!ctl.signal.aborted) {
        try {
          streamUp.current = true;
          backoff = 2000;
          await client.events(bump, ctl.signal);
        } catch {
          // dropped or refused: poll until it comes back
        }
        streamUp.current = false;
        if (ctl.signal.aborted || !tokenRef.current) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    };
    void run();
    const poll = setInterval(() => {
      if (!streamUp.current && document.visibilityState !== 'hidden') refresh();
    }, POLL_MS);
    return () => {
      ctl.abort();
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
      streamUp.current = false;
    };
  }, [connected, client, refresh]);

  // ---- captures ----
  // The report's shots: a new capture starts a new report unless the form's "+" asked to add one.
  const setCapture = useCallback((c: Capture | null) => {
    setShots((old) => {
      for (const o of old) if (o !== c) URL.revokeObjectURL(o.previewUrl);
      return c ? [c] : [];
    });
  }, []);
  const removeShot = useCallback((captureId: string) => {
    setShots((old) => {
      const gone = old.find((o) => o.captureId === captureId);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return old.filter((o) => o.captureId !== captureId);
    });
  }, []);
  const requestCapture = useCallback(
    (mode: ReporterCaptureMode, precise = false, append = false) => {
      const requestId = newId();
      appendNext.current = append;
      setPending(requestId);
      post(captureRequest(requestId, mode, precise, choiceRef.current));
    },
    [post],
  );
  const openChat = useCallback((c: ChatOpen | null) => {
    setChat(c);
    if (c) setTab('sessions');
  }, []);
  const focus = useCallback(
    (key: string, captureId: string | null) => {
      setMissing(null);
      // With the sheet open the page shows only the pin highlight (UX review 2026-10-31); Play all asks for the spotlight itself.
      post({ type: 'pilot-reporter:focus', key, captureId, spotlight: false });
    },
    [post],
  );

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const reviewRef = useRef(review);
  reviewRef.current = review;
  // The toolbar's choice: a session it cannot name ('' or one not available) resolves to the bucket's first available target; none at all
  // is refused with a message and the report goes in as a ticket.
  const takeHostTarget = (t: ReporterReportTarget) => {
    const notice = targetNotice(t, targets);
    if (notice) notify(notice, 'error');
    setHostTarget(t);
    setChoice(pickTarget(t, targets));
  };
  onHost.current = (m) => {
    switch (m.type) {
      case 'pilot-reporter:hello':
        setPage(m.page);
        setBuild(m.build);
        setSdkVersion(m.sdkVersion);
        sendReady();
        return;
      case 'pilot-reporter:navigated':
        setPage(m.page);
        setMissing(null);
        return;
      case 'pilot-reporter:capture-started':
        setPending(m.requestId);
        if (m.target) takeHostTarget(m.target);
        setTab('report');
        return;
      case 'pilot-reporter:capture-result': {
        // Only the capture we asked for (or the one a hotkey announced): a page cannot push reports on its own.
        if (m.requestId !== pendingRef.current) return;
        const screenshot = new Blob([m.screenshot], { type: m.mediaType });
        if (m.target) takeHostTarget(m.target);
        const shot: Capture = { captureId: newId(), requestId: m.requestId, screenshot, previewUrl: URL.createObjectURL(screenshot), evidence: m.evidence, ...(m.target ? { target: m.target } : {}) };
        if (appendNext.current) setShots((old) => [...old, shot].slice(-REPORT_SHOTS_MAX));
        else setCapture(shot);
        appendNext.current = false;
        setPending(null);
        setTab('report');
        return;
      }
      case 'pilot-reporter:capture-cancelled':
        if (m.requestId !== pendingRef.current) return;
        setPending(null);
        appendNext.current = false;
        if (m.reason === 'error') notify(m.message ? `Capture failed: ${m.message}` : 'Capture failed.', 'error');
        return;
      case 'pilot-reporter:panel-opened':
        refresh();
        return;
      case 'pilot-reporter:callout-clicked':
        if (reviewRef.current && m.key === reviewRef.current.id) setTab('report');
        else {
          select(m.key);
          setTab('tickets');
        }
        return;
      case 'pilot-reporter:focus-changed':
        setFocused({ key: m.key, captureId: m.captureId });
        return;
      case 'pilot-reporter:focus-ended':
        setFocused(null);
        return;
      case 'pilot-reporter:focus-missing':
        setMissing({ key: m.key, captureId: m.captureId, reason: m.reason });
        return;
      case 'pilot-reporter:context':
        setHostContext({ page: m.page, device: m.device, build: m.build, counts: m.counts });
        return;
    }
  };

  // ---- connect (popup) ----
  const onConnected = useCallback(
    (t: StoredToken) => {
      writeToken(kv, origin, t);
      setTokenState(t);
      setEnded(false);
      reportedBuild.current = false;
      notify('Connected', 'ok');
    },
    [kv, origin, notify],
  );

  const state: PanelState | null = status
    ? {
        client,
        bucket,
        origin,
        status,
        page,
        build,
        sdkVersion,
        actorLabel: token?.actorLabel ?? null,
        coarse,
        post,
        notify,
        tick,
        refresh,
        tab,
        setTab,
        selected,
        select,
        missing,
        focused,
        focus,
        review,
        setReview,
        reloadReview,
        capture,
        setCapture,
        shots,
        removeShot,
        pending,
        requestCapture,
        chat,
        openChat,
        hostContext,
        me,
        showContext: (section = 'context') => setContextOpen(section),
        targets,
        hostTarget,
        choice,
        setChoice,
        signOut: () => {
          void client.revoke().catch(() => undefined);
          signOut();
          post({ type: 'pilot-reporter:focus-clear' });
          notify('Signed out');
        },
        calloutsVisible,
        setCalloutsVisible: (v) => {
          setCalloutsPref(v);
          writePref('callouts', v ? '1' : '0');
        },
        hotkeys,
        setHotkeys: (h) => {
          setHotkeysState(h);
          writePref('hotkeys', JSON.stringify(h));
        },
      }
    : null;

  if (statusFailed) return <Quiet text="pilot is not reachable." />;
  if (!state || !status) return <div className="skeleton m-4 h-24 rounded-2xl" aria-busy="true" />;
  if (!status.enabled) return <Quiet text="The reporter is off for this site." />;

  const draftCount = review?.status === 'draft' ? review.comments.length : 0;
  const detail = connected && ((tab === 'tickets' && !!selected) || (tab === 'sessions' && !!chat));
  const tabs: { id: Tab; label: string; icon: IconName; badge?: number }[] = [
    { id: 'tickets', label: 'Tickets', icon: 'inbox' },
    { id: 'report', label: 'Report', icon: 'camera', badge: draftCount },
    { id: 'sessions', label: 'Sessions', icon: 'messagesSquare' },
    { id: 'knowledge', label: 'Knowledge', icon: 'bookOpen' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];

  return (
    <PanelContext.Provider value={state}>
      <div className="flex h-dvh flex-col overflow-hidden bg-bg text-ink">
        {/* No close button here: the SDK's frame draws the one close (it works even when this page fails to load); Esc closes too. */}
        {/* One row (owner, 2026-10-31): the project's name as the title, its environment and Context right after it; the right 48 px stay
            clear for the SDK's close X. It stays in detail views (a ticket, a chat), whose back row sits under it; the tabs hide there. */}
        <TitleRow
          name={status.bucketName || bucket}
          env={status.site?.environment ?? null}
          where={status.site ? `${status.site.repo} · ${status.site.origin}` : ''}
          onContext={connected ? () => setContextOpen('context') : null}
          divided={detail}
        />
        {!connected ? (
          <Connect client={client} bucket={bucket} origin={origin} bucketName={status.bucketName} onConnected={onConnected} note={ended ? 'Session ended. Connect again.' : null} />
        ) : (
          <>
            {!detail && (
            <nav role="tablist" aria-label="Sections" className="flex shrink-0 border-b border-line">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  type="button"
                  aria-selected={tab === t.id}
                  aria-label={t.label}
                  title={t.label}
                  onClick={() => setTab(t.id)}
                  className={`relative flex min-h-11 min-w-0 items-center justify-center ${tab === t.id ? 'flex-[2.2]' : 'flex-1'} md:flex-1 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden ${tab === t.id ? 'text-ink' : 'text-muted'}`}
                >
                  <Icon name={t.icon} />
                  {/* The word beside the active icon; every word from 768 px. */}
                  <span className={`ml-1.5 text-[13px] font-semibold ${tab === t.id ? 'inline' : 'hidden md:inline'}`}>{t.label}</span>
                  {!!t.badge && (
                    <span className="absolute top-1.5 right-[calc(50%-1.25rem)] min-w-4 rounded-full bg-accent px-1 text-center text-[10.5px] leading-4 font-bold text-primary-ink tabular-nums">{t.badge}</span>
                  )}
                  {tab === t.id && <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-ink" />}
                </button>
              ))}
            </nav>
            )}
            <main id="panel-main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {tab === 'tickets' && <TicketsTab />}
              {tab === 'report' && <ReportTab />}
              {tab === 'sessions' && (chat ? <ChatView key={chat.sessionId} open={chat} onBack={() => setChat(null)} /> : <SessionsTab />)}
              {tab === 'knowledge' && <KnowledgeTab />}
              {tab === 'settings' && <SettingsTab />}
            </main>
          </>
        )}
        {contextOpen && connected && <ContextSheet section={contextOpen} onClose={() => setContextOpen(null)} />}
        {toast && (
          <div className="pointer-events-none fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50" key={toast.id}>
            <Notice tone={toast.tone}>{toast.text}</Notice>
          </div>
        )}
      </div>
    </PanelContext.Provider>
  );
}

function safePath(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

/**
 * Sign-in: a popup of the portal (first party, the portal cookie applies) where the signed-in person approves this site. The token reaches
 * this frame only, two ways: the popup posts it to its opener (this frame: same origin, our nonce), or, when the popup lost its opener
 * (signing in inside it goes through the portal's pages, whose Cross-Origin-Opener-Policy cuts it off), the server holds the approval for
 * two minutes and this frame claims it with the verifier only it knows (polling while the popup is open). The token stays in this frame's
 * storage and never reaches the host page.
 */
export function Connect({
  client,
  bucket,
  origin,
  bucketName,
  onConnected,
  note = null,
}: {
  client: ReporterClient;
  bucket: string;
  origin: string;
  bucketName: string;
  onConnected: (t: StoredToken) => void;
  /** Why the panel is here again ("Session ended. Connect again."), shown as one line. */
  note?: string | null;
}) {
  const [waiting, setWaiting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const popupRef = useRef<Window | null>(null);
  // The next attempt's verifier and nonce, made ahead: window.open must run in the click itself (a popup blocker), before any await.
  const next = useRef<{ verifier: string; nonce: string } | null>(null);
  const prepare = useCallback(() => {
    next.current = null;
    connectPair().then(
      (p) => (next.current = p),
      () => undefined,
    );
  }, []);
  useEffect(() => {
    prepare();
    return () => cleanup.current?.();
  }, [prepare]);

  const start = () => {
    cleanup.current?.();
    try {
      popupRef.current?.close();
    } catch {
      // gone already
    }
    setError(null);
    const pair = next.current;
    prepare();
    // Without WebCrypto there is no verifier: the popup can still hand the token over through its opener.
    const nonce = pair?.nonce ?? newId();
    const verifier = pair?.verifier ?? null;
    const url = `/reporter/v1/connect?${new URLSearchParams({ bucket, origin, nonce })}`;
    const popup = window.open(url, connectWindowName(nonce), 'popup,width=480,height=680');
    if (!popup) {
      setError('The sign-in window was blocked. Allow pop-ups for this site and try again.');
      return;
    }
    popupRef.current = popup;
    setWaiting(nonce);
    let finished = false;
    let poll: ReturnType<typeof setTimeout> | null = null;
    const finish = (msg: ReporterConnectMessage) => {
      if (finished) return;
      done();
      try {
        popup.close();
      } catch {
        // already closed
      }
      onConnected({ token: msg.token, expiresAt: msg.expiresAt, actorLabel: msg.actorLabel, bucketKey: msg.bucketKey });
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== popup) return;
      const msg = parseConnectMessage(e.data, nonce, bucket);
      if (msg) finish(msg);
    };
    const claim = async () => {
      if (finished || !verifier) return;
      if (poll) clearTimeout(poll);
      poll = null;
      try {
        const msg = parseConnectMessage(await client.claimConnect(bucket, origin, verifier), nonce, bucket);
        if (msg) return finish(msg);
      } catch {
        // not reachable now: try again
      }
      if (!finished) poll = setTimeout(() => void claim(), 2000);
    };
    // Back from the popup (a phone shows it as a tab): ask at once instead of waiting for the next tick.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void claim();
    };
    const timer = setTimeout(() => {
      done();
      setError('No answer from the sign-in window.');
    }, 10 * 60_000);
    const done = () => {
      finished = true;
      window.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      clearTimeout(timer);
      if (poll) clearTimeout(poll);
      setWaiting(null);
      cleanup.current = null;
    };
    window.addEventListener('message', onMessage);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    if (verifier) poll = setTimeout(() => void claim(), 2000);
    cleanup.current = done;
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <LogoMark className="size-12" />
      <div>
        <p className="text-[16px] font-bold">Connect</p>
        <p className="mt-1 text-[13.5px] text-muted">Sign in to pilot to see and file {bucketName || bucket} tickets from this page.</p>
      </div>
      {note && !waiting && <Notice tone="info">{note}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {waiting ? (
        <>
          <p className="text-[13px] text-muted">
            Code <span className="font-mono text-[14px] font-semibold tracking-widest text-ink">{connectCode(waiting)}</span>
          </p>
          <div className="flex gap-2">
            <Btn tone="secondary" onClick={start}>
              Open again
            </Btn>
            <Btn tone="ghost" onClick={() => cleanup.current?.()}>
              Cancel
            </Btn>
          </div>
        </>
      ) : (
        <Btn tone="primary" onClick={start} className="w-full max-w-60">
          Connect
        </Btn>
      )}
    </div>
  );
}

/**
 * The panel's title row (owner, 2026-10-31): the project's name as the title (truncated), its environment as a chip and Context (i) right
 * after it. The right 48 px stay clear for the SDK's close X. `divided`: a detail view's back row sits under it.
 */
export function TitleRow({ name, env, where, onContext, divided = false }: { name: string; env: string | null; where: string; onContext: (() => void) | null; divided?: boolean }) {
  return (
    <header className={`flex min-h-11 shrink-0 items-center gap-1.5 pr-14 pl-3 ${divided ? 'border-b border-line' : ''}`}>
      <h1 data-testid="bucket-name" className="min-w-0 truncate text-[15px] font-semibold" title={name}>
        {name}
      </h1>
      {env && (
        <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-[12.5px] font-semibold text-ink-soft" title={where}>
          {env}
        </span>
      )}
      {onContext && (
        <button
          type="button"
          aria-label="Context"
          title="Context"
          onClick={onContext}
          className="-ml-1 inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
        >
          <Icon name="info" className="size-[18px]" />
        </button>
      )}
    </header>
  );
}

/** The panel's effective theme (its colours follow the system's in the frame), kept current: the host is told it with the settings. */
export function usePanelTheme(): 'light' | 'dark' {
  const query = useMemo(() => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null), []);
  const [dark, setDark] = useState(() => !!query?.matches);
  useEffect(() => {
    if (!query) return;
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener?.('change', on);
    return () => query.removeEventListener?.('change', on);
  }, [query]);
  return dark ? 'dark' : 'light';
}
