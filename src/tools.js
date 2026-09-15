'use strict';
// ===== Scoped tool registry =====
// The agent can only call what is registered here, with the exact argument
// shape the tool declares. Everything a tool is allowed to do is visible in one
// file, which is what makes the blast radius reviewable.
const { validate } = require('./schema');
const { withRetry, withTimeout } = require('./retry');
const { PermanentError, ToolTimeoutError } = require('./errors');

const DEFAULT_TIMEOUT_MS = 5000;

function createRegistry({ timeoutMs = DEFAULT_TIMEOUT_MS, retry = {} } = {}) {
  const tools = new Map();
  // ===== Idempotency =====
  // A retry that re-runs a side effect is worse than no retry. The key is the
  // caller's, not a timestamp and not a UUID minted here: "the same request"
  // has to mean the same thing across a restart, and a clock cannot express
  // that. See `effectKey` below for how the default is derived.
  const effects = new Map();

  function register(name, { args, run, description, readOnly = false, effectKey } = {}) {
    if (tools.has(name)) throw new Error(`tool already registered: ${name}`);
    if (typeof run !== 'function') throw new Error(`tool ${name} has no run function`);
    tools.set(name, { name, args: args || {}, run, description, readOnly, effectKey });
  }

  const has = (name) => tools.has(name);
  const get = (name) => tools.get(name);
  const isReadOnly = (name) => !!(tools.get(name) || {}).readOnly;

  function checkArgs(name, input) {
    const tool = tools.get(name);
    if (!tool) return { ok: false, errors: [`unknown tool: ${name}`] };
    return validate(input, tool.args);
  }

  /** Default identity of a side effect: the tool plus its arguments, ordered. */
  function effectKey(name, input) {
    const tool = tools.get(name);
    if (tool && tool.effectKey) return `${name}:${tool.effectKey(input)}`;
    const ordered = Object.keys(input || {}).sort()
      .map((k) => `${k}=${JSON.stringify(input[k])}`).join('&');
    return `${name}:${ordered}`;
  }

  async function run(name, input, { idempotencyKey } = {}) {
    const check = checkArgs(name, input);
    if (!check.ok) {
      throw new PermanentError(`refusing to run ${name}: ${check.errors.join('; ')}`,
        { code: 'INVALID_TOOL_ARGS' });
    }
    const tool = tools.get(name);
    const key = idempotencyKey || effectKey(name, input);
    if (!tool.readOnly && effects.has(key)) {
      // Replayed, not re-executed — and it says so, so a caller can tell the
      // difference between "we refunded it" and "we refunded it twice".
      return { ...effects.get(key), replayed: true };
    }
    const result = await withRetry(
      () => withTimeout(Promise.resolve().then(() => tool.run(input)), timeoutMs, `tool ${name}`)
        .catch((e) => {
          if (e && e.code === 'TIMEOUT') throw new ToolTimeoutError(name, timeoutMs);
          throw e;
        }),
      // Retrying a write is only safe because the idempotency key above makes a
      // repeat a no-op on our side. A tool whose remote side is not idempotent
      // should declare `retry: { attempts: 1 }`.
      { ...retry, ...(tool.readOnly ? {} : { attempts: (retry.attempts || 3) }) },
    );
    if (!tool.readOnly) effects.set(key, result);
    return result;
  }

  const describe = () => [...tools.values()].map((t) => ({
    name: t.name, description: t.description, readOnly: t.readOnly,
    input_schema: jsonSchemaOf(t.args),
  }));

  return { register, has, get, isReadOnly, checkArgs, run, describe, effectKey,
    effects: () => new Map(effects) };
}

/** Our small schema dialect rendered as JSON Schema, for the model's tool list. */
function jsonSchemaOf(args) {
  const properties = {};
  const required = [];
  for (const [k, rule] of Object.entries(args || {})) {
    properties[k] = { type: rule.type };
    if (rule.minimum != null || rule.min != null) properties[k].minimum = rule.minimum ?? rule.min;
    if (rule.maximum != null || rule.max != null) properties[k].maximum = rule.maximum ?? rule.max;
    if (rule.enum) properties[k].enum = rule.enum;
    if (rule.describe) properties[k].description = rule.describe;
    if (rule.required) required.push(k);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * The example domain: a support agent that can look an order up and refund it.
 * Side effects are simulated; the shape is what matters.
 */
function defaultRegistry(options = {}) {
  const orders = options.orders || new Map([
    ['A-100', { status: 'PAID', total: 80, refundable: 80, charges: 2 }],
    ['A-200', { status: 'PAID', total: 350, refundable: 350, charges: 1 }],
    ['A-300', { status: 'PAID', total: 9000, refundable: 9000, charges: 1 }],
    ['A-400', { status: 'REFUNDED', total: 40, refundable: 0, charges: 1 }],
  ]);
  const registry = createRegistry(options);

  registry.register('lookup_order', {
    description: 'Read an order. No side effects. This is how evidence is collected.',
    readOnly: true,
    args: { orderId: { type: 'string', required: true, minLength: 3, maxLength: 40,
      describe: 'The order identifier, e.g. A-100' } },
    run: async ({ orderId }) => {
      const o = orders.get(orderId);
      // "Not found" is an ANSWER, not an error: the absence of an order is a
      // fact the gate needs. Throwing here would make it retryable noise.
      return o ? { orderId, found: true, ...o } : { orderId, found: false };
    },
  });

  registry.register('refund', {
    description: 'Refund part or all of an order. Has a side effect.',
    args: {
      orderId: { type: 'string', required: true, minLength: 3, maxLength: 40 },
      amount: { type: 'number', required: true, min: 0.01, max: 100000 },
    },
    // Two refunds of the same amount on the same order are the same effect.
    effectKey: ({ orderId, amount }) => `${orderId}/${amount}`,
    run: async ({ orderId, amount }) => {
      const o = orders.get(orderId);
      if (!o) throw new PermanentError(`cannot refund unknown order ${orderId}`,
        { code: 'NO_SUCH_ORDER' });
      o.refundable = Math.max(0, o.refundable - amount);
      return { refunded: amount, orderId, reference: `RF-${orderId}-${amount}` };
    },
  });

  return registry;
}

module.exports = { createRegistry, defaultRegistry, jsonSchemaOf, DEFAULT_TIMEOUT_MS };
