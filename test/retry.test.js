'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { withRetry, withTimeout, backoff } = require('../src/retry');
const { TransientError, PermanentError, isRetryable } = require('../src/errors');

const noSleep = { sleep: async () => {}, jitter: () => 0.5 };

test('a transient failure is retried within the budget', async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new TransientError('blip');
    return 'ok';
  }, { ...noSleep, attempts: 3 });
  assert.strictEqual(out, 'ok');
  assert.strictEqual(calls, 3);
});

test('🔴 a permanent failure is NOT retried: trying again cannot help', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(async () => {
    calls += 1;
    throw new PermanentError('the request itself is wrong');
  }, { ...noSleep, attempts: 5 }));
  assert.strictEqual(calls, 1, 'a 400 retried five times is five 400s');
});

test('the budget is a budget: it gives up and rethrows the LAST error', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(async () => {
    calls += 1;
    throw new TransientError(`attempt ${calls}`);
  }, { ...noSleep, attempts: 3 }), /attempt 3/);
  assert.strictEqual(calls, 3);
});

test('the original error survives: no wrapper hides what actually broke', async () => {
  const original = new TransientError('upstream 503', { code: 'UPSTREAM' });
  await assert.rejects(() => withRetry(async () => { throw original; },
    { ...noSleep, attempts: 2 }), (e) => e === original);
});

test('backoff grows exponentially and is capped', () => {
  const o = { baseMs: 100, maxMs: 2000, jitter: () => 1 };
  assert.strictEqual(backoff(1, o), 100);
  assert.strictEqual(backoff(2, o), 200);
  assert.strictEqual(backoff(3, o), 400);
  assert.strictEqual(backoff(10, o), 2000, 'capped, not unbounded');
});

test('jitter spreads the retries instead of synchronising them', () => {
  const o = { baseMs: 100, maxMs: 2000, jitter: () => 0 };
  assert.strictEqual(backoff(5, o), 0, 'full jitter can sleep zero…');
  assert.strictEqual(backoff(5, { ...o, jitter: () => 1 }), 1600, '…or the whole ceiling');
});

test('a hung call is a failure, not a wait forever', async () => {
  await assert.rejects(() => withTimeout(new Promise(() => {}), 20, 'stuck'), /timed out/);
});

test('an unknown error is only retried when it carries a signal we recognise', () => {
  assert.strictEqual(isRetryable(new Error('who knows')), false);
  assert.strictEqual(isRetryable(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
  assert.strictEqual(isRetryable(Object.assign(new Error('x'), { status: 503 })), true);
  assert.strictEqual(isRetryable(Object.assign(new Error('x'), { status: 400 })), false);
});
