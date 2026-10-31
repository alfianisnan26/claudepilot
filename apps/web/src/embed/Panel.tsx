import { REPORTER_BRIDGE_VERSION, type ReporterBuildInfo, type ReporterHostMessage, type ReporterReportTarget, type ReporterReview, type ReporterSessionTargetStatus, type ReporterStatus } from '@portal/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clearToken, createClient, memoryStorage, parseConnectMessage, readToken, safeStorage, writeToken, type StoredToken } from './api';
import { createPanelBridge, exactOrigin, type PanelBridge } from './bridge';
import { PanelContext, newId, type Capture, type PanelState, type Tab } from './context';
import { Icon, type IconName } from './icons';
import { buildCallouts, isChangeEvent, parseHotkeys, type Hotkeys } from './model';
import { KnowledgeTab, SessionsTab, SettingsTab } from './OtherTabs';
import { ReportTab } from './ReportTab';
import { TicketsTab } from './TicketsTab';
import { Btn, IconBtn, Notice } from './ui';

const BUCKET = /^[A-Z]{2,6}$/;
const POLL_MS = 30_000;

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

  const client = useMemo(() => createClient({ token: () => tokenRef.current?.token ?? null, onUnauthorized: signOut }), [signOut]);

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
  const [capture, setCaptureState] = useState<Capture | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [targets, setTargets] = useState<ReporterSessionTargetStatus[]>([]);
  const [hostTarget, setHostTarget] = useState<ReporterReportTarget | null>(null);
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'error' | 'ok'; id: number } | null>(null);
  const coarse = useMemo(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches, []);

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

  const notify = useCallback((text: string, tone: 'info' | 'error' | 'ok' = 'info') => setToast({ text, tone, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.tone === 'error' ? 7000 : 4000);
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
    post({ type: 'pilot-reporter:settings', calloutsVisible, hotkeys });
  }, [status, connected, token, calloutsVisible, hotkeys, post]);
  useEffect(() => sendReady(), [sendReady]);

  // A stored token is checked once: a 401 signs out (onUnauthorized), anything else keeps it.
  useEffect(() => {
    if (!token || !status?.enabled) return;
    client.me().then(
      (me) => {
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
  useEffect(() => post({ type: 'pilot-reporter:tray', count: review?.status === 'draft' ? review.comments.length : 0 }), [review, post]);

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
  const setCapture = useCallback((c: Capture | null) => {
    setCaptureState((old) => {
      if (old && old !== c) URL.revokeObjectURL(old.previewUrl);
      return c;
    });
  }, []);
  const requestCapture = useCallback(
    (mode: 'full' | 'crop', precise = false) => {
      const requestId = newId();
      setPending(requestId);
      post({ type: 'pilot-reporter:capture-request', requestId, mode, precise });
    },
    [post],
  );
  const focus = useCallback(
    (key: string, captureId: string | null) => {
      setMissing(null);
      post({ type: 'pilot-reporter:focus', key, captureId, spotlight: true });
    },
    [post],
  );

  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const reviewRef = useRef(review);
  reviewRef.current = review;
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
        if (m.target) setHostTarget(m.target);
        setTab('report');
        return;
      case 'pilot-reporter:capture-result': {
        // Only the capture we asked for (or the one a hotkey announced): a page cannot push reports on its own.
        if (m.requestId !== pendingRef.current) return;
        const screenshot = new Blob([m.screenshot], { type: m.mediaType });
        if (m.target) setHostTarget(m.target);
        setCapture({ captureId: newId(), requestId: m.requestId, screenshot, previewUrl: URL.createObjectURL(screenshot), evidence: m.evidence, ...(m.target ? { target: m.target } : {}) });
        setPending(null);
        setTab('report');
        return;
      }
      case 'pilot-reporter:capture-cancelled':
        if (m.requestId !== pendingRef.current) return;
        setPending(null);
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
    }
  };

  // ---- connect (popup) ----
  const onConnected = useCallback(
    (t: StoredToken) => {
      writeToken(kv, origin, t);
      setTokenState(t);
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
        pending,
        requestCapture,
        targets,
        hostTarget,
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
  const tabs: { id: Tab; label: string; icon: IconName; badge?: number }[] = [
    { id: 'tickets', label: 'Tickets', icon: 'ticket' },
    { id: 'report', label: 'Report', icon: 'camera', badge: draftCount },
    { id: 'sessions', label: 'Sessions', icon: 'bot' },
    { id: 'knowledge', label: 'Knowledge', icon: 'bookOpen' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];

  return (
    <PanelContext.Provider value={state}>
      <div className="flex h-dvh flex-col overflow-hidden bg-bg text-ink">
        <header className="flex shrink-0 items-center gap-2 border-b border-line pl-3">
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-bold" title={status.bucketName}>
            {status.bucketName || bucket}
          </h1>
          {status.site && (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[12px] font-semibold text-ink-soft" title={`${status.site.repo} · ${status.site.origin}`}>
              {status.site.environment}
            </span>
          )}
          <IconBtn icon="x" label="Close" onClick={() => post({ type: 'pilot-reporter:close' })} />
        </header>
        {!connected ? (
          <Connect bucket={bucket} origin={origin} bucketName={status.bucketName} onConnected={onConnected} />
        ) : (
          <>
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
                  className={`relative flex min-h-11 flex-1 items-center justify-center focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden ${tab === t.id ? 'text-ink' : 'text-muted'}`}
                >
                  <Icon name={t.icon} />
                  {!!t.badge && (
                    <span className="absolute top-1.5 right-[calc(50%-1.25rem)] min-w-4 rounded-full bg-accent px-1 text-center text-[10.5px] leading-4 font-bold text-primary-ink tabular-nums">{t.badge}</span>
                  )}
                  {tab === t.id && <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-ink" />}
                </button>
              ))}
            </nav>
            <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {tab === 'tickets' && <TicketsTab />}
              {tab === 'report' && <ReportTab />}
              {tab === 'sessions' && <SessionsTab />}
              {tab === 'knowledge' && <KnowledgeTab />}
              {tab === 'settings' && <SettingsTab />}
            </main>
          </>
        )}
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
 * Sign-in: a popup of the portal (first party, the portal cookie applies) where the signed-in person approves this site; it posts a
 * token back to this frame only (same origin, our nonce). The token stays in this frame's storage and never reaches the host page.
 */
function Connect({ bucket, origin, bucketName, onConnected }: { bucket: string; origin: string; bucketName: string; onConnected: (t: StoredToken) => void }) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const start = () => {
    cleanup.current?.();
    setError(null);
    const nonce = newId();
    const url = `/reporter/v1/connect?${new URLSearchParams({ bucket, origin, nonce })}`;
    const popup = window.open(url, 'pilot-reporter-connect', 'popup,width=480,height=680');
    if (!popup) {
      setError('The sign-in window was blocked. Allow pop-ups for this site and try again.');
      return;
    }
    setWaiting(true);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== popup) return;
      const msg = parseConnectMessage(e.data, nonce, bucket);
      if (!msg) return;
      done();
      try {
        popup.close();
      } catch {
        // already closed
      }
      onConnected({ token: msg.token, expiresAt: msg.expiresAt, actorLabel: msg.actorLabel, bucketKey: msg.bucketKey });
    };
    const timer = setTimeout(() => {
      done();
      setError('No answer from the sign-in window.');
    }, 10 * 60_000);
    const done = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      setWaiting(false);
      cleanup.current = null;
    };
    window.addEventListener('message', onMessage);
    cleanup.current = done;
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <Icon name="ticket" className="size-8 text-muted" />
      <div>
        <p className="text-[16px] font-bold">Connect</p>
        <p className="mt-1 text-[13.5px] text-muted">Sign in to pilot to see and file {bucketName || bucket} tickets from this page.</p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {waiting ? (
        <div className="flex gap-2">
          <Btn tone="secondary" onClick={start}>
            Open again
          </Btn>
          <Btn tone="ghost" onClick={() => cleanup.current?.()}>
            Cancel
          </Btn>
        </div>
      ) : (
        <Btn tone="primary" onClick={start} className="w-full max-w-60">
          Connect
        </Btn>
      )}
    </div>
  );
}
