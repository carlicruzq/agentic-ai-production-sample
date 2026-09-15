'use strict';
// The agent loop: propose → validate (bounded retries) → deterministic gate →
// execute / escalate / reject → audit. The model never executes anything.

const { parseStrict, validate } = require('./schema');
const { decide, VERDICT } = require('./gate');
const { defaultRegistry } = require('./tools');
const { createEscalations } = require('./escalation');
const { createState } = require('./state');

function createAgent({
  model,
  registry = defaultRegistry(),
  escalations = createEscalations(),
  state = createState(),
  maxAttempts = 3,
  approver = 'ops-lead',
} = {}) {
  if (!model) throw new Error('a model adapter is required');

  async function proposeValid(request) {
    const errors = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const raw = await model.propose({ request, tools: registry.describe(), feedback: errors.slice(-1)[0] });
      const parsed = parseStrict(raw);
      const checked = parsed.ok ? validate(parsed.value) : parsed;
      state.log('proposal', { attempt, raw, ok: checked.ok, errors: checked.ok ? [] : checked.errors });
      if (checked.ok) return { ok: true, proposal: checked.value, attempts: attempt };
      errors.push(checked.errors.join('; '));
    }
    return { ok: false, errors, attempts: maxAttempts };
  }

  async function handle(request) {
    state.log('request', request);
    const proposed = await proposeValid(request);
    if (!proposed.ok) {
      const result = { verdict: 'FAILED', reasons: [`no valid proposal after ${proposed.attempts} attempts`], errors: proposed.errors };
      state.log('failed', result);
      return result;
    }

    const { verdict, reasons } = decide(proposed.proposal, { request, registry });
    state.log('verdict', { verdict, reasons, proposal: proposed.proposal });

    if (verdict === VERDICT.EXECUTE) {
      const output = await registry.run(proposed.proposal.tool, proposed.proposal.args);
      state.log('executed', output);
      return { verdict, reasons, output };
    }
    if (verdict === VERDICT.ESCALATE) {
      const key = `${proposed.proposal.tool}:${JSON.stringify(proposed.proposal.args)}`;
      const asked = escalations.ask({ person: approver, key, question: reasons.join('; ') });
      state.log('escalated', asked);
      return { verdict, reasons, escalation: asked };
    }
    return { verdict, reasons };
  }

  return { handle, state, escalations };
}

module.exports = { createAgent };
