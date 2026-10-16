import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BROWSER_POOL_DEFAULTS, type BrowserHeaderRule, type BrowserPoolContent } from '@portal/contracts';
import { addRule, blankRule, editRule, MAX_HEADER_RULES, parseHosts, removeRule } from './headerRules';

// T-856: the Browser pool editor shows and edits a header rule's `key` (T-623 S2) and never drops it on save.
const rules = (): BrowserHeaderRule[] => [
  { hosts: ['app.example.com'], name: 'CF-Access-Client-Id', secret: 'cf-access', key: 'CF_ID' },
  { hosts: ['*.example.com', 'api.example.com:8443'], name: 'CF-Access-Client-Secret', secret: 'cf-access', key: 'CF_SECRET' },
  { hosts: ['plain.example.com'], name: 'X-Token', secret: 'plain-token' },
];

test('a saved rule keeps its key: editing any other field of any rule, then a JSON save, loses no key', () => {
  let c: BrowserPoolContent = { ...BROWSER_POOL_DEFAULTS, headers: rules() };
  const edit = (i: number, field: 'hosts' | 'name' | 'secret', text: string) => {
    c = { ...c, headers: editRule(c.headers, i, field, text) };
  };
  edit(0, 'name', 'CF-Access-Client-Id2');
  edit(0, 'secret', 'cf-access-2');
  edit(1, 'hosts', 'a.example.com, b.example.com');
  const saved = JSON.parse(JSON.stringify(c)) as BrowserPoolContent;
  assert.deepEqual(saved.headers.map((h) => h.key), ['CF_ID', 'CF_SECRET', undefined]);
  assert.equal(saved.headers[0]!.name, 'CF-Access-Client-Id2');
  assert.deepEqual(saved.headers[1]!.hosts, ['a.example.com', 'b.example.com']);
  assert.ok(!('key' in saved.headers[2]!), 'a rule without a key stays without one');
});

test('editing the key changes only that rule, trims it, and an empty key removes the property', () => {
  const before = rules();
  const after = editRule(before, 0, 'key', '  OTHER_VAR ');
  assert.equal(after[0]!.key, 'OTHER_VAR');
  assert.equal(after[1], before[1], 'the other rules are the same objects');
  assert.equal(before[0]!.key, 'CF_ID', 'the input is not mutated');
  const cleared = editRule(after, 0, 'key', '   ');
  assert.ok(!('key' in cleared[0]!), 'an empty key is no key (the server refuses "" as a variable name)');
  assert.deepEqual(editRule(rules(), 2, 'key', 'NEW')[2], { hosts: ['plain.example.com'], name: 'X-Token', secret: 'plain-token', key: 'NEW' });
});

test('a field the editor does not know survives an edit (a rule set through the API)', () => {
  const odd = [{ hosts: ['a.example.com'], name: 'X-A', secret: 's', key: 'K', future: 1 }] as unknown as BrowserHeaderRule[];
  const next = editRule(odd, 0, 'name', 'X-B')[0] as unknown as Record<string, unknown>;
  assert.equal(next.future, 1);
  assert.equal(next.key, 'K');
});

test('hosts parse from new lines, commas and spaces; add is capped; remove keeps the rest', () => {
  assert.deepEqual(parseHosts('a.com,\n b.com  *.c.com\n'), ['a.com', 'b.com', '*.c.com']);
  assert.deepEqual(parseHosts(' \n'), []);
  let r: BrowserHeaderRule[] = [];
  for (let i = 0; i < MAX_HEADER_RULES + 3; i++) r = addRule(r);
  assert.equal(r.length, MAX_HEADER_RULES);
  assert.deepEqual(r[0], blankRule());
  assert.deepEqual(removeRule(rules(), 1).map((h) => h.name), ['CF-Access-Client-Id', 'X-Token']);
});

test('the editor wires the key: a Key field on every rule, through editRule, with a tip, and no value of a secret', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'BrowserEditor.tsx'), 'utf8');
  assert.match(src, /editRule\(c\.headers, i, 'key'/);
  assert.match(src, /<Tip label="Key">/);
  assert.match(src, /value=\{rule\.key \?\? ''\}/);
  assert.match(src, /editRule\(c\.headers, i, 'secret'/);
  // the pool holds names: the editor never renders a secret's value
  assert.doesNotMatch(src, /secretValue|\.secret\.value|secrets\.value/);
});
