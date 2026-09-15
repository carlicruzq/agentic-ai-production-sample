'use strict';
// ===== The deterministic gate: the model proposes, this decides =====
//
// A pure function. Same input, same verdict — no model call, no randomness, no
// clock, no I/O. That is the whole point: the part of the system that grants
// authority has to be reviewable line by line and reproducible in a test, and a
// second LLM grading the first one is neither.
//
// The model's proposal enters here as DATA. It cannot raise its own authority:
// a high `confidence` widens nothing, and a rationale is not an argument. The
// only things that move a verdict are rules and verified facts.
const { verify } = require('./evidence');

const VERDICT = { EXECUTE: 'EXECUTE', ESCALATE: 'ESCALATE', REJECT: 'REJECT' };

// Requirements are declared per tool, next to the limits, so that "what has to
// be true before we do this" lives in the same place as "how much we allow".
const DEFAULT_RULES = {
  readOnlyTools: ['lookup_order'],
  autoLimitByTool: { refund: 100 },     // above this, a human decides
  hardLimitByTool: { refund: 5000 },    // above this, the agent never acts
  minConfidence: 0.8,                   // below this, a human decides
  evidenceByTool: {
    refund: [
      { key: 'exists', describe: 'the order exists',
        test: (v) => v === true },
      { key: 'status', describe: 'the order was actually paid',
        test: (v) => v === 'PAID' },
      { key: 'refundable_amount', describe: 'the amount asked for is actually refundable',
        test: (v, facts) => {
          const asked = facts.find((f) => f.key === 'requested_amount');
          return asked ? Number(v) >= Number(asked.value) : false;
        } },
    ],
  },
};

/**
 * @param {object} proposal  validated: { tool, args, confidence, rationale }
 * @param {object} context   { request, registry, ledger }
 * @returns {{verdict, reasons, evidence}}
 */
function decide(proposal, context, rules = DEFAULT_RULES) {
  const { tool, args, confidence } = proposal;
  const { registry, ledger } = context;

  // --- 1. Is this even a tool we have? -------------------------------------
  if (!registry.has(tool)) {
    return { verdict: VERDICT.REJECT, reasons: [`tool not registered: ${tool}`] };
  }
  const argCheck = registry.checkArgs(tool, args);
  if (!argCheck.ok) {
    return { verdict: VERDICT.REJECT, reasons: argCheck.errors.map((e) => `invalid args: ${e}`) };
  }

  // --- 2. Read-only tools are free ------------------------------------------
  // Reading is how evidence gets collected in the first place. Gating reads
  // behind evidence would be a deadlock, not a safety property.
  if (rules.readOnlyTools.includes(tool)) {
    return { verdict: VERDICT.EXECUTE, reasons: ['read-only tool: no side effect to authorise'] };
  }

  // --- 3. Hard limits are not negotiable ------------------------------------
  // Deliberately before evidence: no amount of verification buys authority the
  // agent was never given. This is a REJECT, not an escalation, because an
  // escalation invites a tired human to approve it at 2am.
  const hard = rules.hardLimitByTool[tool];
  if (hard != null && Number(args.amount) > hard) {
    return { verdict: VERDICT.REJECT,
      reasons: [`amount ${args.amount} is above the hard limit of ${hard} for ${tool}`] };
  }

  const reasons = [];

  // --- 4. Evidence ----------------------------------------------------------
  const subject = args.orderId || args.id || args.subject;
  const requirements = rules.evidenceByTool[tool] || [];
  const evidence = ledger ? verify(requirements, subject, ledger)
    : { ok: false, checked: 0, results: [], failed: [], unknown: [],
      summary: 'no evidence ledger was supplied: nothing could be verified' };
  if (!evidence.ok) {
    reasons.push(evidence.summary);
    evidence.failed.concat(evidence.unknown).forEach((r) => reasons.push(r.detail));
  }

  // --- 5. Confidence and the automatic limit --------------------------------
  // Confidence can only ever LOWER authority here. It is the model's opinion of
  // its own work, which is exactly the thing that cannot be self-certified.
  if (confidence < rules.minConfidence) {
    reasons.push(`the model's own confidence (${confidence}) is below ${rules.minConfidence}`);
  }
  const auto = rules.autoLimitByTool[tool];
  if (auto != null && Number(args.amount) > auto) {
    reasons.push(`amount ${args.amount} is above the automatic limit of ${auto}`);
  }

  return reasons.length
    ? { verdict: VERDICT.ESCALATE, reasons, evidence }
    : { verdict: VERDICT.EXECUTE,
      reasons: [`within automatic limits; ${evidence.summary}`], evidence };
}

module.exports = { VERDICT, DEFAULT_RULES, decide };
