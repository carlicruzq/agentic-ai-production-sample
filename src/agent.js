'use strict';
// ===== The loop =====
//
//   propose → validate (bounded retries) → investigate → gate → act → audit
//
// The model appears exactly once, at the first step, and it returns a proposal.
// Everything after that is ordinary code: schema validation, read-only lookups,
// a pure decision function, a tool call. That is the property worth copying from
// this repo — not the file layout.
const { parseStrict, validate } = require('./schema');
const { decide, VERDICT, DEFAULT_RULES } = require('./gate');
const { defaultRegistry } = require('./tools');
const { createEscalations } = require('./escalation');
const { createState } = require('./state');
const { createLedger } = require('./evidence');
const { defaultInvestigators, investigate } = require('./investigation');
const { withRetry } = require('./retry');
const { isRetryable, InvalidOutputError } = require('./errors');

const OUTCOME = { ...VERDICT, FAILED: 'FAILED' };

function createAgent({
  model,
  registry = defaultRegistry(),
  escalations = createEscalations(),
  state = createState(),
  rules = DEFAULT_RULES,
  investigators = defaultInvestigators(),
  maxAttempts = 3,
  approver = 'ops-lead',
  retry = {},
} = {}) {
  if (!model) throw new Error('a model adapter is required');

  /**
   * Asks the model until it returns something the schema accepts.
   *
   * Two different failures are handled here, and they are NOT the same retry:
   *   · a transport blip — same prompt, exponential backoff, `withRetry`;
   *   · malformed output — a NEW prompt carrying the exact validation errors,
   *     which is a different request, not a repeat of the same one.
   * Both are bounded by `maxAttempts`. Asking a model over and over until it
   * happens to emit valid JSON turns a validation layer into a slot machine.
   */
  async function proposeValid(request) {
    let feedback;
    let last;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let raw;
      try {
        // The transport gets its own small budget inside this attempt: a reset
        // connection should not consume one of the model's chances to answer.
        raw = await withRetry(() => model.propose({
          request, tools: registry.describe(), feedback,
        }), { ...retry, onRetry: ({ attempt: n, error }) => state.log('transport_retry',
          { attempt: n, error: error.message }) });
      } catch (err) {
        last = err;
        state.log('proposal', { attempt, ok: false, errors: [err.message], transport: true });
        if (!isRetryable(err)) break;   // a 400 will still be a 400 next time
        continue;
      }
      const parsed = parseStrict(raw);
      const checked = parsed.ok ? validate(parsed.value) : parsed;
      state.log('proposal', { attempt, raw, ok: checked.ok,
        errors: checked.ok ? [] : checked.errors });
      if (checked.ok) return { proposal: checked.value, attempts: attempt };
      last = new InvalidOutputError(checked.errors);
      feedback = checked.errors.join('; ');
    }
    return { failed: true, error: last };
  }

  async function handle(request) {
    const ledger = createLedger();
    state.log('request', request);

    const proposed = await proposeValid(request);
    if (proposed.failed) {
      const out = { verdict: OUTCOME.FAILED,
        reasons: [`no usable proposal after ${maxAttempts} attempt(s): ${proposed.error.message}`],
        error: proposed.error.code };
      state.log('failed', out);
      return out;
    }
    const proposal = proposed.proposal;

    // The system checks the model's claim with its own read-only tools.
    const inquiry = await investigate(proposal, { registry, ledger, investigators });
    state.log('investigation', inquiry);

    const { verdict, reasons, evidence } = decide(proposal, { request, registry, ledger }, rules);
    state.log('verdict', { verdict, reasons, proposal,
      evidence: evidence ? evidence.results : [] });

    if (verdict === VERDICT.EXECUTE) {
      try {
        const output = await registry.run(proposal.tool, proposal.args);
        state.log('executed', output);
        return { verdict, reasons, output, evidence, proposal };
      } catch (err) {
        // A tool that fails after the gate said yes is an incident, not a
        // decision. It is reported as such and never silently downgraded.
        const out = { verdict: OUTCOME.FAILED, reasons: [`the tool failed: ${err.message}`],
          error: err.code, retryable: isRetryable(err) };
        state.log('tool_failed', out);
        return out;
      }
    }

    if (verdict === VERDICT.ESCALATE) {
      const key = `${proposal.tool}:${registry.effectKey(proposal.tool, proposal.args)}`;
      const asked = escalations.ask({ person: approver, key, question: reasons.join('; ') });
      state.log('escalated', asked);
      return { verdict, reasons, escalation: asked, evidence, proposal };
    }

    return { verdict, reasons, evidence, proposal };
  }

  return { handle, state, escalations, registry };
}

module.exports = { createAgent, OUTCOME };
