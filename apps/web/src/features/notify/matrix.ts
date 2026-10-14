import { NOTIFY_KIND_INFO, NOTIFY_KINDS, NOTIFY_PHASE1_KINDS, type NotifyDestination, type NotifyKind } from '@portal/contracts';

/** When each kind fires: what the ⓘ on its row says. A sentence, no more. */
export const KIND_WHEN: Record<NotifyKind, string> = {
  approval: 'A session waits for you to allow or deny a tool. Sent after 3 seconds, and only if it is still open.',
  human_request: 'A ticket was assigned to you by an agent, a trigger or the portal.',
  session_failed: 'A turn or a session failed.',
  session_done: 'A session finished. Off until you switch it on, or turn on "Notify when done" in one session.',
  ci_failed: 'A CI run failed.',
  ci_waiting: 'A deploy waits for your approval on the run page.',
  quota_low: "A Claude's plan window is nearly used, or will run out before it resets.",
  cost_spike: 'Spend jumped, or a budget line was crossed. Comes through quiet hours.',
  trigger_approval: 'A trigger run waits for your approval.',
  trigger_failed: 'A trigger run failed, or a limit stopped it.',
  auto_move: 'A chat was moved to another Claude because a quota is low, or a move is suggested.',
  keepgoing_attention: 'Keep going found something in a chat it may not fix: an approval waits, Bypass is off, or the chat ended.',
  test: 'The Send test button.',
  workspace: 'A workspace needs attention.',
  account: 'An account needs attention.',
  portal: 'The portal itself needs attention.',
  security: 'Something security related happened.',
  expiring: 'Something is about to expire.',
};

/** The rows of the Events matrix, in the order the contract lists them (test is not a row). */
export const MATRIX_KINDS: readonly NotifyKind[] = NOTIFY_PHASE1_KINDS;

/** `kinds` with `kind` switched on or off, in the contract's order and without duplicates. */
export function withKind(kinds: readonly NotifyKind[], kind: NotifyKind, on: boolean): NotifyKind[] {
  const set = new Set(kinds);
  if (on) set.add(kind);
  else set.delete(kind);
  return NOTIFY_KINDS.filter((k) => set.has(k));
}

/** The kinds a destination hears that the matrix shows (a kind the matrix does not list is kept as it is when another one changes). */
export const hears = (d: Pick<NotifyDestination, 'kinds'>, kind: NotifyKind) => d.kinds.includes(kind);

/** The kinds that are on by default for a new destination. */
export const defaultKinds = (): NotifyKind[] => NOTIFY_KINDS.filter((k) => NOTIFY_KIND_INFO[k].defaultOn && NOTIFY_KIND_INFO[k].phase === 1);

/** "3 of 10 on" for a column's header or a collapsed row. */
export function kindsSummary(d: Pick<NotifyDestination, 'kinds'>): string {
  const on = MATRIX_KINDS.filter((k) => d.kinds.includes(k)).length;
  return on === 0 ? 'Nothing' : on === MATRIX_KINDS.length ? 'Everything' : `${on} of ${MATRIX_KINDS.length}`;
}

/** The state chip of a destination, in a word, and its tone. */
export function stateOf(d: Pick<NotifyDestination, 'enabled' | 'state' | 'lastError'>): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (!d.enabled) return { label: 'Off', tone: 'neutral' };
  if (d.state === 'disabled') return { label: 'Stopped', tone: 'danger' };
  if (d.state === 'failing') return { label: 'Failing', tone: 'warning' };
  return { label: 'On', tone: 'success' };
}

/** What a fixed error code means, for a person (the code itself is shown beside it, in monospace). */
export const ERROR_TEXT: Record<string, string> = {
  invalid_url: 'The address is not valid.',
  blocked_address: 'The address is on a private network, so the portal will not call it.',
  dns: 'The name did not resolve.',
  connect: 'The connection failed.',
  tls: 'The certificate was not accepted.',
  timeout: 'It took too long to answer.',
  redirect: 'It redirected, and the portal never follows redirects.',
  http_4xx: 'It refused the message.',
  http_5xx: 'It had a server error.',
  rate_limited: 'It said slow down.',
  gone: 'The browser or the service ended this subscription.',
  bad_subscription: 'The subscription was refused.',
  vapid_rejected: 'The push service did not accept the portal.',
  payload_too_large: 'The message was too large.',
  locked: 'The portal is locked, so nothing is sent.',
  no_key: 'No push key has been made yet.',
};
