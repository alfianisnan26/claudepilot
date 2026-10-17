// The session page's alias redirect (owner, 2026-10-17): following the crew line's lead pill from a worker must open the lead, not bounce
// back to the worker whose session is still loaded on the first render of the new route.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aliasRedirect } from './aliasRedirect';

describe('aliasRedirect', () => {
  it('does not redirect on the render where the route moved to another session (the old session is still loaded)', () => {
    assert.equal(aliasRedirect('worker', 'lead', 'worker'), null);
  });
  it('redirects an alias id to the chat it now belongs to, once that chat is loaded for this route', () => {
    assert.equal(aliasRedirect('old-alias', 'old-alias', 'current'), '/admin/sessions/current');
  });
  it('does nothing while nothing is loaded or when the ids agree', () => {
    assert.equal(aliasRedirect('lead', 'lead', null), null);
    assert.equal(aliasRedirect('lead', 'lead', 'lead'), null);
  });
});
