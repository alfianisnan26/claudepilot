// QA regression (QA-010): the login rate limiter blocks after its limit, forgets after its window, and does not grow without bound.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { RateLimiter } from '../rateLimit.js';

test('blocks at the limit, clears on success, and forgets after the window', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const limiter = new RateLimiter(3, 60_000);
    for (let i = 0; i < 2; i++) limiter.fail('a');
    assert.equal(limiter.blocked('a'), false);
    limiter.fail('a');
    assert.equal(limiter.blocked('a'), true, 'blocked at the limit');
    assert.equal(limiter.blocked('b'), false, 'another address is not');
    mock.timers.tick(60_001);
    assert.equal(limiter.blocked('a'), false, 'free again after the window');
    limiter.fail('a');
    limiter.reset('a');
    assert.equal(limiter.size, 0, 'a good sign-in clears the address');
  } finally {
    mock.timers.reset();
  }
});

test('addresses that never come back are swept, so the table stays bounded', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const limiter = new RateLimiter(10, 1_000);
    for (let i = 0; i < 10_000; i++) limiter.fail(`old-${i}`);
    assert.equal(limiter.size, 10_000);
    mock.timers.tick(1_001);
    limiter.fail('fresh');
    assert.equal(limiter.size, 1, 'every expired entry went when the table was full');
    assert.equal(limiter.blocked('fresh'), false);
    // A flood inside one window cannot push the table past its cap either.
    for (let i = 0; i < 12_000; i++) limiter.fail(`flood-${i}`);
    assert.ok(limiter.size <= 10_000, `size ${limiter.size}`);
  } finally {
    mock.timers.reset();
  }
});
