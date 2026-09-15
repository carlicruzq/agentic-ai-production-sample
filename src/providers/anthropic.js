'use strict';
// ===== A real provider, behind the same one-method interface =====
//
// This is the only file in the repo that knows a vendor exists. Everything
// else — the gate, the evidence ledger, the audit trail, every test — runs
// against `fakeModel`, which is why `npm test` needs no key and costs nothing.
//
// The SDK is an OPTIONAL dependency, required lazily. The repo installs and
// tests with zero dependencies; you only need `@anthropic-ai/sdk` if you
// actually want to talk to Claude:
//
//     npm install @anthropic-ai/sdk
//     export ANTHROPIC_API_KEY=...        # or: ant auth login
//     node examples/live.js "customer was charged twice for order A-100"
//
// ---------------------------------------------------------------------------
// Why the model is given ONE tool, and it is not a real one
// ---------------------------------------------------------------------------
// The obvious design is to hand Claude the real `refund` tool and let it call
// it. That is also the design where the model's decision IS the execution:
// whatever the model emits, happens. This repo's whole claim is the opposite —
// the model proposes, deterministic code decides — so the model is given a
// single tool, `propose_action`, whose only effect is to return a structured
// proposal. Real tool calling, with the authority removed from it.
//
// The benefit is not theoretical. Because the proposal is a tool call with a
// `strict: true` schema, the arguments are guaranteed to validate — the model
// cannot answer with prose, a code fence, or a missing field, which is the
// failure `src/schema.js` exists to catch when a provider offers no such
// guarantee.

const MODEL = 'claude-opus-5';

const SYSTEM = `You are the proposal stage of an automated support agent.

You do NOT perform actions. You inspect the request and propose exactly one
action by calling the propose_action tool. Deterministic code downstream
decides whether your proposal runs, is escalated to a human, or is rejected —
and it verifies your claims against the real records before acting.

Because of that:
- Propose the action the request actually supports, not the one that would be
  approved. Overstating confidence does not widen what you are allowed to do;
  it only makes the audit trail wrong.
- confidence is your honest estimate that this is the correct action for this
  request. If the request is ambiguous, say so with a low number.
- rationale is one sentence a human reviewer can check against the request.`;

/** The proposal, expressed as a tool schema the API will enforce. */
function proposalTool(toolNames) {
  return {
    name: 'propose_action',
    description: 'Propose exactly one action for deterministic code to evaluate.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: toolNames,
          description: 'Which action to propose.' },
        args: { type: 'object', description: 'Arguments for that action.',
          additionalProperties: true },
        confidence: { type: 'number', minimum: 0, maximum: 1,
          description: 'Honest probability that this is the right action.' },
        rationale: { type: 'string', minLength: 3, maxLength: 500,
          description: 'One sentence, checkable against the request.' },
      },
      required: ['tool', 'args', 'confidence', 'rationale'],
      additionalProperties: false,
    },
  };
}

function describeCatalogue(tools) {
  return tools.map((t) => `- ${t.name}${t.readOnly ? ' (read-only)' : ''}: ${t.description}\n`
    + `  arguments: ${JSON.stringify(t.input_schema)}`).join('\n');
}

/**
 * @param {object} opts
 *   client   an Anthropic client (injectable — that is how this file is tested
 *            without a network); constructed lazily from the SDK otherwise.
 *   model    defaults to claude-opus-5
 *   effort   low | medium | high | xhigh | max
 */
function anthropicModel({ client = null, model = MODEL, effort = 'medium',
  maxTokens = 4096 } = {}) {
  let sdk = client;

  function getClient() {
    if (sdk) return sdk;
    // Required here, not at the top of the file: importing it at module load
    // would make the whole repo depend on a package the tests never use.
    // eslint-disable-next-line global-require, import/no-unresolved
    const Anthropic = require('@anthropic-ai/sdk');
    // No apiKey argument: the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
    // or an `ant auth login` profile on its own. Hardcoding one is how keys end
    // up in git history.
    sdk = new Anthropic();
    return sdk;
  }

  return {
    name: `anthropic:${model}`,
    /**
     * @returns {Promise<string>} the proposal as JSON text, so this adapter is
     *          interchangeable with every other one. The agent loop does not
     *          learn a second shape just because the provider has one.
     */
    async propose({ request, tools, feedback }) {
      const names = tools.filter((t) => !t.readOnly).map((t) => t.name);
      const user = [
        `Request from ${request.requester || 'unknown'}:`,
        request.text,
        '',
        'Actions you may propose:',
        describeCatalogue(tools.filter((t) => !t.readOnly)),
        feedback ? `\nYour previous proposal was rejected: ${feedback}\nFix exactly that.` : '',
      ].join('\n');

      const response = await getClient().messages.create({
        model,
        max_tokens: maxTokens,
        system: SYSTEM,
        output_config: { effort },
        tools: [proposalTool(names)],
        tool_choice: { type: 'tool', name: 'propose_action' },
        messages: [{ role: 'user', content: user }],
      });

      // A refusal is a real outcome, not an exception. Returning the raw text
      // would make it fail later as "invalid JSON", which hides why.
      if (response.stop_reason === 'refusal') {
        const why = response.stop_details ? response.stop_details.category : 'unspecified';
        const err = new Error(`the model declined to answer (${why})`);
        err.retryable = false;
        throw err;
      }
      const call = response.content.find((b) => b.type === 'tool_use');
      if (!call) {
        const err = new Error('the model returned no proposal');
        err.retryable = true;   // usually a truncated turn; another ask can help
        throw err;
      }
      return JSON.stringify(call.input);
    },
  };
}

module.exports = { anthropicModel, proposalTool, MODEL, SYSTEM };
