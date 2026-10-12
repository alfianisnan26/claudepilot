import { BTW_REASONS, type BtwReason, type BtwServerMessage, type ChatBtw } from '@portal/contracts';

/** The one card a tab shows: the newest btw, plus the last streamed piece it applied (a repeated or reordered piece is ignored). */
export type BtwState = { item: ChatBtw; seq: number } | null;

/** Folds one server message into the card. A closed btw leaves; an older btw never replaces a newer one; a delta only extends a running btw. */
export function foldBtw(prev: BtwState, msg: BtwServerMessage): BtwState {
  if (msg.type === 'btw') {
    const { item } = msg;
    if (item.closed) return prev?.item.id === item.id ? null : prev;
    if (prev && prev.item.id !== item.id && prev.item.askedAt > item.askedAt) return prev;
    // The whole state wins, but never shortens an answer the tab already streamed (a state sent just before the last pieces arrive).
    const keep = prev?.item.id === item.id && item.status === 'running' && prev.item.answer.length > item.answer.length;
    return { item: keep ? { ...item, answer: prev.item.answer } : item, seq: prev?.item.id === item.id && item.status === 'running' ? prev.seq : 0 };
  }
  if (!prev || prev.item.id !== msg.btw || prev.item.status !== 'running' || msg.seq <= prev.seq) return prev;
  return { item: { ...prev.item, answer: prev.item.answer + msg.text }, seq: msg.seq };
}

/** A card for an ask the portal refused (its `ack` said no): no btw exists on the server, so the tab makes the failed one itself. */
export function refusedBtw(base: { id: string; session: string; question: string; askedAt: string }, code: string | undefined, error: string | undefined): ChatBtw {
  const known = (BTW_REASONS as readonly string[]).includes(code ?? '');
  const forbidden = code === 'FORBIDDEN' || code === 'PERMISSION_DENIED';
  return {
    ...base,
    status: 'failed',
    answer: '',
    reason: (known ? code : 'error') as BtwReason,
    note: forbidden ? 'Not allowed for you.' : known ? undefined : error,
    settledAt: new Date().toISOString(),
  };
}

/** "1.2k", "840": the tokens in a short form. */
export const shortCount = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
