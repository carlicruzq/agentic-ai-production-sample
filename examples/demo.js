'use strict';
// node examples/demo.js
//
// Six requests through the same agent. No network, no API key, no cost: the
// model is scripted, so what you are watching is the part that decides.
const { createAgent } = require('../src/agent');
const { fakeModel } = require('../src/model');

const CASES = [
  { title: 'Small refund, order verified',
    text: 'Customer was charged twice for order A-100',
    proposal: { tool: 'refund', args: { orderId: 'A-100', amount: 40 },
      confidence: 0.93, rationale: 'duplicate charge on a paid order' },
    expect: 'runs: every requirement was confirmed against the real order' },

  { title: 'Large refund, order verified',
    text: 'Customer wants a refund for order A-200',
    proposal: { tool: 'refund', args: { orderId: 'A-200', amount: 350 },
      confidence: 0.9, rationale: 'damaged item' },
    expect: 'a human decides: above the automatic limit' },

  { title: 'Very large refund',
    text: 'Please refund order A-300',
    proposal: { tool: 'refund', args: { orderId: 'A-300', amount: 9000 },
      confidence: 1, rationale: 'customer insists' },
    expect: 'rejected outright: confidence 1.0 does not buy authority' },

  { title: 'Confident and wrong',
    text: 'Refund order A-400, they were charged twice',
    proposal: { tool: 'refund', args: { orderId: 'A-400', amount: 40 },
      confidence: 0.99, rationale: 'the customer was clearly charged twice' },
    expect: 'stopped: the order is already refunded, and the lookup says so' },

  { title: 'An order that does not exist',
    text: 'Refund A-999',
    proposal: { tool: 'refund', args: { orderId: 'A-999', amount: 40 },
      confidence: 0.88, rationale: 'customer reports a double charge' },
    expect: 'stopped: no such order' },

  { title: 'Malformed model output, then a valid retry',
    text: 'Customer was charged twice for order A-100',
    script: ['I think we should refund this one!',
      { tool: 'refund', args: { orderId: 'A-100', amount: 25 },
        confidence: 0.91, rationale: 'duplicate charge' }],
    expect: 'runs: the first answer was not a valid proposal and was asked again' },
];

const pad = (s, n) => String(s).padEnd(n);

(async () => {
  for (const c of CASES) {
    const agent = createAgent({ model: fakeModel(c.script || [c.proposal]) });
    const out = await agent.handle({ requester: 'ops@example.com', text: c.text });
    console.log(`\n\x1b[1m${c.title}\x1b[0m`);
    console.log(`  request   ${c.text}`);
    console.log(`  verdict   ${pad(out.verdict, 9)} ${out.reasons[0]}`);
    out.reasons.slice(1).forEach((r) => console.log(`            ${' '.repeat(9)} ${r}`));
    if (out.output) console.log(`  effect    ${JSON.stringify(out.output)}`);
    console.log(`  expected  ${c.expect}`);
    console.log(`  audit     ${agent.state.trail().split('\n').join(' · ')}`);
  }
  console.log('\nNothing above called a model API. The decisions are code.\n');
})();
