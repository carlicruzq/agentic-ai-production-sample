'use strict';
// ===== Evidence: what the system VERIFIED, not what the model asserted =====
//
// The failure this exists to prevent is the quiet one. A model returns
// `confidence: 0.99` and a fluent rationale — "the customer was clearly charged
// twice" — and every downstream check passes, because every downstream check is
// reading the model's own words. Nothing in that loop ever looked at the order.
//
// So `confidence` is not evidence. A rationale is not evidence. The request text
// is not evidence either: it is the claim being investigated. Evidence is a fact
// this process retrieved from a read-only tool, recorded with where it came
// from, and checked against the action about to be taken.
//
// Two rules follow, and both are enforced below rather than documented and hoped
// for:
//   1. An unverified requirement is NOT a pass. It is "unknown", and unknown
//      escalates. A validator that returns zero findings because it never ran
//      looks exactly like a validator that ran and found nothing.
//   2. Evidence is bound to the object it describes. Evidence about order A-100
//      says nothing about A-200, no matter how recently it was collected.

/** A single retrieved fact. `source` is the tool call that produced it. */
function fact({ subject, key, value, source }) {
  if (!subject) throw new Error('a fact without a subject cannot be checked against anything');
  return Object.freeze({ subject: String(subject), key, value, source: source || 'unknown',
    at: new Date().toISOString() });
}

function createLedger() {
  const facts = [];
  return {
    record: (f) => { facts.push(fact(f)); return f; },
    about: (subject) => facts.filter((f) => f.subject === String(subject)),
    find: (subject, key) => facts.find((f) => f.subject === String(subject) && f.key === key),
    all: () => facts.slice(),
  };
}

// A requirement is a question with three possible answers, never two.
const MET = 'MET';
const FAILED = 'FAILED';       // checked, and the fact contradicts the action
const UNKNOWN = 'UNKNOWN';     // never checked — the dangerous one

/**
 * Checks one requirement against the ledger.
 *
 * @param {object} req  { key, describe, test(value, facts) }
 * @returns {{status, key, detail, source}}
 */
function check(req, subject, ledger) {
  const f = ledger.find(subject, req.key);
  if (!f) {
    return { status: UNKNOWN, key: req.key,
      detail: `${req.describe}: never verified — no fact recorded for ${subject}.${req.key}`,
      source: null };
  }
  let ok;
  try {
    ok = !!req.test(f.value, ledger.about(subject));
  } catch (e) {
    return { status: UNKNOWN, key: req.key,
      detail: `${req.describe}: the check itself failed (${e.message})`, source: f.source };
  }
  return { status: ok ? MET : FAILED, key: req.key,
    detail: `${req.describe}: ${ok ? 'confirmed' : 'contradicted'} by ${req.key}=`
      + JSON.stringify(f.value) + ` (via ${f.source})`,
    source: f.source };
}

/**
 * All requirements for an action, evaluated together.
 *
 * Returns the full breakdown — not a boolean. `ok: false` with three UNKNOWNs
 * and `ok: false` with one FAILED are different situations that deserve
 * different handling, and a boolean erases that.
 */
function verify(requirements, subject, ledger) {
  const results = (requirements || []).map((r) => check(r, subject, ledger));
  const failed = results.filter((r) => r.status === FAILED);
  const unknown = results.filter((r) => r.status === UNKNOWN);
  return {
    ok: results.length > 0 && !failed.length && !unknown.length,
    checked: results.length,
    results,
    failed,
    unknown,
    // Said out loud, because "0 problems found" from a validator that never ran
    // is the most expensive kind of green.
    summary: !results.length ? 'no requirements declared for this action: nothing was verified'
      : failed.length ? `${failed.length} requirement(s) contradicted by the evidence`
        : unknown.length ? `${unknown.length} requirement(s) never verified`
          : `${results.length} requirement(s) verified against retrieved facts`,
  };
}

module.exports = { MET, FAILED, UNKNOWN, fact, createLedger, check, verify };
