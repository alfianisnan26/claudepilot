// Makes the app installable and shows a small page when the server can't be reached.
// Only page loads are handled: API calls, WebSockets and assets always go to the network.
const CACHE = 'pilot-shell-v1';
const OFFLINE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([OFFLINE, '/favicon.svg']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Nothing answered, or only a proxy did to say the portal is down (502, 503, 504): the offline page. Any other answer is the portal's.
const PROXY_DOWN = new Set([502, 503, 504]);

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  event.respondWith(
    fetch(request).then(
      (response) => (PROXY_DOWN.has(response.status) ? caches.match(OFFLINE).then((page) => page || response) : response),
      () => caches.match(OFFLINE),
    ),
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// Notifications (docs/prd/web-app-pwa.md section 11.3 and 11.7). The portal sends Declarative Web Push JSON, encrypted for this
// device; this code shows it (always: Safari revokes a subscription whose pushes show nothing), turns the Deny and Allow
// buttons into one call to /api/notify/act, and opens the deep link on a tap. It never handles /api/*, /hooks/* or sockets in
// `fetch`, and it never writes a token, a payload or an address to the console or to a notification.
// Plain JavaScript, no build step: the pure functions are on `self.__pilotPush` so a test can run them under Node's `vm`.
// ---------------------------------------------------------------------------------------------------------------------
const PILOT_ACT_URL = '/api/notify/act';
const PILOT_PUSH_URL = '/api/notify/push';
const PILOT_FALLBACK_PATH = '/admin/';
const PILOT_PATH = /^\/admin\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/;
const PILOT_TOKEN = /^cpna_[A-Za-z0-9_-]{20,100}$/;
const PILOT_EVENT = /^evt_[0-9a-f]{16}$/;
const PILOT_NEVER_MUTE = ['approval', 'ci_waiting'];
const PILOT_REFUSALS = {
  expired: 'It took too long',
  used: 'Already answered',
  closed: 'The request is closed',
  not_allowed: 'Not allowed from a notification',
  disabled: 'Answers are switched off',
  device_removed: 'This device was removed',
  rate_limited: 'Too many tries',
  locked: 'The portal is locked',
  unknown: 'Not recognised',
};

/** A portal path a notification may open: `/admin/` plus path characters and a query; no `//`, `..`, backslash, scheme or control character. Else the fallback. */
function pilotSafePath(p) {
  return typeof p === 'string' && p.length <= 400 && PILOT_PATH.test(p) && !p.includes('//') && !p.includes('..') ? p : PILOT_FALLBACK_PATH;
}

const pilotClip = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** The answer buttons a payload carries: only decisions the server put in `data.act.d`, with a well-formed token that has not expired. */
function pilotAct(act, nowMs) {
  if (!act || typeof act !== 'object' || typeof act.t !== 'string' || !PILOT_TOKEN.test(act.t) || !Array.isArray(act.d)) return null;
  if (typeof act.exp === 'number' && act.exp * 1000 <= nowMs) return null;
  const d = act.d.filter((x, i) => (x === 'allow' || x === 'deny') && act.d.indexOf(x) === i);
  return d.length ? { t: act.t, d: d, exp: typeof act.exp === 'number' ? act.exp : 0 } : null;
}

/**
 * The text of a push (a string or already-parsed JSON) as what to show: `{ title, options }`. Anything that is not the portal's shape
 * (wrong magic, no notification, bad JSON) still shows something, a fixed line that opens the portal.
 */
function pilotPlan(raw, nowMs, maxActions) {
  let p = null;
  try {
    p = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    p = null;
  }
  const n = p && p.web_push === 8030 && p.notification && typeof p.notification === 'object' ? p.notification : null;
  if (!n || typeof n.title !== 'string' || !n.title) {
    return { valid: false, title: 'Portal', options: { body: 'Open the portal', tag: 'portal:unknown', data: { v: 1, path: PILOT_FALLBACK_PATH, kind: null, id: null, act: null } }, badge: null };
  }
  const d = n.data && typeof n.data === 'object' ? n.data : {};
  const path = pilotSafePath(d.path);
  const act = pilotAct(d.act, nowMs);
  const tag = pilotClip(n.tag, 120) || undefined;
  const options = { body: pilotClip(n.body, 300), icon: '/icon-192.png', data: { v: 1, path: path, kind: pilotClip(d.kind, 40) || null, id: pilotClip(d.id, 40) || null, act: act, tag: tag || null } };
  if (tag) {
    options.tag = tag;
    if (n.renotify === true) options.renotify = true;
  }
  if (act) {
    const labels = { deny: 'Deny', allow: 'Allow' };
    const buttons = ['deny', 'allow'].filter((x) => act.d.includes(x)).map((x) => ({ action: x, title: labels[x] }));
    buttons.push({ action: 'review', title: 'Review' });
    // The body is itself "review", so when the browser shows fewer buttons the answers win over Review.
    options.actions = buttons.slice(0, Math.max(1, typeof maxActions === 'number' ? maxActions : 2));
  } else if (Array.isArray(n.actions) && n.actions.some((a) => a && a.action === 'mute') && PILOT_EVENT.test(options.data.id || '') && !PILOT_NEVER_MUTE.includes(options.data.kind)) {
    // "Mute" opens the mute sheet for this event; approvals and deploy waits never carry it.
    options.actions = [{ action: 'mute', title: 'Mute' }];
  }
  const badge = typeof n.app_badge === 'string' && /^\d{1,4}$/.test(n.app_badge) ? Number(n.app_badge) : null;
  return { valid: true, title: pilotClip(n.title, 120), options: options, badge: badge };
}

/** What a click does: `{ kind: 'open', path }` or `{ kind: 'act', decision, token, path }`. An answer needs a button that the payload carried and a live token. */
function pilotClickPlan(action, data, nowMs) {
  const path = pilotSafePath(data && data.path);
  if ((action === 'deny' || action === 'allow') && data && data.act) {
    const act = pilotAct(data.act, nowMs);
    if (act && act.d.includes(action)) return { kind: 'act', decision: action, token: act.t, path: path };
  }
  if (action === 'mute' && data && typeof data.id === 'string' && PILOT_EVENT.test(data.id)) return { kind: 'open', path: '/admin/notifications?mute=' + data.id };
  return { kind: 'open', path: path };
}

/** The request for an answer: the token travels in the body, never in the URL, with the session cookie of this origin. */
function pilotActRequest(token, decision) {
  return { url: PILOT_ACT_URL, init: { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, decision: decision }) } };
}

/** One line for why an answer did not go through (the server's `details.reason`), fixed text only. */
function pilotRefusalLine(status, body) {
  const reason = body && body.error && body.error.details && typeof body.error.details.reason === 'string' ? body.error.details.reason : null;
  if (reason && Object.prototype.hasOwnProperty.call(PILOT_REFUSALS, reason)) return PILOT_REFUSALS[reason];
  if (status === 401) return 'Sign in again';
  if (status === 429) return PILOT_REFUSALS.rate_limited;
  if (status === 410) return PILOT_REFUSALS.expired;
  if (status === 409) return PILOT_REFUSALS.closed;
  if (status === 503) return PILOT_REFUSALS.locked;
  return 'Could not reach the portal';
}

/** Posts the answer. Resolves `{ ok: true }` or `{ ok: false, line }`; never throws, never logs. */
async function pilotAnswer(fetchFn, token, decision) {
  const req = pilotActRequest(token, decision);
  try {
    const res = await fetchFn(req.url, req.init);
    if (res.ok) return { ok: true, line: null };
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: false, line: pilotRefusalLine(res.status, body) };
  } catch {
    return { ok: false, line: pilotRefusalLine(0, null) };
  }
}

/** Focus a window of this origin (taking it to the path), else open one. */
async function pilotOpen(scope, path) {
  const origin = scope.location.origin;
  const target = origin + path;
  let wins = [];
  try {
    wins = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
  } catch {
    wins = [];
  }
  const mine = wins.filter((w) => typeof w.url === 'string' && w.url.indexOf(origin + '/') === 0);
  const best = mine.find((w) => w.focused) || mine.find((w) => w.visibilityState === 'visible') || mine[0];
  if (best) {
    try {
      if (best.url !== target && typeof best.navigate === 'function') await best.navigate(target);
      return await best.focus();
    } catch {
      // fall through to a new window
    }
  }
  return scope.clients.openWindow(target);
}

/** The whole click, as a function of the event, so a test can drive it. */
async function pilotHandleClick(scope, event) {
  const n = event.notification;
  const plan = pilotClickPlan(event.action, n && n.data, Date.now());
  if (n && typeof n.close === 'function') n.close();
  if (plan.kind === 'open') return pilotOpen(scope, plan.path);
  const result = await pilotAnswer((u, i) => scope.fetch(u, i), plan.token, plan.decision);
  if (result.ok) return null;
  // A click is not a push: showing this does not break the no-silent rule, but the person should know it did not go through.
  return scope.registration.showNotification('Couldn’t answer · open', {
    body: result.line,
    tag: 'answer-failed:' + ((n && n.data && n.data.tag) || 'x'),
    icon: '/icon-192.png',
    data: { v: 1, path: plan.path, kind: null, id: null, act: null, tag: null },
  });
}

/** The push: parse, show (always), set the app badge where the browser has one. */
async function pilotHandlePush(scope, event) {
  let text = '';
  try {
    text = event.data ? event.data.text() : '';
  } catch {
    text = '';
  }
  const maxActions = typeof scope.Notification === 'function' && typeof scope.Notification.maxActions === 'number' ? scope.Notification.maxActions : 2;
  const plan = pilotPlan(text, Date.now(), maxActions);
  await scope.registration.showNotification(plan.title, plan.options);
  if (plan.badge !== null && scope.navigator && typeof scope.navigator.setAppBadge === 'function') {
    try {
      await scope.navigator.setAppBadge(plan.badge);
    } catch {
      // no badge here
    }
  }
}

/** The browser replaced or dropped the subscription: make a new one with the same key and tell the portal. */
async function pilotResubscribe(scope, event) {
  try {
    let sub = event.newSubscription || null;
    if (!sub) {
      const key = event.oldSubscription && event.oldSubscription.options ? event.oldSubscription.options.applicationServerKey : null;
      if (!key) return;
      sub = await scope.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    const tz = scope.Intl.DateTimeFormat().resolvedOptions().timeZone;
    await scope.fetch(PILOT_PUSH_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), tz: tz }),
    });
  } catch {
    // signed out or offline: the page registers again when the person next opens it
  }
}

self.addEventListener('push', (event) => event.waitUntil(pilotHandlePush(self, event)));
self.addEventListener('notificationclick', (event) => event.waitUntil(pilotHandleClick(self, event)));
self.addEventListener('pushsubscriptionchange', (event) => event.waitUntil(pilotResubscribe(self, event)));

// For tests only: the pure parts, reachable without a push service.
self.__pilotPush = { safePath: pilotSafePath, plan: pilotPlan, clickPlan: pilotClickPlan, actRequest: pilotActRequest, refusalLine: pilotRefusalLine, answer: pilotAnswer, handleClick: (e) => pilotHandleClick(self, e), handlePush: (e) => pilotHandlePush(self, e), resubscribe: (e) => pilotResubscribe(self, e) };
