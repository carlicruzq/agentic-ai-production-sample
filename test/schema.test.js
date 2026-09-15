'use strict';
// The closed schema. Every rule here exists because the permissive version of
// it lets malformed model output through as if it were fine.
const { test } = require('node:test');
const assert = require('node:assert');
const { validate, parseStrict, PROPOSAL } = require('../src/schema');

const good = { tool: 'refund', args: { orderId: 'A-1' }, confidence: 0.9, rationale: 'because' };

test('a well-formed proposal validates', () => {
  assert.strictEqual(validate(good).ok, true);
});

test('🔴 an extra key is rejected, not ignored', () => {
  const v = validate({ ...good, approved: true });
  assert.strictEqual(v.ok, false);
  assert.match(v.errors.join(' '), /unexpected key: approved/);
});

test('a missing key is named', () => {
  const { rationale, ...rest } = good;
  assert.match(validate(rest).errors.join(' '), /missing key: rationale/);
});

test('🔴 there is no coercion: "0.9" is not 0.9', () => {
  const v = validate({ ...good, confidence: '0.9' });
  assert.strictEqual(v.ok, false);
  assert.match(v.errors.join(' '), /expected number, got string/);
});

test('numbers out of range are rejected', () => {
  assert.strictEqual(validate({ ...good, confidence: 1.4 }).ok, false);
  assert.strictEqual(validate({ ...good, confidence: -0.1 }).ok, false);
});

test('null and arrays are not objects', () => {
  assert.strictEqual(validate(null).ok, false);
  assert.strictEqual(validate([]).ok, false);
  assert.strictEqual(validate({ ...good, args: [] }).ok, false);
});

test('🔴 prose around the JSON is rejected, not fished out', () => {
  // Models do this constantly. "Best-effort parsing" here is how a half-read
  // proposal becomes a real side effect.
  const v = parseStrict('Sure! Here is the proposal: {"tool":"refund"}');
  assert.strictEqual(v.ok, false);
  assert.match(v.errors.join(' '), /single JSON object with no surrounding text/);
});

test('a code fence is not valid JSON either', () => {
  assert.strictEqual(parseStrict('```json\n{"tool":"refund"}\n```').ok, false);
});

test('invalid JSON says so, with the parser error', () => {
  const v = parseStrict('{"tool": }');
  assert.strictEqual(v.ok, false);
  assert.match(v.errors.join(' '), /invalid JSON/);
});

test('non-text output from a provider is a schema failure, not a crash', () => {
  assert.strictEqual(parseStrict(undefined).ok, false);
  assert.strictEqual(parseStrict({ tool: 'refund' }).ok, false);
});

test('the proposal schema is the four fields, and only those', () => {
  assert.deepStrictEqual(Object.keys(PROPOSAL).sort(),
    ['args', 'confidence', 'rationale', 'tool']);
});
