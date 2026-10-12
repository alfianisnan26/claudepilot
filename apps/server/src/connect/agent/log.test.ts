// T-AGENT / T-SEC: the agent's log (docs/prd/targets-connect.md §11.7, FR30): plain lines, levels, values trimmed, what is registered as secret or shaped
// like one replaced in the finished line, rotation of the host agent's file (5 files), and the hook that sends warnings and errors to the portal.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createLogger, isLogLevel } from './log.js';

const make = (opts: Parameters<typeof createLogger>[0] = {}) => {
  const lines: string[] = [];
  const logger = createLogger({ sink: (l) => lines.push(l), now: () => new Date('2026-10-12T09:00:00.000Z'), ...opts });
  return { logger, lines };
};

describe('the agent log', () => {
  it('writes plain lines: time, level, event, key=value; and keeps to its level', () => {
    const { logger, lines } = make({ level: 'info' });
    logger.debug('hidden');
    logger.info('connected', { node: 'nd_0123456789ab', held: 12, ok: true, none: null, skipped: undefined });
    logger.warn('connect.retry', { reason: 'has spaces and "quotes"' });
    assert.deepEqual(lines, ['2026-10-12T09:00:00.000Z INFO  connected node=nd_0123456789ab held=12 ok=true none=null\n', '2026-10-12T09:00:00.000Z WARN  connect.retry reason="has spaces and \\"quotes\\""\n']);
    assert.equal(isLogLevel('debug') && isLogLevel('error') && !isLogLevel('trace'), true);
  });

  it('trims values, and a newline in a value cannot start another line', () => {
    const { logger, lines } = make();
    logger.info('x', { long: 'a'.repeat(500), forged: 'ok\n2026-10-12T09:00:00.000Z ERROR fake line' });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.split('\n').length, 2, 'one line and its newline');
    assert.ok(lines[0]!.length < 400);
  });

  it('replaces registered secrets and secret-shaped text wherever they appear, in the event and in the values', () => {
    const { logger, lines } = make();
    const token = ['cpen_', 'A'.repeat(43)].join('');
    logger.addSecret('s3cret-value-xyz');
    logger.addSecret('abc'); // too short: ignored, it would mangle ordinary text
    logger.info('see s3cret-value-xyz', { a: 's3cret-value-xyz', b: `Bearer abcdefghijkl.mnop`, c: token, d: `prefix ${token} suffix`, plain: 'abc def' });
    logger.error('key', { k: ['MC4CAQAwBQYDK2VwBCIEI', 'x'.repeat(40)].join('') });
    const text = lines.join('');
    for (const bad of ['s3cret-value-xyz', 'abcdefghijkl', token, 'x'.repeat(40)]) assert.equal(text.includes(bad), false, bad);
    assert.match(text, /plain="abc def"/);
    assert.equal((text.match(/\[redacted\]/g) ?? []).length >= 5, true);
  });

  it('sends warnings and errors to the hook (the portal’s log message) once it is set, and stops when it is cleared', () => {
    const { logger } = make();
    const seen: string[] = [];
    logger.warn('before');
    logger.setRemote!((level, message) => seen.push(`${level}:${message}`));
    logger.info('not this');
    logger.warn('w', { n: 1 });
    logger.error('e');
    logger.setRemote!(null);
    logger.warn('after');
    assert.deepEqual(seen, ['warn:w n=1', 'error:e']);
  });

  it('keeps a host agent’s file in rotation: agent.log and four older files, each within its size, mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cx2-log-'));
    try {
      const path = join(dir, 'logs', 'agent.log');
      const { logger } = make({ file: { path, maxBytes: 600, keep: 5 }, sink: () => undefined });
      for (let i = 0; i < 80; i++) logger.info('event', { i, pad: 'p'.repeat(40) });
      const files = readdirSync(join(dir, 'logs')).sort();
      assert.deepEqual(files, ['agent.log', 'agent.log.1', 'agent.log.2', 'agent.log.3', 'agent.log.4']);
      for (const f of files) assert.ok(statSync(join(dir, 'logs', f)).size <= 600 + 200, f);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.match(readFileSync(path, 'utf8'), /event i=\d+/);
      const newest = Number(/i=(\d+)/.exec(readFileSync(path, 'utf8').trim().split('\n').at(-1)!)![1]);
      assert.equal(newest, 79, 'the newest line is in agent.log');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws, whatever happens to the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cx2-log-'));
    try {
      writeFileSync(join(dir, 'blocker'), 'a file where a folder is needed');
      const { logger } = make({ file: { path: join(dir, 'blocker', 'agent.log') } });
      assert.doesNotThrow(() => logger.error('still fine'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
