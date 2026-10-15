import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedRead } from './sharedRead';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('an effect that runs twice for one open sends one read', async () => {
  const reads: string[] = [];
  const d = deferred<number>();
  const read = sharedRead((id) => {
    reads.push(id);
    return d.promise;
  });
  const first = read('s1'); // the effect
  const second = read('s1'); // its remount, before the first answer
  assert.deepEqual(reads, ['s1']);
  d.resolve(7);
  assert.deepEqual(await Promise.all([first, second]), [7, 7]);
});

test('another session reads on its own, and a settled read is read afresh', async () => {
  let n = 0;
  const read = sharedRead(async (id) => `${id}:${++n}`);
  assert.equal(await read('a'), 'a:1');
  assert.equal(await read('b'), 'b:2');
  assert.equal(await read('a'), 'a:3');
});

test('a failed read is forgotten so the next open can retry', async () => {
  let n = 0;
  const read = sharedRead(async () => {
    if (++n === 1) throw new Error('down');
    return 'ok';
  });
  await assert.rejects(read('a'), /down/);
  assert.equal(await read('a'), 'ok');
  assert.equal(n, 2);
});
