'use strict';
// ===== Append-only audit trail =====
//
// Every step is recorded, including the ones that were rejected. The test of
// this log is simple: six months from now, can someone reconstruct WHY the
// system did what it did — without re-running the model and getting a different
// answer? That requires the proposal, the evidence, the verdict and the result,
// in order, with nothing overwritten.
//
// Events are frozen and deep-copied on the way in. A log whose entries can be
// mutated by the caller afterwards is a diary, not a record.
const fs = require('fs');

function redactDefault(value) {
  // Anything that looks like a secret never reaches the log. This is a floor,
  // not a policy: real deployments add their own field list.
  const SECRET = /^(authorization|api[_-]?key|token|password|secret|cookie)$/i;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = SECRET.test(k) ? '[redacted]' : walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
}

/**
 * @param {object} opts
 *   file      optional path; when set, each event is appended as one JSON line
 *   now       injectable clock (tests want a fixed one)
 *   redact    (value) => value
 */
function createState({ file = null, now = () => new Date().toISOString(),
  redact = redactDefault } = {}) {
  const events = [];
  const sink = file ? fs.createWriteStream(file, { flags: 'a' }) : null;

  function log(type, data) {
    const event = Object.freeze({
      seq: events.length + 1,
      at: now(),
      type,
      data: redact(structuredClone(data)),
    });
    events.push(event);
    if (sink) sink.write(`${JSON.stringify(event)}\n`);
    return event;
  }

  const history = (filter) => (filter ? events.filter((e) => e.type === filter) : events.slice());

  /** The decision path in one line per step — what you actually read first. */
  function trail() {
    return events.map((e) => `#${e.seq} ${e.type}`
      + (e.data && e.data.verdict ? ` → ${e.data.verdict}` : '')).join('\n');
  }

  const close = () => { if (sink) sink.end(); };

  return { log, history, trail, close, get length() { return events.length; } };
}

module.exports = { createState, redactDefault };
