'use strict';
// Provider-agnostic model adapter. A real adapter wraps any LLM API behind the
// same `propose({ request, tools })` call and returns the raw text. Only this
// file would know which provider is used.

/**
 * Deterministic fake model for tests and the demo. Each call returns the next
 * scripted output (an object is serialized to JSON; a string is returned as-is,
 * which lets tests simulate malformed output).
 */
function fakeModel(script) {
  let i = 0;
  return {
    name: 'fake',
    async propose() {
      const next = script[Math.min(i, script.length - 1)];
      i += 1;
      return typeof next === 'string' ? next : JSON.stringify(next);
    },
    calls: () => i,
  };
}

module.exports = { fakeModel };
