// T-591 (QA gap G2): the vault sink swallows only "not found"; every other error is rethrown, so a report is never rebuilt from nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeError } from '../knowledge/errors.js';
import { vaultReleaseNotes } from './releaseNotesVault.js';

const actor = {} as never;
const notFound = () => new KnowledgeError('NOT_FOUND', 'no such thing');
const others = [new KnowledgeError('UNAVAILABLE', 'vault busy'), new KnowledgeError('VAULT_UNAVAILABLE', 'no access'), new Error('disk failure'), new TypeError('boom')];

function sink(over: { getNote?: () => unknown; summary?: () => unknown; putNote?: (...a: unknown[]) => unknown }) {
  const puts: unknown[][] = [];
  const notes = {
    getNote: over.getNote ?? (() => ({ content: 'old', version: 'v1' })),
    summary: over.summary ?? (() => ({})),
    putNote: (...a: unknown[]) => {
      puts.push(a);
      return (over.putNote ?? (() => ({ created: false, unchanged: false })))(...a);
    },
  };
  return { s: vaultReleaseNotes(notes as never, actor), puts };
}

test('exists: true when the vault answers, false only for NOT_FOUND, any other error is rethrown', () => {
  assert.equal(sink({}).s.exists('v'), true);
  assert.equal(sink({ summary: () => { throw notFound(); } }).s.exists('v'), false);
  for (const e of others) assert.throws(() => sink({ summary: () => { throw e; } }).s.exists('v'), (got) => got === e);
});

test('read: the content, null only for NOT_FOUND, any other error is rethrown', () => {
  assert.equal(sink({}).s.read('v', 'a.md'), 'old');
  assert.equal(sink({ getNote: () => { throw notFound(); } }).s.read('v', 'a.md'), null);
  for (const e of others) assert.throws(() => sink({ getNote: () => { throw e; } }).s.read('v', 'a.md'), (got) => got === e);
});

test('put: replaces with the note\'s own version, creates when missing, and writes nothing when the read fails otherwise', () => {
  const have = sink({ putNote: () => ({ created: false, unchanged: true }) });
  assert.deepEqual(have.s.put('v', 'a.md', 'new'), { created: false, unchanged: true });
  assert.deepEqual(have.puts[0]!.slice(0, 3), ['v', 'a.md', { content: 'new', baseVersion: 'v1' }]);

  const missing = sink({ getNote: () => { throw notFound(); }, putNote: () => ({ created: true, unchanged: false }) });
  assert.deepEqual(missing.s.put('v', 'a.md', 'new'), { created: true, unchanged: false });
  assert.deepEqual(missing.puts[0]!.slice(0, 3), ['v', 'a.md', { content: 'new', create: true }]);

  for (const e of others) {
    const broken = sink({ getNote: () => { throw e; } });
    assert.throws(() => broken.s.put('v', 'a.md', 'new'), (got) => got === e);
    assert.equal(broken.puts.length, 0, 'nothing is written from an unknown state');
  }
});
