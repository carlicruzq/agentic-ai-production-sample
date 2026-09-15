'use strict';
// node examples/live.js "customer was charged twice for order A-100"
//
// The same agent, with Claude behind the adapter instead of the scripted model.
// This is the ONLY entry point in the repo that needs credentials and spends
// money; `npm test` and `npm run demo` never call an API.
//
//   npm install @anthropic-ai/sdk
//   export ANTHROPIC_API_KEY=...          # or: ant auth login
const { createAgent } = require('../src/agent');
const { anthropicModel } = require('../src/providers/anthropic');

(async () => {
  const text = process.argv.slice(2).join(' ')
    || 'Customer was charged twice for order A-100 and wants 40 back';
  const agent = createAgent({ model: anthropicModel() });
  const out = await agent.handle({ requester: 'ops@example.com', text });

  console.log(`\nrequest  ${text}`);
  console.log(`model    ${agent.state.history('proposal').at(-1).data.raw}`);
  console.log(`verdict  ${out.verdict}`);
  out.reasons.forEach((r) => console.log(`         ${r}`));
  if (out.output) console.log(`effect   ${JSON.stringify(out.output)}`);
  console.log(`\naudit trail\n${agent.state.trail()}\n`);
})().catch((e) => {
  console.error(`\n${e.message}`);
  if (/Cannot find module '@anthropic-ai\/sdk'/.test(e.message)) {
    console.error('Install the optional SDK first:  npm install @anthropic-ai/sdk\n');
  }
  process.exit(1);
});
