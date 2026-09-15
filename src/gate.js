'use strict';
// Deterministic gate. The model proposes; this pure function decides.
// Same input, same verdict — no model call, no randomness, no clock inside.

const VERDICT = { EXECUTE: 'EXECUTE', ESCALATE: 'ESCALATE', REJECT: 'REJECT' };

const DEFAULT_RULES = {
  readOnlyTools: ['lookup_order'],
  autoLimitByTool: { refund: 100 },   // above this amount a human decides
  minConfidence: 0.8,                  // below this, a human decides
  hardLimitByTool: { refund: 5000 },   // above this, never executed by the agent
  requireEvidence: true,               // the request must reference the object acted on
};

/**
 * @param {object} proposal   validated proposal: { tool, args, confidence, rationale }
 * @param {object} context    { request: { text }, registry }
 * @returns {{ verdict: string, reasons: string[] }}
 */
function decide(proposal, context, rules = DEFAULT_RULES) {
  const reasons = [];
  const { tool, args, confidence } = proposal;

  if (!context.registry.has(tool)) {
    return { verdict: VERDICT.REJECT, reasons: [`tool not allowed: ${tool}`] };
  }
  const argCheck = context.registry.checkArgs(tool, args);
  if (!argCheck.ok) {
    return { verdict: VERDICT.REJECT, reasons: argCheck.errors.map((e) => `invalid args: ${e}`) };
  }

  if (rules.readOnlyTools.includes(tool)) {
    return { verdict: VERDICT.EXECUTE, reasons: ['read-only tool'] };
  }

  const hardLimit = rules.hardLimitByTool[tool];
  if (hardLimit != null && Number(args.amount) > hardLimit) {
    return { verdict: VERDICT.REJECT, reasons: [`amount ${args.amount} above hard limit ${hardLimit}`] };
  }

  if (rules.requireEvidence && args.orderId && !String(context.request.text || '').includes(args.orderId)) {
    reasons.push(`request does not mention ${args.orderId}: the model may be acting on the wrong object`);
  }
  if (confidence < rules.minConfidence) {
    reasons.push(`confidence ${confidence} below ${rules.minConfidence}`);
  }
  const autoLimit = rules.autoLimitByTool[tool];
  if (autoLimit != null && Number(args.amount) > autoLimit) {
    reasons.push(`amount ${args.amount} above automatic limit ${autoLimit}`);
  }

  return reasons.length
    ? { verdict: VERDICT.ESCALATE, reasons }
    : { verdict: VERDICT.EXECUTE, reasons: ['within automatic limits with evidence'] };
}

module.exports = { VERDICT, DEFAULT_RULES, decide };
