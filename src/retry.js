'use strict';
// Bounded retries with exponential backoff and full jitter.
//
// Three properties this gives up front, because retrying is where systems
// quietly turn one incident into two:
//   · a budget, so a failing dependency cannot be called forever;
//   · a classifier, so a 400 is never retried and a 503 always is;
//   · jitter, so N callers failing at the same moment do not come back at the
//     same moment and keep the dependency down.
const { isRetryable, TransientError } = require('./errors');

const DEFAULTS = {
  attempts: 3,          // total tries, not extra tries
  baseMs: 100,
  maxMs: 2000,
  jitter: Math.random,  // injectable: tests need a deterministic clock
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  onRetry: null,
};

/** Full jitter: sleep uniformly in [0, min(maxMs, base * 2^n)]. */
function backoff(attempt, { baseMs, maxMs, jitter }) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(jitter() * ceiling);
}

/**
 * Runs `fn` until it succeeds, the budget runs out, or the error says that
 * trying again cannot help.
 *
 * @param {(attempt:number)=>Promise<any>} fn
 * @returns the value of `fn`, or throws the LAST error — not a wrapper around
 *          it. A retry helper that swallows the original error makes the
 *          incident harder to read than no retry at all.
 */
async function withRetry(fn, options = {}) {
  const o = { ...DEFAULTS, ...options };
  let last;
  for (let attempt = 1; attempt <= o.attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      last = err;
      const canRetry = isRetryable(err) && attempt < o.attempts;
      if (o.onRetry) o.onRetry({ attempt, error: err, willRetry: canRetry });
      if (!canRetry) throw err;
      await o.sleep(backoff(attempt, o));
    }
  }
  throw last;
}

/**
 * Wraps a promise in a deadline. A hung dependency with no timeout is
 * indistinguishable from a working one that is slow, and both stop the loop.
 */
function withTimeout(promise, ms, label = 'operation') {
  if (!ms) return promise;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TransientError(`${label} timed out after ${ms}ms`,
      { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

module.exports = { withRetry, withTimeout, backoff, DEFAULTS };
