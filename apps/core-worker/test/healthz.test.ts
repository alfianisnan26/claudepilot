import { AppError } from '@isnanme/core';
import { CONNECT_PROTOCOL } from '@portal/contracts';
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Healthz } from '../src/app.js';

describe('cp-next-core HTTP', () => {
  it('GET /healthz answers with the service, version and commit', async () => {
    const res = await SELF.fetch('https://core.test/healthz');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const body = await res.json<Healthz>();
    expect(body).toEqual({ ok: true, service: 'cp-next-core', version: '0.0.0', commit: 'dev', connectProtocol: CONNECT_PROTOCOL });
  });

  it('an unknown path is the portal’s plain 404 body', async () => {
    for (const path of ['/nope', '/api/workspaces/x', '/bridge']) {
      const res = await SELF.fetch(`https://core.test${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual(new AppError('NOT_FOUND', 'Not found.').toJSON());
    }
  });

  it('a wrong method on /healthz is a 404 too, not a framework page', async () => {
    const res = await SELF.fetch('https://core.test/healthz', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(new AppError('NOT_FOUND', 'Not found.').toJSON());
  });
});
