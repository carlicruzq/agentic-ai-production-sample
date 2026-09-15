'use strict';
// ===== Collecting the facts the gate will ask for =====
//
// The order here is deliberate and it is the whole design: the model proposes
// an action FIRST, and only then does the system go and check it — with its own
// read-only tools, against the real records. The model never supplies the
// evidence for its own proposal. If it did, "verification" would just be the
// model agreeing with itself in a second paragraph.
//
// An investigator is allowed to fail. What it may not do is fail silently: a
// lookup that errors records nothing, the requirement stays UNKNOWN, and UNKNOWN
// escalates. That is the only safe direction for a missing check.

/**
 * @returns {object} map of toolName -> async (args, { registry, ledger }) => void
 */
function defaultInvestigators() {
  return {
    async refund(args, { registry, ledger }) {
      // What the request ASKED for is a claim, and it is recorded as such —
      // under its own key, so a requirement can compare it against a fact
      // instead of trusting it.
      ledger.record({ subject: args.orderId, key: 'requested_amount',
        value: Number(args.amount), source: 'proposal' });

      const order = await registry.run('lookup_order', { orderId: args.orderId });
      ledger.record({ subject: args.orderId, key: 'exists', value: !!order.found,
        source: 'lookup_order' });
      if (!order.found) return;
      ledger.record({ subject: args.orderId, key: 'status', value: order.status,
        source: 'lookup_order' });
      ledger.record({ subject: args.orderId, key: 'refundable_amount',
        value: Number(order.refundable), source: 'lookup_order' });
      ledger.record({ subject: args.orderId, key: 'charges', value: Number(order.charges),
        source: 'lookup_order' });
    },
  };
}

/**
 * Runs the investigator for a proposed action, if there is one.
 * Returns what happened so the audit trail can show it — including "there is no
 * investigator for this tool", which is itself a finding worth recording.
 */
async function investigate(proposal, { registry, ledger, investigators }) {
  const fn = (investigators || {})[proposal.tool];
  if (!fn) return { ran: false, tool: proposal.tool, reason: 'no investigator declared' };
  try {
    await fn(proposal.args, { registry, ledger });
    return { ran: true, tool: proposal.tool, facts: ledger.all().length };
  } catch (err) {
    // Nothing is recorded, so every requirement stays UNKNOWN and the gate
    // escalates. The error is reported, not swallowed into a passing state.
    return { ran: false, tool: proposal.tool, error: err.message,
      reason: 'the investigation failed: requirements stay unverified' };
  }
}

module.exports = { defaultInvestigators, investigate };
