'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createLedger, verify, MET, FAILED, UNKNOWN } = require('../src/evidence');

const REQ = [
  { key: 'exists', describe: 'the order exists', test: (v) => v === true },
  { key: 'status', describe: 'the order was paid', test: (v) => v === 'PAID' },
];

test('a fact must name what it is about', () => {
  const l = createLedger();
  assert.throws(() => l.record({ key: 'exists', value: true, source: 't' }), /subject/);
});

test('verified requirements come back MET, with where the fact came from', () => {
  const l = createLedger();
  l.record({ subject: 'A-1', key: 'exists', value: true, source: 'lookup_order' });
  l.record({ subject: 'A-1', key: 'status', value: 'PAID', source: 'lookup_order' });
  const v = verify(REQ, 'A-1', l);
  assert.strictEqual(v.ok, true);
  assert.ok(v.results.every((r) => r.status === MET));
  assert.match(v.results[0].detail, /via lookup_order/);
});

test('🔴 an unchecked requirement is UNKNOWN, never a pass', () => {
  const l = createLedger();
  l.record({ subject: 'A-1', key: 'exists', value: true, source: 'lookup_order' });
  const v = verify(REQ, 'A-1', l);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.unknown.length, 1);
  assert.strictEqual(v.unknown[0].status, UNKNOWN);
  assert.match(v.summary, /never verified/);
});

test('🔴 zero requirements is not zero problems, and it says so out loud', () => {
  const v = verify([], 'A-1', createLedger());
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.checked, 0);
  assert.match(v.summary, /nothing was verified/);
});

test('a contradicted requirement is FAILED, which is not the same as UNKNOWN', () => {
  const l = createLedger();
  l.record({ subject: 'A-1', key: 'exists', value: true, source: 'lookup_order' });
  l.record({ subject: 'A-1', key: 'status', value: 'REFUNDED', source: 'lookup_order' });
  const v = verify(REQ, 'A-1', l);
  assert.strictEqual(v.failed.length, 1);
  assert.strictEqual(v.failed[0].status, FAILED);
  assert.strictEqual(v.unknown.length, 0);
});

test('🔑 facts are bound to their subject: A-1 says nothing about A-2', () => {
  const l = createLedger();
  l.record({ subject: 'A-1', key: 'exists', value: true, source: 'lookup_order' });
  l.record({ subject: 'A-1', key: 'status', value: 'PAID', source: 'lookup_order' });
  const v = verify(REQ, 'A-2', l);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.unknown.length, 2);
});

test('a check that throws is UNKNOWN, not a silent pass', () => {
  const l = createLedger();
  l.record({ subject: 'A-1', key: 'exists', value: true, source: 't' });
  const v = verify([{ key: 'exists', describe: 'boom',
    test: () => { throw new Error('bad comparison'); } }], 'A-1', l);
  assert.strictEqual(v.unknown.length, 1);
  assert.match(v.unknown[0].detail, /the check itself failed/);
});
