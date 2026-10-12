// GitLab (docs/prd/triggers.md §9, https://docs.gitlab.com/user/project/integrations/webhooks/ and .../webhook_events/, read 2026-10-12):
// the signing token (GitLab 19.0 and later, Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature`) or, when the trigger
// is set to `token`, the older `X-Gitlab-Token` sent as is. The body's `object_kind` names the event (`push`, `tag_push`, `merge_request`,
// `issue`, `note`); `X-Gitlab-Event` is not relied on.

import type { WebhookSpec } from '@portal/contracts';
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
import { verifyPlainToken, verifySigningToken, type HeaderGet } from './signature.js';

export function verifyGitlab(get: HeaderGet, raw: Buffer, secret: string, mode: WebhookSpec['gitlabAuth'], nowMs: number): boolean {
  return mode === 'token' ? verifyPlainToken(get('x-gitlab-token'), secret) : verifySigningToken(get, raw, secret, nowMs);
}

const MR_ACTIONS: Record<string, string> = { open: 'opened', reopen: 'reopened', close: 'closed', merge: 'merged' };
const ISSUE_ACTIONS: Record<string, string> = { open: 'opened', reopen: 'reopened', close: 'closed' };

/** Whether an `update` changed the labels (`changes.labels` with a previous or current list). */
const labelsChanged = (body: Record<string, unknown>) => {
  const l = obj(obj(body.changes).labels);
  return Array.isArray(l.previous) || Array.isArray(l.current);
};

export function normalizeGitlab(body: Record<string, unknown>, host: string | null, at: string): Normalized {
  const kind = body.object_kind;
  const project = obj(body.project);
  const repo = repoName(project.path_with_namespace);
  const user = obj(body.user);

  if (kind === 'tag_push') return { kind: 'ignore', why: 'tag' };
  if (kind === 'push') {
    const ref = typeof body.ref === 'string' ? body.ref : '';
    if (!ref.startsWith('refs/heads/')) return { kind: 'ignore', why: ref.startsWith('refs/tags/') ? 'tag' : 'invalid_event' };
    if (typeof body.after === 'string' && ZERO_SHA.test(body.after)) return { kind: 'ignore', why: 'deleted' };
    const commits = arr(body.commits);
    const last = obj(commits[commits.length - 1]);
    const facts = {
      ...blankFacts('gitlab', 'push', at),
      action: 'pushed',
      repo,
      branch: branchName(ref),
      sha: sha(body.checkout_sha) ?? sha(body.after),
      sender: login(body.user_username),
      url: linkOn(last.url, host) ?? linkOn(project.web_url, host),
      untrusted: compactUntrusted({ commits: commitsText(commits) }),
    };
    return { kind: 'event', facts, labels: [] };
  }

  if (kind === 'merge_request') {
    const a = obj(body.object_attributes);
    let action = MR_ACTIONS[String(a.action)];
    if (a.action === 'update') {
      // A new commit (`oldrev`) is `updated`; a label change is `labeled`; any other edit (a title) is not an event here.
      if (typeof a.oldrev === 'string' && a.oldrev) action = 'updated';
      else if (labelsChanged(body)) action = 'labeled';
    }
    if (!action) return { kind: 'ignore', why: 'unsupported_action' };
    const labels = labelsOf(body.labels ?? a.labels, 'title');
    const src = positiveInt(a.source_project_id);
    const dst = positiveInt(a.target_project_id);
    const facts = {
      ...blankFacts('gitlab', 'pull_request', at),
      action,
      repo,
      number: positiveInt(a.iid),
      branch: branchName(a.target_branch),
      sha: sha(obj(a.last_commit).id),
      sender: login(user.username),
      url: linkOn(a.url, host),
      fork: src !== null && dst !== null ? src !== dst : null,
      untrusted: compactUntrusted({ title: untrustedText(a.title, TITLE_MAX), body: untrustedText(a.description), labels: labels.text }),
    };
    return { kind: 'event', facts, labels: labels.names };
  }

  if (kind === 'issue') {
    const a = obj(body.object_attributes);
    let action = ISSUE_ACTIONS[String(a.action)];
    if (a.action === 'update' && labelsChanged(body)) action = 'labeled';
    if (!action) return { kind: 'ignore', why: 'unsupported_action' };
    const labels = labelsOf(body.labels ?? a.labels, 'title');
    const facts = {
      ...blankFacts('gitlab', 'issue', at),
      action,
      repo,
      number: positiveInt(a.iid),
      sender: login(user.username),
      url: linkOn(a.url, host),
      untrusted: compactUntrusted({ title: untrustedText(a.title, TITLE_MAX), body: untrustedText(a.description), labels: labels.text }),
    };
    return { kind: 'event', facts, labels: labels.names };
  }

  if (kind === 'note') {
    const a = obj(body.object_attributes);
    const on = a.noteable_type;
    if (on !== 'Issue' && on !== 'MergeRequest') return { kind: 'ignore', why: 'unsupported_action' };
    // Newer GitLab names the note's action (`create`, `update`); an edited comment is not a new one.
    if (a.action !== undefined && a.action !== 'create') return { kind: 'ignore', why: 'unsupported_action' };
    const target = on === 'Issue' ? obj(body.issue) : obj(body.merge_request);
    const labels = labelsOf(target.labels, 'title');
    const facts = {
      ...blankFacts('gitlab', 'comment', at),
      action: 'created',
      repo,
      number: positiveInt(target.iid),
      branch: on === 'MergeRequest' ? branchName(target.target_branch) : null,
      sender: login(user.username),
      url: linkOn(a.url, host),
      untrusted: compactUntrusted({ title: untrustedText(target.title, TITLE_MAX), comment: untrustedText(a.note), labels: labels.text }),
    };
    return { kind: 'event', facts, labels: labels.names };
  }

  return { kind: 'ignore', why: 'unknown_event' };
}
