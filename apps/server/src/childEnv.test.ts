import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childEnv, withoutHeapFlag } from './childEnv.js';

test('withoutHeapFlag drops only the V8 heap-size flag, in either spelling (T-2615)', () => {
  assert.equal(withoutHeapFlag(undefined), undefined);
  assert.equal(withoutHeapFlag('--max-old-space-size=1536'), undefined);
  assert.equal(withoutHeapFlag('--max_old_space_size=1536'), undefined);
  assert.equal(withoutHeapFlag('  --max-old-space-size=1536   --disable-warning=ExperimentalWarning '), '--disable-warning=ExperimentalWarning');
  assert.equal(withoutHeapFlag('--enable-source-maps --max-old-space-size=900 --trace-warnings'), '--enable-source-maps --trace-warnings');
  assert.equal(withoutHeapFlag('--max-semi-space-size=16'), '--max-semi-space-size=16', 'another size flag is not the heap cap');
});

test('childEnv copies the environment without the heap cap and leaves the original alone', () => {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/node', NODE_OPTIONS: '--max-old-space-size=1536' };
  const out = childEnv(env);
  assert.deepEqual(out, { PATH: '/usr/bin', HOME: '/home/node' });
  assert.equal('NODE_OPTIONS' in out, false);
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=1536');
  assert.deepEqual(childEnv({ PATH: '/bin', NODE_OPTIONS: '--max-old-space-size=1536 --enable-source-maps' }), { PATH: '/bin', NODE_OPTIONS: '--enable-source-maps' });
  assert.deepEqual(childEnv({ PATH: '/bin' }), { PATH: '/bin' });
});
