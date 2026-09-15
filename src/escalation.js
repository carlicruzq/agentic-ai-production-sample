'use strict';
// Human-in-the-loop with a cost: escalations are deduplicated and capped per
// person per day. When the cap is reached, the item waits in a queue instead
// of interrupting someone again.

function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function createEscalations({ dailyCapPerPerson = 3, now = () => new Date() } = {}) {
  const asked = new Map();     // `${person}|${day}` -> count
  const seen = new Set();      // dedupe key
  const queue = [];            // waiting for capacity

  function ask({ person, key, question }) {
    if (seen.has(key)) return { status: 'DUPLICATE', key };
    const slot = `${person}|${dayKey(now())}`;
    const used = asked.get(slot) || 0;
    if (used >= dailyCapPerPerson) {
      queue.push({ person, key, question });
      seen.add(key);
      return { status: 'QUEUED', key, reason: `daily cap of ${dailyCapPerPerson} reached for ${person}` };
    }
    asked.set(slot, used + 1);
    seen.add(key);
    return { status: 'ASKED', key, question };
  }

  function pending() {
    return queue.slice();
  }

  return { ask, pending };
}

module.exports = { createEscalations };
