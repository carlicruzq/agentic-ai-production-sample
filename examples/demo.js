'use strict';
// node examples/demo.js
const { createAgent } = require('../src/agent');
const { fakeModel } = require('../src/model');

(async () => {
  const cases = [
    { text: 'Customer charged twice for order A-100', proposal: { tool: 'refund', args: { orderId: 'A-100', amount: 40 }, confidence: 0.93, rationale: 'duplicate charge' } },
    { text: 'Customer wants a refund for order A-200', proposal: { tool: 'refund', args: { orderId: 'A-200', amount: 350 }, confidence: 0.9, rationale: 'damaged item' } },
    { text: 'Please refund order A-300', proposal: { tool: 'refund', args: { orderId: 'A-300', amount: 9000 }, confidence: 1, rationale: 'customer insists' } },
  ];
  for (const c of cases) {
    const agent = createAgent({ model: fakeModel([c.proposal]) });
    const out = await agent.handle({ requester: 'ops@example.com', text: c.text });
    console.log(`${c.text}\n  → ${out.verdict}: ${out.reasons.join('; ')}\n`);
  }
})();
