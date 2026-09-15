'use strict';
// Append-only audit trail. Every step is recorded, including rejected proposals,
// so a decision can be reconstructed later without re-running the model.

function createState() {
  const events = [];

  function log(type, data) {
    const event = Object.freeze({ seq: events.length + 1, type, data: structuredClone(data) });
    events.push(event);
    return event;
  }

  function history(filter) {
    return filter ? events.filter((e) => e.type === filter) : events.slice();
  }

  return { log, history };
}

module.exports = { createState };
