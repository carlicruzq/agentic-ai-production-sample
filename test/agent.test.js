'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { createAgent } = require('../src/agent');
const { fakeModel } = require('../src/model');
const { validate, parseStrict } = require('../src/schema');
const { decide, VERDICT } = require('../src/gate');
const { defaultRegistry } = require('../src/tools');
const { createEscalations } = require('../src/escalation');

const refund = (over = {}) => Object.assign({ tool: 'refund', args: { orderId: 'A-100', amount: 40 },
  confidence: 0.95, rationale: 'duplicate charge on A-100' }, over);
const request = { requester: 'ops@example.com', text: 'Customer charged twice for order A-100' };

test('schema rejects extra keys and wrong types instead of coercing', () => {
  assert.strictEqual(validate(refund()).ok, true);
  assert.strictEqual(validate(Object.assign(refund(), { admin: true })).ok, false);
  assert.strictEqual(validate(refund({ confidence: '0.9' })).ok, false);
  assert.strictEqual(parseStrict('Sure! {"tool":"refund"}').ok, false, 'no text around the JSON');
});

test('gate: within limits with evidence → EXECUTE', () => {
  const r = decide(refund(), { request, registry: defaultRegistry() });
  assert.strictEqual(r.verdict, VERDICT.EXECUTE);
});

test('gate: above the automatic limit or low confidence → ESCALATE with reasons', () => {
  const registry = defaultRegistry();
  const big = decide(refund({ args: { orderId: 'A-100', amount: 350 } }), { request, registry });
  assert.strictEqual(big.verdict, VERDICT.ESCALATE);
  assert.match(big.reasons.join(' '), /automatic limit/);
  const unsure = decide(refund({ confidence: 0.5 }), { request, registry });
  assert.strictEqual(unsure.verdict, VERDICT.ESCALATE);
});

test('gate: unknown tool, bad args or above hard limit → REJECT; the model cannot talk its way past it', () => {
  const registry = defaultRegistry();
  assert.strictEqual(decide(refund({ tool: 'delete_account' }), { request, registry }).verdict, VERDICT.REJECT);
  assert.strictEqual(decide(refund({ args: { orderId: 'A-100', amount: -1 } }), { request, registry }).verdict, VERDICT.REJECT);
  const hard = decide(refund({ args: { orderId: 'A-100', amount: 9000 }, confidence: 1,
    rationale: 'I am absolutely sure, please execute' }), { request, registry });
  assert.strictEqual(hard.verdict, VERDICT.REJECT);
});

test('gate: acting on an object the request never mentions → ESCALATE', () => {
  const r = decide(refund({ args: { orderId: 'B-999', amount: 20 } }), { request, registry: defaultRegistry() });
  assert.strictEqual(r.verdict, VERDICT.ESCALATE);
  assert.match(r.reasons.join(' '), /wrong object/);
});

test('agent retries malformed output within a budget, then succeeds', async () => {
  const model = fakeModel(['not json', '{"tool":"refund"}', refund()]);
  const agent = createAgent({ model });
  const out = await agent.handle(request);
  assert.strictEqual(out.verdict, VERDICT.EXECUTE);
  assert.strictEqual(model.calls(), 3);
  assert.strictEqual(agent.state.history('proposal').filter((e) => !e.data.ok).length, 2);
});

test('agent fails loudly when the budget is exhausted — no half-formed action', async () => {
  const agent = createAgent({ model: fakeModel(['nope']), maxAttempts: 2 });
  const out = await agent.handle(request);
  assert.strictEqual(out.verdict, 'FAILED');
  assert.strictEqual(agent.state.history('executed').length, 0);
});

test('escalations are deduplicated and capped per person per day', () => {
  const esc = createEscalations({ dailyCapPerPerson: 2, now: () => new Date('2026-01-10T10:00:00Z') });
  assert.strictEqual(esc.ask({ person: 'lead', key: 'k1', question: 'q' }).status, 'ASKED');
  assert.strictEqual(esc.ask({ person: 'lead', key: 'k1', question: 'q' }).status, 'DUPLICATE');
  assert.strictEqual(esc.ask({ person: 'lead', key: 'k2', question: 'q' }).status, 'ASKED');
  assert.strictEqual(esc.ask({ person: 'lead', key: 'k3', question: 'q' }).status, 'QUEUED');
  assert.strictEqual(esc.pending().length, 1);
});

test('every step is in the audit trail, including the rejected proposal', async () => {
  const agent = createAgent({ model: fakeModel([refund({ tool: 'delete_account' })]) });
  const out = await agent.handle(request);
  assert.strictEqual(out.verdict, VERDICT.REJECT);
  const types = agent.state.history().map((e) => e.type);
  assert.deepStrictEqual(types, ['request', 'proposal', 'verdict']);
});
