import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { deliveryIdOf, normalizeDelivery, verifyDelivery } from './index.js';
import { signingKey, verifySigningToken } from './signature.js';

const AT = '2026-10-12T00:00:00.000Z';
const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;
const hex = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

// docs/prd/triggers.md §9: the two vectors computed there with openssl and node.
describe('signatures: the §9 vectors', () => {
  const body = Buffer.from('Hello, World!');
  const secret = "It's a Secret to Everybody";
  const digest = '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

  it('GitHub X-Hub-Signature-256', () => {
    assert.equal(verifyDelivery('github', headers({ 'x-hub-signature-256': `sha256=${digest}` }), body, secret, 'signing', 0), true);
  });
  it('GitHub: missing, empty, wrong, truncated, sha1=, bare, other body, other secret all fail', () => {
    const forms: Record<string, string>[] = [{}, { 'x-hub-signature-256': '' }, { 'x-hub-signature-256': 'sha256=' }, { 'x-hub-signature-256': `sha256=${digest.slice(0, 63)}` }, { 'x-hub-signature-256': `sha256=${digest.slice(0, 62)}` }, { 'x-hub-signature-256': `sha1=${digest}` }, { 'x-hub-signature-256': digest }, { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, { 'x-hub-signature-256': `SHA256=${digest}` }];
    for (const h of forms)
      assert.equal(verifyDelivery('github', headers(h), body, secret, 'signing', 0), false, JSON.stringify(h));
    assert.equal(verifyDelivery('github', headers({ 'x-hub-signature-256': `sha256=${digest}` }), Buffer.from('Hello, World?'), secret, 'signing', 0), false);
    assert.equal(verifyDelivery('github', headers({ 'x-hub-signature-256': `sha256=${digest}` }), body, 'another', 'signing', 0), false);
    assert.equal(verifyDelivery('github', headers({ 'x-hub-signature-256': `sha256=${digest}` }), body, '', 'signing', 0), false);
  });
  it('uppercase hex digits are the same digest (decoded, then compared)', () => {
    assert.equal(verifyDelivery('github', headers({ 'x-hub-signature-256': `sha256=${digest.toUpperCase()}` }), body, secret, 'signing', 0), true);
  });
  it('Gitea: the bare header, the prefixed one, both; an EMPTY digest is a failure', () => {
    assert.equal(verifyDelivery('gitea', headers({ 'x-gitea-signature': digest }), body, secret, 'signing', 0), true);
    assert.equal(verifyDelivery('gitea', headers({ 'x-hub-signature-256': `sha256=${digest}` }), body, secret, 'signing', 0), true);
    assert.equal(verifyDelivery('gitea', headers({ 'x-gitea-signature': digest, 'x-hub-signature-256': `sha256=${digest}` }), body, secret, 'signing', 0), true);
    // Gitea with no secret configured sends both headers empty.
    assert.equal(verifyDelivery('gitea', headers({ 'x-gitea-signature': '', 'x-hub-signature-256': '' }), body, secret, 'signing', 0), false);
    assert.equal(verifyDelivery('gitea', headers({ 'x-gitea-signature': digest, 'x-hub-signature-256': `sha256=${'1'.repeat(64)}` }), body, secret, 'signing', 0), false);
    assert.equal(verifyDelivery('gitea', headers({}), body, secret, 'signing', 0), false);
  });

  const sw = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', ts: '1614265330', secret: 'whsec_TWZLUTlyOEdLWXFyVHdqVVBEOElMUFpJbzJMYUxhU3c=', sig: 'v1,ELhqG0Ku1gwOc1f4jyKdp3SFGFLAOdJ9bvpWLciCakI=' };
  const swBody = Buffer.from('{"test": 2432232314}');
  const swHeaders = (over: Record<string, string> = {}) => headers({ 'webhook-id': sw.id, 'webhook-timestamp': sw.ts, 'webhook-signature': sw.sig, ...over });
  const at = Number(sw.ts) * 1000;

  it('GitLab signing token (Standard Webhooks vector)', () => {
    assert.deepEqual(signingKey(sw.secret), Buffer.from('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'));
    assert.equal(verifyDelivery('gitlab', swHeaders(), swBody, sw.secret, 'signing', at), true);
    // Several signatures, space-separated: any may match.
    assert.equal(verifyDelivery('gitlab', swHeaders({ 'webhook-signature': `v1,AAAA ${sw.sig}` }), swBody, sw.secret, 'signing', at), true);
  });
  it('GitLab signing: another body, id, version, secret, or a timestamp more than 5 minutes off (R5) fails', () => {
    assert.equal(verifyDelivery('gitlab', swHeaders(), Buffer.from('{"test": 2432232315}'), sw.secret, 'signing', at), false);
    assert.equal(verifyDelivery('gitlab', swHeaders({ 'webhook-id': 'msg_other' }), swBody, sw.secret, 'signing', at), false);
    assert.equal(verifyDelivery('gitlab', swHeaders({ 'webhook-signature': sw.sig.replace('v1,', 'v2,') }), swBody, sw.secret, 'signing', at), false);
    assert.equal(verifyDelivery('gitlab', swHeaders({ 'webhook-signature': '' }), swBody, sw.secret, 'signing', at), false);
    assert.equal(verifyDelivery('gitlab', swHeaders(), swBody, 'whsec_QUFBQUFBQUFBQUFBQUFBQUFBQUE=', 'signing', at), false);
    assert.equal(verifyDelivery('gitlab', swHeaders(), swBody, sw.secret, 'signing', at + 301_000), false);
    assert.equal(verifyDelivery('gitlab', swHeaders(), swBody, sw.secret, 'signing', at - 301_000), false);
    assert.equal(verifyDelivery('gitlab', swHeaders(), swBody, sw.secret, 'signing', at + 299_000), true);
    // The plain token mode does not accept a signature, and the signing mode does not accept a plain token.
    assert.equal(verifyDelivery('gitlab', swHeaders(), swBody, sw.secret, 'token', at), false);
    assert.equal(verifySigningToken(headers({ 'x-gitlab-token': sw.secret }), swBody, sw.secret, at), false);
  });
  it('GitLab X-Gitlab-Token (the older secret token), compared in constant time', () => {
    const s = 'cpws_' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789ABCDEFG';
    assert.equal(verifyDelivery('gitlab', headers({ 'x-gitlab-token': s }), swBody, s, 'token', 0), true);
    assert.equal(verifyDelivery('gitlab', headers({ 'x-gitlab-token': `${s}x` }), swBody, s, 'token', 0), false);
    assert.equal(verifyDelivery('gitlab', headers({ 'x-gitlab-token': '' }), swBody, s, 'token', 0), false);
    assert.equal(verifyDelivery('gitlab', headers({}), swBody, s, 'token', 0), false);
  });
  it('a signing token must be whsec_ + base64 of 16 to 128 bytes (R22)', () => {
    assert.equal(signingKey('whsec_' + Buffer.alloc(15, 1).toString('base64')), null);
    assert.ok(signingKey('whsec_' + Buffer.alloc(16, 1).toString('base64')));
    assert.ok(signingKey('whsec_' + Buffer.alloc(128, 1).toString('base64')));
    assert.equal(signingKey('whsec_' + Buffer.alloc(129, 1).toString('base64')), null);
    assert.equal(signingKey('whsec_not base64!'), null);
    assert.equal(signingKey(Buffer.alloc(32, 1).toString('base64')), null);
  });
});

describe('delivery ids (FR9, R11)', () => {
  it('reads the provider header, else hashes the body', () => {
    const raw = Buffer.from('{}');
    assert.equal(deliveryIdOf('github', headers({ 'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958' }), raw), '72d3162e-cc78-11e3-81ab-4c9367dc0958');
    assert.equal(deliveryIdOf('gitea', headers({ 'x-gitea-delivery': 'f6266f16-1bf3-46a5-9ea4-602e06ead473' }), raw), 'f6266f16-1bf3-46a5-9ea4-602e06ead473');
    assert.equal(deliveryIdOf('gitlab', headers({ 'idempotency-key': 'abc-1' }), raw), 'abc-1');
    // CR/LF or a long value is ignored: the body's hash stands in.
    assert.match(deliveryIdOf('github', headers({ 'x-github-delivery': 'a\r\nX-Evil: 1' }), raw), /^body:[0-9a-f]{64}$/);
    assert.match(deliveryIdOf('github', headers({ 'x-github-delivery': 'a'.repeat(129) }), raw), /^body:[0-9a-f]{64}$/);
  });
});

/* ---------- Normalisation fixtures ----------
 * Built from the providers' documented sample payloads (abridged to the fields the mapping reads; the URLs in §9 of the PRD, read
 * 2026-10-12): GitHub "webhook events and payloads" (push, pull_request, issues, issue_comment, ping); Gitea modules/structs/hook.go
 * (PushPayload, PullRequestPayload, IssuePayload, IssueCommentPayload; scratchpad/pn-spike/gitea-hook.go); GitLab "webhook events"
 * (Push Hook, Merge Request Hook, Issue Hook, Note Hook). The † fields of §9 (merged, fork, oldrev, changes.labels, last_commit.id)
 * follow those samples' field names. */

const SHA = 'a10867b14bb761a232cd80139fbd4c0d33264240';
const ghRepo = { full_name: 'octo/hello', html_url: 'https://github.com/octo/hello' };

describe('GitHub normalisation', () => {
  const n = (event: string, body: Record<string, unknown>, h: Record<string, string> = {}) => normalizeDelivery('github', headers({ 'x-github-event': event, ...h }), body, null, AT);

  it('push to a branch', () => {
    const r = n('push', { ref: 'refs/heads/main', after: SHA, deleted: false, compare: 'https://github.com/octo/hello/compare/a...b', repository: ghRepo, sender: { login: 'octocat' }, commits: [{ message: 'fix: one' }, { message: 'feat: two' }], head_commit: { message: 'feat: two' } });
    assert.equal(r.kind, 'event');
    if (r.kind !== 'event') return;
    assert.deepEqual({ ...r.facts, untrusted: undefined }, { source: 'webhook', provider: 'github', event: 'push', action: 'pushed', repo: 'octo/hello', branch: 'main', sha: SHA, number: null, sender: 'octocat', url: 'https://github.com/octo/hello/compare/a...b', fork: null, at: AT, untrusted: undefined });
    assert.equal(r.facts.untrusted.commits, 'fix: one\n---\nfeat: two');
  });
  it('a tag push, a deleted branch and a ping are not runs', () => {
    assert.deepEqual(n('push', { ref: 'refs/tags/v1', after: SHA, repository: ghRepo }), { kind: 'ignore', why: 'tag' });
    assert.deepEqual(n('push', { ref: 'refs/heads/x', after: '0'.repeat(40), deleted: true, repository: ghRepo }), { kind: 'ignore', why: 'deleted' });
    assert.deepEqual(n('ping', { zen: 'Keep it logically awesome.', hook_id: 1 }), { kind: 'ignore', why: 'ping' });
    assert.deepEqual(n('star', { action: 'created' }), { kind: 'ignore', why: 'unknown_event' });
  });
  const pr = (action: string, extra: Record<string, unknown> = {}) => ({
    action,
    number: 42,
    pull_request: { number: 42, title: 'Add a thing', body: 'Please merge', html_url: 'https://github.com/octo/hello/pull/42', merged: false, base: { ref: 'main', repo: { full_name: 'octo/hello' } }, head: { sha: SHA, repo: { full_name: 'octo/hello', fork: false } }, labels: [{ name: 'bug' }], ...extra },
    repository: ghRepo,
    sender: { login: 'octocat' },
  });
  it('pull_request: opened, synchronize -> updated, closed+merged -> merged, labeled; a fork', () => {
    const o = n('pull_request', pr('opened'));
    assert.ok(o.kind === 'event');
    if (o.kind !== 'event') return;
    assert.equal(o.facts.event, 'pull_request');
    assert.equal(o.facts.action, 'opened');
    assert.equal(o.facts.number, 42);
    assert.equal(o.facts.branch, 'main');
    assert.equal(o.facts.sha, SHA);
    assert.equal(o.facts.fork, false);
    assert.equal(o.facts.url, 'https://github.com/octo/hello/pull/42');
    assert.deepEqual(o.facts.untrusted, { title: 'Add a thing', body: 'Please merge', labels: 'bug' });
    assert.deepEqual(o.labels, ['bug']);
    const action = (x: ReturnType<typeof n>) => (x.kind === 'event' ? x.facts.action : x.why);
    assert.equal(action(n('pull_request', pr('synchronize'))), 'updated');
    assert.equal(action(n('pull_request', pr('closed', { merged: true }))), 'merged');
    assert.equal(action(n('pull_request', pr('closed'))), 'closed');
    assert.equal(action(n('pull_request', pr('labeled'))), 'labeled');
    // Gitea's spelling sent to a GitHub trigger is not GitHub's action.
    assert.equal(action(n('pull_request', pr('synchronized'))), 'unsupported_action');
    assert.equal(action(n('pull_request', pr('edited'))), 'unsupported_action');
    const fork = n('pull_request', pr('opened', { head: { sha: SHA, repo: { full_name: 'mallory/hello', fork: true } } }));
    assert.equal(fork.kind === 'event' && fork.facts.fork, true);
  });
  it('issues and issue_comment', () => {
    const i = n('issues', { action: 'opened', issue: { number: 7, title: 'Broken', body: 'It broke', html_url: 'https://github.com/octo/hello/issues/7', labels: [] }, repository: ghRepo, sender: { login: 'octocat' } });
    assert.ok(i.kind === 'event' && i.facts.event === 'issue' && i.facts.action === 'opened' && i.facts.number === 7);
    const c = n('issue_comment', { action: 'created', issue: { number: 7, title: 'Broken' }, comment: { body: 'me too', html_url: 'https://github.com/octo/hello/issues/7#issuecomment-1' }, repository: ghRepo, sender: { login: 'octocat' } });
    assert.ok(c.kind === 'event');
    if (c.kind !== 'event') return;
    assert.equal(c.facts.event, 'comment');
    assert.deepEqual(c.facts.untrusted, { title: 'Broken', comment: 'me too' });
    assert.deepEqual(n('issue_comment', { action: 'edited', issue: { number: 7 }, comment: {}, repository: ghRepo }), { kind: 'ignore', why: 'unsupported_action' });
  });
  it('R12, R13: a hostile login and foreign or http links are null', () => {
    for (const bad of ['octo\ncat', 'a'.repeat(65), 'ökto', 'octo cat', '<b>x</b>', '\u202eevil']) {
      const r = n('push', { ref: 'refs/heads/main', after: SHA, repository: ghRepo, sender: { login: bad } });
      assert.equal(r.kind === 'event' && r.facts.sender, null, bad);
    }
    for (const url of ['https://evil.example/octo/hello/pull/1', 'http://github.com/octo/hello/pull/1', 'https://user:pw@github.com/x', 'javascript:alert(1)', 'https://github.com.evil.example/x']) {
      const r = n('pull_request', pr('opened', { html_url: url }));
      assert.equal(r.kind === 'event' && r.facts.url, null, url);
    }
  });
  it('R9: text is cleaned (control, zero-width, bidi), clipped and redacted', () => {
    const r = n('issues', { action: 'opened', issue: { number: 1, title: `Hi\u202e\u200bthere\u0007 ${'x'.repeat(400)}`, body: 'key sk-ant-api03-' + 'A'.repeat(90) }, repository: ghRepo, sender: { login: 'a' } });
    assert.ok(r.kind === 'event');
    if (r.kind !== 'event') return;
    assert.equal(r.facts.untrusted.title!.length, 300);
    assert.ok(r.facts.untrusted.title!.startsWith('Hithere '));
    assert.ok(!r.facts.untrusted.body!.includes('AAAAAAAAAA'), 'the key is redacted');
  });
});

describe('Gitea normalisation', () => {
  const n = (event: string, body: Record<string, unknown>, eventType?: string) =>
    normalizeDelivery('gitea', headers({ 'x-gitea-event': event, ...(eventType ? { 'x-gitea-event-type': eventType } : {}) }), body, 'git.example.com', AT);
  const repo = { full_name: 'team/app', html_url: 'https://git.example.com/team/app' };

  it('push (PushPayload: compare_url, commits, head_commit)', () => {
    const r = n('push', { ref: 'refs/heads/dev', before: '0'.repeat(40), after: SHA, compare_url: 'https://git.example.com/team/app/compare/a...b', commits: [{ message: 'one' }], head_commit: { message: 'one' }, repository: repo, pusher: { login: 'gitea' }, sender: { login: 'gitea' } });
    assert.ok(r.kind === 'event');
    if (r.kind !== 'event') return;
    assert.equal(r.facts.branch, 'dev');
    assert.equal(r.facts.url, 'https://git.example.com/team/app/compare/a...b');
    assert.equal(r.facts.provider, 'gitea');
  });
  it('pull_request: synchronized -> updated (Gitea spelling), label_updated -> labeled, fork by repository names', () => {
    const p = (action: string, head = 'team/app') => ({
      action,
      number: 3,
      pull_request: { number: 3, title: 'T', body: 'B', html_url: 'https://git.example.com/team/app/pulls/3', merged: false, base: { ref: 'main', repo: { full_name: 'team/app' } }, head: { sha: SHA, repo: { full_name: head } }, labels: [{ name: 'ready' }] },
      repository: repo,
      sender: { login: 'alice' },
    });
    const act = (x: ReturnType<typeof n>) => (x.kind === 'event' ? x.facts.action : x.why);
    assert.equal(act(n('pull_request', p('synchronized'))), 'updated');
    assert.equal(act(n('pull_request', p('synchronize'))), 'unsupported_action');
    assert.equal(act(n('pull_request', p('label_updated'), 'pull_request_label')), 'labeled');
    assert.equal(act(n('pull_request_label', p('label_updated'))), 'labeled');
    const f = n('pull_request', p('opened', 'bob/app'));
    assert.equal(f.kind === 'event' && f.facts.fork, true);
    const same = n('pull_request', p('opened'));
    assert.equal(same.kind === 'event' && same.facts.fork, false);
  });
  it('issues (number at the top) and comments on issues and pull requests', () => {
    const i = n('issues', { action: 'opened', number: 9, issue: { title: 'Bug', body: 'x', html_url: 'https://git.example.com/team/app/issues/9', labels: [] }, repository: repo, sender: { login: 'alice' } });
    assert.ok(i.kind === 'event' && i.facts.number === 9 && i.facts.event === 'issue');
    const c = n('issue_comment', { action: 'created', is_pull: true, issue: { number: 3, title: 'T' }, comment: { body: 'lgtm', html_url: 'https://git.example.com/team/app/pulls/3#issuecomment-5' }, repository: repo, sender: { login: 'alice' } }, 'pull_request_comment');
    assert.ok(c.kind === 'event' && c.facts.event === 'comment' && c.facts.number === 3);
  });
});

describe('GitLab normalisation (object_kind)', () => {
  const n = (body: Record<string, unknown>) => normalizeDelivery('gitlab', headers({ 'x-gitlab-event': 'Ignored Hook' }), body, 'gitlab.example.com', AT);
  const project = { path_with_namespace: 'grp/sub/proj', web_url: 'https://gitlab.example.com/grp/sub/proj' };

  it('push and tag_push; a deleted branch', () => {
    const r = n({ object_kind: 'push', ref: 'refs/heads/main', before: SHA, after: SHA, checkout_sha: SHA, user_username: 'jsmith', project, commits: [{ message: 'Update', url: 'https://gitlab.example.com/grp/sub/proj/-/commit/' + SHA }] });
    assert.ok(r.kind === 'event');
    if (r.kind !== 'event') return;
    assert.equal(r.facts.repo, 'grp/sub/proj');
    assert.equal(r.facts.sender, 'jsmith');
    assert.equal(r.facts.sha, SHA);
    assert.equal(r.facts.url, 'https://gitlab.example.com/grp/sub/proj/-/commit/' + SHA);
    assert.deepEqual(n({ object_kind: 'tag_push', ref: 'refs/tags/v1', project }), { kind: 'ignore', why: 'tag' });
    assert.deepEqual(n({ object_kind: 'push', ref: 'refs/heads/x', after: '0'.repeat(40), project }), { kind: 'ignore', why: 'deleted' });
  });
  it('merge_request: open, merge, update with oldrev -> updated, update with labels -> labeled, a title edit is ignored; fork by project ids', () => {
    const mr = (attrs: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      object_kind: 'merge_request',
      user: { username: 'jsmith' },
      project,
      labels: [{ title: 'review' }],
      object_attributes: { iid: 5, title: 'MR', description: 'D', url: 'https://gitlab.example.com/grp/sub/proj/-/merge_requests/5', target_branch: 'main', source_project_id: 1, target_project_id: 1, last_commit: { id: SHA }, ...attrs },
      ...extra,
    });
    const act = (x: ReturnType<typeof n>) => (x.kind === 'event' ? x.facts.action : x.why);
    assert.equal(act(n(mr({ action: 'open' }))), 'opened');
    assert.equal(act(n(mr({ action: 'merge' }))), 'merged');
    assert.equal(act(n(mr({ action: 'update', oldrev: SHA }))), 'updated');
    assert.equal(act(n(mr({ action: 'update' }, { changes: { labels: { previous: [], current: [{ title: 'review' }] } } }))), 'labeled');
    assert.equal(act(n(mr({ action: 'update' }, { changes: { title: { previous: 'a', current: 'b' } } }))), 'unsupported_action');
    const o = n(mr({ action: 'open' }));
    assert.ok(o.kind === 'event' && o.facts.number === 5 && o.facts.branch === 'main' && o.facts.sha === SHA && o.facts.fork === false);
    const f = n(mr({ action: 'open', source_project_id: 2 }));
    assert.equal(f.kind === 'event' && f.facts.fork, true);
  });
  it('issue and note (on an issue, on a merge request; a commit note is ignored)', () => {
    const i = n({ object_kind: 'issue', user: { username: 'jsmith' }, project, object_attributes: { iid: 23, action: 'open', title: 'New API', description: 'd', url: 'https://gitlab.example.com/grp/sub/proj/-/issues/23' } });
    assert.ok(i.kind === 'event' && i.facts.event === 'issue' && i.facts.number === 23 && i.facts.action === 'opened');
    const note = n({ object_kind: 'note', user: { username: 'jsmith' }, project, object_attributes: { note: 'Hello', noteable_type: 'MergeRequest', url: 'https://gitlab.example.com/grp/sub/proj/-/merge_requests/5#note_1' }, merge_request: { iid: 5, title: 'MR', target_branch: 'main' } });
    assert.ok(note.kind === 'event');
    if (note.kind !== 'event') return;
    assert.equal(note.facts.event, 'comment');
    assert.equal(note.facts.number, 5);
    assert.equal(note.facts.branch, 'main');
    assert.equal(note.facts.untrusted.comment, 'Hello');
    assert.deepEqual(n({ object_kind: 'note', project, object_attributes: { note: 'x', noteable_type: 'Commit' } }), { kind: 'ignore', why: 'unsupported_action' });
  });
});

describe('a check on the helpers themselves', () => {
  it('the hex HMAC of the §9 body is the documented digest (two implementations agree)', () => {
    assert.equal(hex("It's a Secret to Everybody", 'Hello, World!'), '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17');
  });
});
