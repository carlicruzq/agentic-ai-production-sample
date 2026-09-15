'use strict';
// Scoped tool registry. The agent can only call what is registered here, and
// each tool declares the exact argument shape it accepts.

const { validate } = require('./schema');

function createRegistry() {
  const tools = new Map();

  function register(name, { args, run, description }) {
    if (tools.has(name)) throw new Error(`tool already registered: ${name}`);
    tools.set(name, { name, args, run, description });
  }

  function has(name) {
    return tools.has(name);
  }

  function checkArgs(name, input) {
    const tool = tools.get(name);
    if (!tool) return { ok: false, errors: [`unknown tool: ${name}`] };
    return validate(input, tool.args);
  }

  async function run(name, input) {
    const check = checkArgs(name, input);
    if (!check.ok) throw new Error(`refusing to run ${name}: ${check.errors.join('; ')}`);
    return tools.get(name).run(input);
  }

  function describe() {
    return [...tools.values()].map((t) => ({ name: t.name, description: t.description }));
  }

  return { register, has, checkArgs, run, describe };
}

/** Example tools for the demo and tests. Side effects are simulated. */
function defaultRegistry() {
  const registry = createRegistry();
  registry.register('refund', {
    description: 'Refund part or all of an order',
    args: {
      orderId: { type: 'string', required: true, minLength: 3, maxLength: 40 },
      amount: { type: 'number', required: true, min: 0.01, max: 100000 },
    },
    run: async ({ orderId, amount }) => ({ refunded: amount, orderId, reference: `RF-${orderId}` }),
  });
  registry.register('lookup_order', {
    description: 'Read an order (no side effects)',
    args: { orderId: { type: 'string', required: true, minLength: 3, maxLength: 40 } },
    run: async ({ orderId }) => ({ orderId, status: 'PAID' }),
  });
  return registry;
}

module.exports = { createRegistry, defaultRegistry };
