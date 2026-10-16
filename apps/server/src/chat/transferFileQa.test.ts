// QA T-781 S4 (lane-cp-qa-perf): the context file's redaction, its 4,000,000 bound, size and time, and the write command's modes.
// Every credential-shaped value is built here at run time and never printed: the output only names probes and counts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChatEvent } from '@portal/contracts';
import { FILE_MAX_CHARS, FILE_MESSAGE_MAX_CHARS, transferFile, transferFileConversation, transferOpening, transferConversation, conversationBudget, type TransferMeta } from './transfer.js';
import { EVENT_TEXT_MAX } from './store.js';

const hex = (n: number) => randomBytes(n).toString('hex');
let seq = 0;
const ev = (e: Omit<ChatEvent, 'seq' | 'at'>): ChatEvent => ({ seq: ++seq, at: '2026-10-16T12:00:00Z', ...e });
const meta: TransferMeta = { handoffId: '00000000-0000-4000-8000-000000000000', at: new Date('2026-10-16T12:00:00Z'), workspaceId: 'docker/ws1', cwd: '/home/node/p', sourceSessionId: 'src', fromClaude: 'Satria', toClaude: 'Default', path: '/home/node/.claudepilot/transfer/00000000-0000-4000-8000-000000000000.md' };
const file = (events: ChatEvent[], note?: string) => transferFile(meta, transferFileConversation(events), note, ['a fact']);

test('QA-S1 (1) a credential in user text, assistant text, an Earlier-context message, an actor message, a tool line and the handoff note never reaches the file', () => {
  const t = {
    a: `sk-ant-${'api03-'}${hex(30)}`,
    g: `ghp_${hex(20)}`,
    p: `cpat_${hex(24)}`,
    k: hex(20),
  };
  const events = [
    ev({ kind: 'user', text: `my key ${t.a} please` }),
    ev({ kind: 'assistant', text: `I saw ${t.g} in the log` }),
    ev({ kind: 'user', text: `earlier ${t.p} and password=${t.k}`, transfer: { fromClaude: 'Old' } as never }),
    ev({ kind: 'user', text: `from an agent ${t.g}`, actor: 'portal:agent', actorLabel: 'x' } as never),
    ev({ kind: 'tool_use', toolName: 'Bash', text: `curl -H "Authorization: Bearer ${t.k}${t.k}"` } as never),
  ];
  const out = file(events, `note with ${t.a}`);
  for (const [name, v] of Object.entries(t)) assert.ok(!out.includes(v), `value ${name} (hash-length ${v.length}) reached the file`);
  assert.ok(out.includes('[redacted]'));
});

test('QA-S1b a credential that straddles the per-message clip: how much of it survives (observation, asserted to at most 12 characters of the body)', () => {
  const body = hex(20);
  const token = `ghp_${body}`;
  // The clip is at FILE_MESSAGE_MAX_CHARS; the token starts 23 characters before it, so the cut leaves ghp_ + 19 body characters.
  const filler = 'x '.repeat(Math.floor((FILE_MESSAGE_MAX_CHARS - 23) / 2));
  const text = `${filler}${token}`.padEnd(FILE_MESSAGE_MAX_CHARS + 50, 'z');
  const out = file([ev({ kind: 'user', text: `${text}` })]);
  let n = 0;
  while (n < body.length && out.includes(`ghp_${body.slice(0, n + 1)}`)) n++;
  console.log(`QA-S1b surviving body characters after the clip: ${n}`);
  assert.ok(n <= 12, `${n} body characters of a ghp_ token survive the clip`);
});

test('QA-S1c an unterminated private-key block in an OLD message must not swallow the newer messages (observation)', () => {
  const head = '-----BEGIN ' + 'PRIVATE KEY-----';
  const events = [
    ev({ kind: 'user', text: `${head}\n${'A'.repeat(FILE_MESSAGE_MAX_CHARS + 100)}` }),
    ev({ kind: 'assistant', text: 'NEWER-MESSAGE-MARKER-1' }),
    ev({ kind: 'user', text: 'NEWER-MESSAGE-MARKER-2' }),
  ];
  const out = file(events);
  console.log(`QA-S1c newer markers present: ${out.includes('NEWER-MESSAGE-MARKER-1')} ${out.includes('NEWER-MESSAGE-MARKER-2')}`);
  assert.ok(out.includes('NEWER-MESSAGE-MARKER-1') && out.includes('NEWER-MESSAGE-MARKER-2'), 'the later messages were redacted away with the key block');
});

test('QA-S2 (2) the bound: 300 x 15,000 is cut to <= 4,000,000, newest kept, and the file header and heading count agree', () => {
  const chat = Array.from({ length: 300 }, (_, i) => ev({ kind: i % 2 ? 'assistant' : 'user', text: `m${i} ${'z'.repeat(15_000)} end${i}` }));
  const conv = transferFileConversation(chat);
  assert.equal(conv.truncated, true);
  assert.ok(conv.text.length <= FILE_MAX_CHARS, `text ${conv.text.length}`);
  const out = transferFile(meta, conv, undefined, []);
  const headings = out.split('\n').filter((l) => l === '### You' || l === '### Claude').length;
  console.log(`QA-S2 messages=${conv.messages} headings=${headings} textChars=${conv.text.length} fileChars=${out.length}`);
  assert.equal(headings, conv.messages, 'the header count matches the file');
  assert.match(out, new RegExp(`The last ${conv.messages} messages; older ones were left out\\.`));
  assert.ok(out.includes(' end299') && !out.includes(' m0 '), 'newest kept, oldest gone');
  // The whole file with a 6,000 note and the framing stays within the bound plus a small slack.
  assert.ok(out.length <= FILE_MAX_CHARS + 10_000, `file ${out.length} chars`);
  // A bound in characters is not bytes: the same count of multi-byte characters.
  const wide = Array.from({ length: 300 }, (_, i) => ev({ kind: i % 2 ? 'assistant' : 'user', text: `m${i} ${'日'.repeat(15_000)} end${i}` }));
  const w = transferFile(meta, transferFileConversation(wide), undefined, []);
  console.log(`QA-S2 multibyte: chars=${w.length} bytes=${Buffer.byteLength(w)}`);
});

test('QA-S2b the opening of a chat whose FILE is cut must not say the file holds every message', () => {
  const chat = Array.from({ length: 300 }, (_, i) => ev({ kind: i % 2 ? 'assistant' : 'user', text: `m${i} ${'z'.repeat(EVENT_TEXT_MAX - 20)}` }));
  const fileConv = transferFileConversation(chat);
  const opening = transferOpening(meta, transferConversation(chat, conversationBudget(meta, EVENT_TEXT_MAX)));
  console.log(`QA-S2b fileTruncated=${fileConv.truncated} fileMessages=${fileConv.messages} openingSaysEvery=${/every message/.test(opening)}`);
  assert.ok(!(fileConv.truncated && /every message/.test(opening)), 'the opening says every message is in the file, but the file left older ones out');
});

test('QA-S3 (3) 300 x 16,000 (the store caps a text at 16,000): file size and time, plain and adversarial text', () => {
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const run = (label: string, mk: (i: number) => string) => {
    const chat = Array.from({ length: 300 }, (_, i) => ev({ kind: i % 2 ? 'assistant' : 'user', text: mk(i).slice(0, EVENT_TEXT_MAX) }));
    const ts: number[] = [];
    let out = '';
    const heap0 = process.memoryUsage().heapUsed;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      out = transferFile(meta, transferFileConversation(chat), undefined, ['f']);
      ts.push(performance.now() - t0);
    }
    const heap = Math.round((process.memoryUsage().heapUsed - heap0) / 1e6);
    console.log(`QA-S3 ${label}: chars=${out.length} bytes=${Buffer.byteLength(out)} median=${Math.round(med(ts))}ms p95~max=${Math.round(Math.max(...ts))}ms heapDelta=${heap}MB`);
    return Math.max(...ts);
  };
  run('plain', (i) => `m${i} ${'lorem ipsum dolor '.repeat(1000)}`);
  const worst = run('adversarial (key= and token: runs)', (i) => `m${i} ${'api_key= a1 token: b2 secret=c3 Bearer d4 '.repeat(400)}`);
  run('adversarial (unterminated assignment values)', (i) => `m${i} ${('password=' + 'ab12'.repeat(8)).repeat(500)}`);
  assert.ok(worst < 30_000, `worst run ${worst} ms`);
});

test('QA-S4 (4) the write command as the controller runs it: a path guard and the file mode it leaves (the portal user\'s umask)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-qa781-'));
  try {
    const dir = join(root, '.claudepilot', 'transfer');
    const path = join(dir, `${meta.handoffId}.md`);
    const body = 'x\n';
    const r = spawnSync('sh', ['-c', 'mkdir -p -- "$1" && head -c "$3" > "$2"', 'sh', dir, path, String(Buffer.byteLength(body))], { input: body });
    assert.equal(r.status, 0);
    assert.equal(readFileSync(path, 'utf8'), body);
    const mf = (statSync(path).mode & 0o777).toString(8), md = (statSync(dir).mode & 0o777).toString(8);
    console.log(`QA-S4 file mode ${mf}, dir mode ${md} (umask as in this Job)`);
    assert.equal(mf[1], '0', 'group has no access to the context file');
    assert.equal(mf[2], '0', 'others have no access to the context file');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
