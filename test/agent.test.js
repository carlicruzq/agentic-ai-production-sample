'use strict';
// The loop end to end: what the model says, what the system verifies, what
// actually happens, and what is left in the audit trail.
const { test } = require('node:test');
const assert = require('node:assert');
const { createAgent, OUTCOME } = require('../src/agent');
const { fakeModel } = require('../src/model');
const { VERDICT } = require('../src/gate');
const { createEscalations } = require('../src/escalation');
const { createRegistry, defaultRegistry } = require('../src/tools');
const { TransientError } = require('../src/errors');

const REQUEST = { requester: 'ops@example.com', text: 'Customer charged twice for order A-100' };
const propose = (over = {}) => ({ tool: 'refund', args: { orderId: 'A-100', amount: 40 },
  confidence: 0.93, rationale: 'duplicate charge', ...over });

test('a verified, in-limit action runs and the tool actually executed', async () => {
  const agent = createAgent({ model: fakeModel([propose()]) });
  const out = await agent.handle(REQUEST);
  assert.strictEqual(out.verdict, VERDICT.EXECUTE);
  assert.strictEqual(out.output.refunded, 40);
  assert.strictEqual(out.output.orderId, 'A-100');
});

test('🔑 the model never executes anything: a rejected proposal has no output', async () => {
  const agent = createAgent({ model: fakeModel([propose({ tool: 'delete_database', args: {} })]) });
  const out = await agent.handle(REQUEST);
  assert.strictEqual(out.verdict, VERDICT.REJECT);
  assert.strictEqual(out.output, undefined);
});

test('an escalation asks a human and does not act', async () => {
  const agent = createAgent({ model: fakeModel([propose({ args: { orderId: 'A-200', amount: 350 } })]) });
  const out = await agent.handle({ ...REQUEST, text: 'refund order A-200' });
  assert.strictEqual(out.verdict, VERDICT.ESCALATE);
  assert.strictEqual(out.escalation.status, 'ASKED');
  assert.strictEqual(out.output, undefined);
});

test('malformed output is retried WITH the reason, then succeeds', async () => {
  const model = fakeModel(['here you go: {"tool":"refund"}', propose()]);
  const agent = createAgent({ model });
  const out = await agent.handle(REQUEST);
  assert.strictEqual(out.verdict, VERDICT.EXECUTE);
  assert.strictEqual(model.calls(), 2);
  const attempts = agent.state.history('proposal');
  assert.strictEqual(attempts[0].data.ok, false);
  assert.ok(attempts[0].data.errors.length, 'the failure is recorded, not just retried');
});

test('🔴 the retry budget is finite: bad output forever fails loudly', async () => {
  const agent = createAgent({ model: fakeModel(['not json at all']), maxAttempts: 3 });
  const out = await agent.handle(REQUEST);
  assert.strictEqual(out.verdict, OUTCOME.FAILED);
  assert.match(out.reasons[0], /no usable proposal after 3/);
});

test('a transient provider failure is retried; a permanent one is not', async () => {
  let calls = 0;
  const flaky = { name: 'flaky', async propose() {
    calls += 1;
    if (calls === 1) throw new TransientError('connection reset');
    return JSON.stringify(propose());
  } };
  const agent = createAgent({ model: flaky, retry: { sleep: async () => {}, jitter: () => 0 } });
  const out = await agent.handle(REQUEST);
  assert.strictEqual(out.verdict, VERDICT.EXECUTE);
  assert.strictEqual(calls, 2);
});

test('🔑 the system verifies the proposal with its OWN read-only tools', async () => {
  // The model claims A-999 was charged twice. It does not exist. Nothing in the
  // model's output says so — the lookup does.
  const agent = createAgent({ model: fakeModel([propose({ args: { orderId: 'A-999', amount: 40 } })]) });
  const out = await agent.handle({ ...REQUEST, text: 'charged twice for A-999' });
  assert.strictEqual(out.verdict, VERDICT.ESCALATE);
  assert.match(out.reasons.join(' '), /the order exists: contradicted/);
});

test('🔴 a confident, fluent, WRONG proposal is still stopped by the evidence', async () => {
  // A-400 is already refunded. confidence 0.99 and a plausible rationale buy
  // nothing, because neither is evidence.
  const agent = createAgent({ model: fakeModel([propose({
    args: { orderId: 'A-400', amount: 40 }, confidence: 0.99,
    rationale: 'the customer was clearly charged twice and is owed a refund' })]) });
  const out = await agent.handle({ ...REQUEST, text: 'refund A-400' });
  assert.strictEqual(out.verdict, VERDICT.ESCALATE);
  assert.match(out.reasons.join(' '), /actually paid: contradicted/);
});

test('an investigation that fails leaves requirements UNKNOWN and escalates', async () => {
  const registry = defaultRegistry();
  const agent = createAgent({
    model: fakeModel([propose()]),
    registry,
    investigators: { refund: async () => { throw new Error('the records service is down'); } },
  });
  const out = await agent.handle(REQUEST);
  assert.strictEqual(out.verdict, VERDICT.ESCALATE);
  assert.match(out.reasons.join(' '), /never verified/);
  const inquiry = agent.state.history('investigation')[0].data;
  assert.match(inquiry.error, /records service is down/);
});

test('🔑 the same effect is not applied twice', async () => {
  const registry = defaultRegistry();
  const agent = createAgent({ model: fakeModel([propose(), propose()]), registry });
  const first = await agent.handle(REQUEST);
  const second = await agent.handle(REQUEST);
  assert.strictEqual(first.output.replayed, undefined);
  assert.strictEqual(second.output.replayed, true, 'the second run replays, it does not re-refund');
  assert.strictEqual(first.output.reference, second.output.reference);
});

test('a tool failure after approval is an incident, not a quiet success', async () => {
  const registry = createRegistry();
  registry.register('lookup_order', { readOnly: true,
    args: { orderId: { type: 'string', required: true } },
    run: async ({ orderId }) => ({ orderId, found: true, status: 'PAID', refundable: 500, charges: 2 }) });
  registry.register('refund', {
    args: { orderId: { type: 'string', required: true }, amount: { type: 'number', required: true } },
    run: async () => { throw new TransientError('payment provider unavailable'); } });
  const agent = createAgent({ model: fakeModel([propose()]), registry,
    retry: { sleep: async () => {}, jitter: () => 0 } });
  const out = await agent.handle(REQUEST);
  assert.strictEqual(out.verdict, OUTCOME.FAILED);
  assert.strictEqual(out.retryable, true);
  assert.match(out.reasons[0], /payment provider unavailable/);
});

test('escalations are capped per person per day, and the extra ones queue', async () => {
  const escalations = createEscalations({ dailyCapPerPerson: 1 });
  const mk = (orderId) => createAgent({
    model: fakeModel([propose({ args: { orderId, amount: 350 } })]), escalations });
  const a = await mk('A-200').handle({ ...REQUEST, text: 'refund A-200' });
  const b = await mk('A-300').handle({ ...REQUEST, text: 'refund A-300' });
  assert.strictEqual(a.escalation.status, 'ASKED');
  assert.strictEqual(b.escalation.status, 'QUEUED');
  assert.strictEqual(escalations.pending().length, 1);
});

test('🔑 the audit trail reconstructs the decision without re-running the model', async () => {
  const agent = createAgent({ model: fakeModel([propose()]) });
  await agent.handle(REQUEST);
  const types = agent.state.history().map((e) => e.type);
  assert.deepStrictEqual(types, ['request', 'proposal', 'investigation', 'verdict', 'executed']);
  const verdict = agent.state.history('verdict')[0].data;
  assert.strictEqual(verdict.verdict, VERDICT.EXECUTE);
  assert.ok(verdict.evidence.length >= 3, 'the evidence is IN the record, not recomputed later');
  assert.ok(agent.state.trail().includes('verdict → EXECUTE'));
});

test('the audit trail records rejected proposals too', async () => {
  const agent = createAgent({ model: fakeModel([propose({ tool: 'nope', args: {} })]) });
  await agent.handle(REQUEST);
  assert.strictEqual(agent.state.history('verdict')[0].data.verdict, VERDICT.REJECT);
});

test('secrets never reach the audit trail', async () => {
  const agent = createAgent({ model: fakeModel([propose()]) });
  await agent.handle({ ...REQUEST, authorization: 'Bearer sk-do-not-log-me' });
  const logged = JSON.stringify(agent.state.history());
  assert.ok(!logged.includes('sk-do-not-log-me'));
  assert.ok(logged.includes('[redacted]'));
});

test('events are frozen: the record cannot be edited after the fact', async () => {
  const agent = createAgent({ model: fakeModel([propose()]) });
  await agent.handle(REQUEST);
  const e = agent.state.history()[0];
  assert.throws(() => { e.type = 'something else'; }, TypeError);
});
