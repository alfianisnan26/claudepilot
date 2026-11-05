// src/bridge/redact.ts (PILOT-1188): the detail of an internal failure, made safe for the audit. Fixtures are built at runtime.

import { describe, expect, it } from 'vitest';
import { redactDetail } from '../src/bridge/redact.js';

describe('redactDetail', () => {
  it('masks a bearer, a key=value secret and a long token-like run; keeps plain text', () => {
    const short = crypto.randomUUID().slice(0, 8);
    const long = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const out = redactDetail(`failed: Authorization: Bearer ${short}, token=${short} body ${long} end`);
    expect(out).not.toContain(short);
    expect(out).not.toContain(long);
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('token=[redacted]');
    expect(out).toMatch(/end$/);
    expect(redactDetail('not an HTTP/1.1 response')).toBe('not an HTTP/1.1 response');
  });

  it('cuts to 200 characters', () => {
    expect(redactDetail('word '.repeat(100))).toHaveLength(200);
  });
});
