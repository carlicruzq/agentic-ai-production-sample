'use strict';
// ===== The model adapter boundary =====
//
// Exactly one interface, and only files under `providers/` know which vendor is
// behind it:
//
//   propose({ request, tools, feedback }) -> Promise<string>   // raw text
//
// Keeping the vendor at the edge is not tidiness. It is what makes the agent
// loop testable without a network, a key, or a bill — every test in this repo
// runs against `fakeModel`, which is why `npm test` needs no credentials.

/**
 * Deterministic fake model for tests and the demo.
 *
 * Each call returns the next scripted output. An object is serialised to JSON;
 * a string is returned as-is, which is how a test simulates malformed output
 * ("here you go: {...}") without mocking a transport.
 */
function fakeModel(script, { name = 'fake' } = {}) {
  let i = 0;
  return {
    name,
    async propose() {
      const next = script[Math.min(i, script.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return typeof next === 'string' ? next : JSON.stringify(next);
    },
    calls: () => i,
  };
}

/** A model that always fails — for exercising the retry budget. */
function failingModel(error) {
  return { name: 'failing', async propose() { throw error; } };
}

module.exports = { fakeModel, failingModel };
