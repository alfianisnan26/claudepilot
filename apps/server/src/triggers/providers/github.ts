// GitHub (docs/prd/triggers.md §9): `X-Hub-Signature-256: sha256=<hex>` over the raw body; `X-GitHub-Event`, `X-GitHub-Delivery`.
// Events from https://docs.github.com/en/webhooks/webhook-events-and-payloads (read 2026-10-12): push, pull_request, issues,
// issue_comment, and ping (answered, never a run).

import type { WebhookEvent } from '@portal/contracts';
import {
  arr,
  blankFacts,
  branchName,
  commitsText,
  compactUntrusted,
  labelsOf,
  linkOn,
  login,
  obj,
  positiveInt,
  repoName,
  sha,
  TITLE_MAX,
  untrustedText,
  ZERO_SHA,
  type Normalized,
} from '../normalize.js';
import { verifyPrefixedHmac, type HeaderGet } from './signature.js';

export const verifyGithub = (get: HeaderGet, raw: Buffer, secret: string): boolean => verifyPrefixedHmac(get('x-hub-signature-256'), raw, secret);

const PR_ACTIONS: Record<string, string> = { opened: 'opened', reopened: 'reopened', closed: 'closed', labeled: 'labeled', synchronize: 'updated' };
const ISSUE_ACTIONS: Record<string, string> = { opened: 'opened', reopened: 'reopened', closed: 'closed', labeled: 'labeled' };

/**
 * GitHub-shaped payloads (Gitea's are close: see gitea.ts, which passes its own action spellings). `event` is the provider's event name.
 */
export function normalizeGithubLike(
  provider: 'github' | 'gitea',
  event: string,
  body: Record<string, unknown>,
  host: string | null,
  at: string,
  spell: { pr: Record<string, string>; issue: Record<string, string>; prEvents: string[]; issueEvents: string[]; commentEvents: string[] },
): Normalized {
  const repository = obj(body.repository);
  const repo = repoName(repository.full_name);
  const sender = login(obj(body.sender).login);
  const make = (e: WebhookEvent) => ({ ...blankFacts(provider, e, at), repo, sender });

  if (event === 'push') {
    const ref = typeof body.ref === 'string' ? body.ref : '';
    if (ref.startsWith('refs/tags/')) return { kind: 'ignore', why: 'tag' };
    if (body.deleted === true || (typeof body.after === 'string' && ZERO_SHA.test(body.after))) return { kind: 'ignore', why: 'deleted' };
    if (!ref.startsWith('refs/heads/')) return { kind: 'ignore', why: 'invalid_event' };
    const head = obj(body.head_commit);
    const facts = {
      ...make('push'),
      action: 'pushed',
      branch: branchName(ref),
      sha: sha(body.after),
      url: linkOn(body.compare, host) ?? linkOn(body.compare_url, host) ?? linkOn(head.url, host),
      untrusted: compactUntrusted({ commits: commitsText(arr(body.commits).length ? body.commits : head.message ? [head] : []) }),
    };
    return { kind: 'event', facts, labels: [] };
  }

  if (spell.prEvents.includes(event)) {
    const pr = obj(body.pull_request);
    let action = spell.pr[String(body.action)];
    if (!action) return { kind: 'ignore', why: 'unsupported_action' };
    if (action === 'closed' && pr.merged === true) action = 'merged';
    const headRepo = obj(obj(pr.head).repo);
    const baseRepo = obj(obj(pr.base).repo);
    const fork =
      typeof headRepo.fork === 'boolean' && provider === 'github'
        ? headRepo.fork
        : typeof headRepo.full_name === 'string' && typeof baseRepo.full_name === 'string'
          ? headRepo.full_name !== baseRepo.full_name
          : null;
    const labels = labelsOf(pr.labels, 'name');
    const facts = {
      ...make('pull_request'),
      action,
      number: positiveInt(body.number) ?? positiveInt(pr.number),
      branch: branchName(obj(pr.base).ref),
      sha: sha(obj(pr.head).sha),
      url: linkOn(pr.html_url, host),
      fork,
      untrusted: compactUntrusted({ title: untrustedText(pr.title, TITLE_MAX), body: untrustedText(pr.body), labels: labels.text }),
    };
    return { kind: 'event', facts, labels: labels.names };
  }

  if (spell.issueEvents.includes(event)) {
    const issue = obj(body.issue);
    const action = spell.issue[String(body.action)];
    if (!action) return { kind: 'ignore', why: 'unsupported_action' };
    const labels = labelsOf(issue.labels, 'name');
    const facts = {
      ...make('issue'),
      action,
      number: positiveInt(issue.number),
      url: linkOn(issue.html_url, host),
      untrusted: compactUntrusted({ title: untrustedText(issue.title, TITLE_MAX), body: untrustedText(issue.body), labels: labels.text }),
    };
    return { kind: 'event', facts, labels: labels.names };
  }

  if (spell.commentEvents.includes(event)) {
    if (body.action !== 'created') return { kind: 'ignore', why: 'unsupported_action' };
    const comment = obj(body.comment);
    const issue = obj(body.issue);
    const pr = obj(body.pull_request);
    const labels = labelsOf(issue.labels ?? pr.labels, 'name');
    const facts = {
      ...make('comment'),
      action: 'created',
      number: positiveInt(issue.number) ?? positiveInt(pr.number),
      url: linkOn(comment.html_url, host),
      untrusted: compactUntrusted({ title: untrustedText(issue.title ?? pr.title, TITLE_MAX), comment: untrustedText(comment.body), labels: labels.text }),
    };
    return { kind: 'event', facts, labels: labels.names };
  }

  return { kind: 'ignore', why: 'unknown_event' };
}

export function normalizeGithub(event: string, body: Record<string, unknown>, host: string | null, at: string): Normalized {
  if (event === 'ping') return { kind: 'ignore', why: 'ping' };
  return normalizeGithubLike('github', event, body, host, at, { pr: PR_ACTIONS, issue: ISSUE_ACTIONS, prEvents: ['pull_request'], issueEvents: ['issues'], commentEvents: ['issue_comment'] });
}
