// Owner need 2026-11-01 (an AI agent's account with Portal MCP access limited to one org): the console's Add member and New token sheets.
// The rules the forms check (the server checks each again): never an owner, admin scope only for an admin account, a lifetime from the list,
// no default workspace on a read token, only accounts that are active and not in the org yet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdminMintedToken, AdminOrgDetail, AdminUserDetail, AdminUserRow, OrgMember } from '@portal/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddMemberSheet, NewTokenSheet, TokenSecretSheet } from './forms';
import { addableAccounts, MEMBER_ROLES, memberRequest, mintRequest, tokenScopes } from './model';
import type { Run } from './ui';

const at = '2026-11-01T00:00:00.000Z';
const row = (id: string, email: string, extra: Partial<AdminUserRow> = {}): AdminUserRow => ({ id, email, displayName: email, role: 'member', state: 'active', createdAt: at, lastLoginAt: null, abilities: [], ...extra });
const member = (userId: string, role: OrgMember['role']): OrgMember => ({ userId: userId as OrgMember['userId'], email: `${userId}@x.test`, displayName: userId, role, via: 'invite', joinedAt: at });
const run: Run = async () => undefined;
const detail = (role: 'admin' | 'member'): AdminUserDetail => ({ ...row('u_agent', 'afgan.ai@konfersi.example', { role }), sessions: { portal: 0, admin: 0 }, tokens: [] });
const options = (html: string, selectIndex: number) => [...(html.split('<select')[selectIndex + 1] ?? '').split('</select>')[0]!.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);

test('tokenScopes and mintRequest: admin scope only for an admin account; a label, a listed lifetime, no workspace on a read token', () => {
  assert.deepEqual(tokenScopes('member'), ['read', 'operate']);
  assert.deepEqual(tokenScopes('admin'), ['read', 'operate', 'admin']);
  const ok = mintRequest({ label: '  Afgan  ', scope: 'operate', days: 90, workspace: 'docker/konf-api' }, 'member');
  assert.deepEqual(ok, { req: { label: 'Afgan', scope: 'operate', expiresInDays: 90, defaultWorkspaceId: 'docker/konf-api' } });
  assert.deepEqual(mintRequest({ label: 'Afgan', scope: 'read', days: 7, workspace: '' }, 'member'), { req: { label: 'Afgan', scope: 'read', expiresInDays: 7 } });
  for (const [form, role, why] of [
    [{ label: ' ', scope: 'operate', days: 90, workspace: '' }, 'member', 'a label'],
    [{ label: 'x'.repeat(61), scope: 'operate', days: 90, workspace: '' }, 'member', 'too long'],
    [{ label: 'Afgan', scope: 'admin', days: 90, workspace: '' }, 'member', 'admin scope for a member'],
    [{ label: 'Afgan', scope: 'operate', days: 3, workspace: '' }, 'member', 'a lifetime not offered'],
    [{ label: 'Afgan', scope: 'read', days: 90, workspace: 'docker/konf-api' }, 'member', 'a workspace on a read token'],
  ] as const)
    assert.ok('error' in mintRequest(form, role), why);
  assert.ok('req' in mintRequest({ label: 'ops', scope: 'admin', days: 30, workspace: '' }, 'admin'), 'an admin account may get admin scope');
});

test('memberRequest and addableAccounts: never an owner; an existing account or a new email; only active accounts not in the org', () => {
  assert.deepEqual([...MEMBER_ROLES], ['admin', 'member', 'guest']);
  assert.deepEqual(memberRequest({ mode: 'existing', userId: 'u_a', email: '', name: '', role: 'member' }), { req: { userId: 'u_a', role: 'member' } });
  assert.deepEqual(memberRequest({ mode: 'new', userId: 'u_ignored', email: ' afgan.ai@konfersi.example ', name: ' Afgan ', role: 'member' }), {
    req: { email: 'afgan.ai@konfersi.example', displayName: 'Afgan', role: 'member' },
  });
  assert.ok('error' in memberRequest({ mode: 'existing', userId: '', email: '', name: '', role: 'member' }));
  assert.ok('error' in memberRequest({ mode: 'new', userId: '', email: 'not-an-email', name: '', role: 'member' }));
  assert.ok('error' in memberRequest({ mode: 'existing', userId: 'u_a', email: '', name: '', role: 'owner' as never }), 'never an owner');
  const users = [row('u_a', 'a@x.test'), row('u_b', 'b@x.test'), row('u_c', 'c@x.test', { state: 'disabled' })];
  assert.deepEqual(addableAccounts(users, [member('u_a', 'owner')]).map((u) => u.id), ['u_b']);
});

test('New token sheet: a member is offered read and operate only, an admin also admin; the lifetimes and its default workspaces', () => {
  const ws = [{ id: 'docker/konf-api', label: 'konf-api' }];
  const forMember = renderToStaticMarkup(createElement(NewTokenSheet, { user: detail('member'), run, workspaces: ws, onDone: () => undefined, onClose: () => undefined }));
  assert.match(forMember, /aria-label="New token"/);
  assert.match(forMember, /Acts as afgan\.ai@konfersi\.example/);
  assert.deepEqual(options(forMember, 0), ['read', 'operate']);
  assert.deepEqual(options(forMember, 1), ['7', '30', '90', '365']);
  assert.deepEqual(options(forMember, 2), ['', 'docker/konf-api']);
  const forAdmin = renderToStaticMarkup(createElement(NewTokenSheet, { user: detail('admin'), run, workspaces: ws, onDone: () => undefined, onClose: () => undefined }));
  assert.deepEqual(options(forAdmin, 0), ['read', 'operate', 'admin']);
});

test('Add member sheet: roles admin, member, guest (no owner); the accounts offered are active ones not in the org yet', () => {
  const org = { id: 'org_k', name: 'Konfersi', memberList: [member('u_a', 'owner')] } as unknown as AdminOrgDetail;
  const html = renderToStaticMarkup(
    createElement(AddMemberSheet, { org, run, accounts: [row('u_a', 'a@x.test'), row('u_b', 'b@x.test'), row('u_c', 'c@x.test', { state: 'disabled' })], onDone: () => undefined, onClose: () => undefined }),
  );
  assert.match(html, /aria-label="Add member"/);
  assert.deepEqual(options(html, 0), ['', 'u_b']);
  assert.deepEqual(options(html, 1), ['admin', 'member', 'guest']);
});

test('the new token is shown once with the MCP URL when the portal knows it', () => {
  const minted: AdminMintedToken = {
    token: { kind: 'pmcp', id: 'ptk_1', label: 'Afgan', createdAt: at, expiresAt: at, lastUsedAt: null, revokedAt: null, scope: 'operate' },
    // Built at run time: no token-shaped literal in the source.
    secret: ['cpat', 'x'.repeat(43)].join('_'),
    mcpUrl: 'https://pilot.example.test/mcp',
  };
  const html = renderToStaticMarkup(createElement(TokenSecretSheet, { minted, onClose: () => undefined }));
  assert.match(html, /shown once/);
  assert.ok(html.includes(minted.secret));
  assert.match(html, /aria-label="MCP URL"/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(TokenSecretSheet, { minted: { ...minted, mcpUrl: null }, onClose: () => undefined })), /MCP URL/);
});
