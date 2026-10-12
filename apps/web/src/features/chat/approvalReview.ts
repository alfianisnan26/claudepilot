import { requestReview, type ChatRequest } from '@portal/contracts';

// What the approval card and the glance widget do with the text a person is asked to allow (chat-sessions PRD, approvals). Pure, so
// both surfaces share one rule and it can be tested: the text must be there and whole (`requestReview`), and, when it does not fit
// its block, the person must have scrolled to the end of it before Allow can be pressed.

/** How a scroll block stands: does its text overflow, and has the person reached the end of it. A pixel of slack for fractional sizes. */
export function scrollState(el: { scrollTop: number; clientHeight: number; scrollHeight: number }): { overflowing: boolean; atEnd: boolean } {
  return { overflowing: el.scrollHeight - el.clientHeight > 1, atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 2 };
}

/** Whether all of the text has been in view: it fits, or the person scrolled to the end. */
export const readAll = (view: { overflowing: boolean; atEnd: boolean }): boolean => !view.overflowing || view.atEnd;

export interface ApprovalControls {
  /** Allow (and Allow for session) can be pressed now. */
  allow: boolean;
  /** Whether Allow is offered at all: false for a request cut at the cap or with nothing to show (Deny only). */
  offered: boolean;
  /** The one terse line under the text: why Allow is not offered, or what to do first; null when there is nothing to say. */
  note: string | null;
}

/**
 * The buttons of one request. `read` is whether the whole text has been in view. Allow is offered only for a request whose text is there
 * and whole, and pressable only once it has been read; Deny is always there (it is the safe answer).
 */
export function approvalControls(request: Pick<ChatRequest, 'full' | 'fullCut'>, read: boolean): ApprovalControls {
  const review = requestReview(request);
  if (!review.allow) return { allow: false, offered: false, note: review.note };
  return { allow: read, offered: true, note: read ? null : 'Scroll to the end to allow.' };
}
