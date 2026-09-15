'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { decide, VERDICT } = require('../src/gate');
const { defaultRegistry } = require('../src/tools');
const { createLedger } = require('../src/evidence');

const registry = defaultRegistry();
const ctx = (ledger) => ({ request: { text: 'x' }, registry, ledger });

function ledgerFor(orderId, { exists = true, status = 'PAID', refundable = 1000,
  requested = 40 } = {}) {
  const l = createLedger();
  l.record({ subject: orderId, key: 'requested_amount', value: requested, source: 'proposal' });
  l.record({ subject: orderId, key: 'exists', value: exists, source: 'lookup_order' });
  if (exists) {
    l.record({ subject: orderId, key: 'status', value: status, source: 'lookup_order' });
    l.record({ subject: orderId, key: 'refundable_amount', value: refundable, source: 'lookup_order' });
  }
  return l;
}

const proposal = (over = {}) => ({ tool: 'refund', args: { orderId: 'A-100', amount: 40 },
  confidence: 0.95, rationale: 'duplicate charge', ...over });

test('the gate is a pure function: same input, same verdict', () => {
  const p = proposal();
  const a = decide(p, ctx(ledgerFor('A-100')));
  const b = decide(p, ctx(ledgerFor('A-100')));
  assert.strictEqual(a.verdict, b.verdict);
  assert.deepStrictEqual(a.reasons, b.reasons);
});

test('a verified action within the automatic limit executes', () => {
  const d = decide(proposal(), ctx(ledgerFor('A-100')));
  assert.strictEqual(d.verdict, VERDICT.EXECUTE);
});

test('an unregistered tool is rejected, not escalated', () => {
  const d = decide(proposal({ tool: 'wire_transfer' }), ctx(ledgerFor('A-100')));
  assert.strictEqual(d.verdict, VERDICT.REJECT);
  assert.match(d.reasons[0], /not registered/);
});

test('arguments outside the declared shape are rejected before anything else', () => {
  const d = decide(proposal({ args: { orderId: 'A-100', amount: 'forty' } }), ctx(ledgerFor('A-100')));
  assert.strictEqual(d.verdict, VERDICT.REJECT);
  assert.match(d.reasons.join(' '), /invalid args/);
});

test('the hard limit is a rejection, not a question for a tired human', () => {
  const d = decide(proposal({ args: { orderId: 'A-300', amount: 9000 } }),
    ctx(ledgerFor('A-300', { refundable: 9000, requested: 9000 })));
  assert.strictEqual(d.verdict, VERDICT.REJECT);
  assert.match(d.reasons[0], /hard limit/);
});

test('confidence 1.0 does not buy authority: the hard limit still rejects', () => {
  const d = decide(proposal({ args: { orderId: 'A-300', amount: 9000 }, confidence: 1 }),
    ctx(ledgerFor('A-300', { refundable: 9000, requested: 9000 })));
  assert.strictEqual(d.verdict, VERDICT.REJECT);
});

test('above the automatic limit, a human decides', () => {
  const d = decide(proposal({ args: { orderId: 'A-200', amount: 350 } }),
    ctx(ledgerFor('A-200', { refundable: 350, requested: 350 })));
  assert.strictEqual(d.verdict, VERDICT.ESCALATE);
  assert.match(d.reasons.join(' '), /automatic limit/);
});

test('low confidence escalates even when everything is verified', () => {
  const d = decide(proposal({ confidence: 0.4 }), ctx(ledgerFor('A-100')));
  assert.strictEqual(d.verdict, VERDICT.ESCALATE);
  assert.match(d.reasons.join(' '), /confidence/);
});

test('🔴 NO evidence is not a pass: an empty ledger escalates', () => {
  const d = decide(proposal(), ctx(createLedger()));
  assert.strictEqual(d.verdict, VERDICT.ESCALATE);
  assert.match(d.reasons.join(' '), /never verified/);
});

test('🔴 a ledger with no ledger at all escalates, it does not sail through', () => {
  const d = decide(proposal(), { request: { text: 'x' }, registry });
  assert.strictEqual(d.verdict, VERDICT.ESCALATE);
  assert.match(d.reasons.join(' '), /no evidence ledger/);
});

test('evidence that CONTRADICTS the action escalates and says which requirement', () => {
  const d = decide(proposal(), ctx(ledgerFor('A-100', { status: 'REFUNDED' })));
  assert.strictEqual(d.verdict, VERDICT.ESCALATE);
  assert.match(d.reasons.join(' '), /actually paid: contradicted/);
});

test('🔑 evidence about a DIFFERENT order does not authorise this one', () => {
  // The model proposes a refund on A-200; every fact in the ledger is about
  // A-100. Nothing is technically missing — it is all about the wrong object.
  const d = decide(proposal({ args: { orderId: 'A-200', amount: 40 } }), ctx(ledgerFor('A-100')));
  assert.strictEqual(d.verdict, VERDICT.ESCALATE);
  assert.match(d.reasons.join(' '), /never verified/);
});

test('asking for more than is refundable is caught by the evidence, not by a limit', () => {
  const d = decide(proposal({ args: { orderId: 'A-400', amount: 40 } }),
    ctx(ledgerFor('A-400', { status: 'REFUNDED', refundable: 0, requested: 40 })));
  assert.strictEqual(d.verdict, VERDICT.ESCALATE);
  assert.match(d.reasons.join(' '), /refundable: contradicted/);
});

test('a read-only tool needs no evidence: reading is how evidence is collected', () => {
  const d = decide({ tool: 'lookup_order', args: { orderId: 'A-100' }, confidence: 0.1,
    rationale: 'check it' }, ctx(createLedger()));
  assert.strictEqual(d.verdict, VERDICT.EXECUTE);
});
