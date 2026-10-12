// Gitea (docs/prd/triggers.md §9): `X-Gitea-Signature: <hex>` (no prefix) and `X-Hub-Signature-256: sha256=<hex>`, both HMAC-SHA256 of the
// raw body; Gitea sends EMPTY values when the webhook has no secret, and an empty digest is a failure. Payloads are GitHub-shaped
// (`modules/structs/hook.go`: PushPayload, PullRequestPayload, IssuePayload, IssueCommentPayload), with Gitea's own action spellings:
// `synchronized` (GitHub: `synchronize`) and `label_updated` (GitHub: `labeled`). `X-Gitea-Event` carries the general event and
// `X-Gitea-Event-Type` the specific one (`pull_request_label`, `issue_label`, `pull_request_comment`): either is accepted (open question
// 🔬 in §18: which value label updates carry).

import type { Normalized } from '../normalize.js';
import { normalizeGithubLike } from './github.js';
import { verifyBareHmac, verifyPrefixedHmac, type HeaderGet } from './signature.js';

/** The bare header when it has a value, else the prefixed one; when both have values both must verify. Neither: a failure. */
export function verifyGitea(get: HeaderGet, raw: Buffer, secret: string): boolean {
  const bare = get('x-gitea-signature');
  const prefixed = get('x-hub-signature-256');
  if (!bare && !prefixed) return false;
  const a = bare ? verifyBareHmac(bare, raw, secret) : true;
  const b = prefixed ? verifyPrefixedHmac(prefixed, raw, secret) : true;
  return a && b;
}

const PR_ACTIONS: Record<string, string> = { opened: 'opened', reopened: 'reopened', closed: 'closed', label_updated: 'labeled', synchronized: 'updated' };
const ISSUE_ACTIONS: Record<string, string> = { opened: 'opened', reopened: 'reopened', closed: 'closed', label_updated: 'labeled' };
const SPELL = {
  pr: PR_ACTIONS,
  issue: ISSUE_ACTIONS,
  prEvents: ['pull_request', 'pull_request_label', 'pull_request_sync'],
  issueEvents: ['issues', 'issue_label'],
  commentEvents: ['issue_comment', 'pull_request_comment'],
};
const KNOWN = new Set(['push', ...SPELL.prEvents, ...SPELL.issueEvents, ...SPELL.commentEvents]);

export function normalizeGitea(event: string, eventType: string | null, body: Record<string, unknown>, host: string | null, at: string): Normalized {
  const name = KNOWN.has(event) ? event : eventType && KNOWN.has(eventType) ? eventType : event;
  // An issue event carries its number at the top (`number`) as well as in `issue`.
  const shaped = name === 'issues' || name === 'issue_label' ? { ...body, issue: { number: body.number, ...(body.issue as object) } } : body;
  return normalizeGithubLike('gitea', name, shaped, host, at, SPELL);
}
