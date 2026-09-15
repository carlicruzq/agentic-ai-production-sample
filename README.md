# agentic-ai-production-sample

A small, dependency-free Node.js sample of how I build **LLM agents that are safe to run in production**:
the model proposes, deterministic code decides.

It is intentionally tiny and self-contained. The patterns come from systems I build and operate
(document analysis, field operations, trading), rewritten from scratch for this sample — no client
code, data or credentials.

## What it shows

| Concern | Where | Idea |
|---|---|---|
| Scoped tools | `src/tools.js` | The agent can only call registered tools, each with an allowlisted argument shape. |
| Closed output schema | `src/schema.js` | Every model response is validated; anything outside the schema is rejected, never "best-effort parsed". |
| Bounded retries | `src/agent.js` | Invalid output is retried within a fixed budget, then the step fails loudly instead of returning half-formed data. |
| Deterministic gate | `src/gate.js` | The final decision (`EXECUTE` / `ESCALATE` / `REJECT`) is a pure function over rules. The model's proposal is kept for audit, without authority. |
| Human in the loop | `src/escalation.js` | Escalations are deduplicated and capped per person per day, so asking a human has a cost the system respects. |
| State & audit trail | `src/state.js` | Every step (proposal, validation, verdict, result) is appended to an in-memory log that can be persisted. |
| Provider-agnostic model | `src/model.js` | One adapter interface; tests and the demo use a deterministic fake model. |

## Architecture

```
request ──► model.propose()  ──► schema.validate() ──(invalid, retry ≤ N)──┐
                                        │                                 │
                                        ▼                                 │
                                 gate.decide(proposal, context) ◄─────────┘
                                   │          │           │
                                EXECUTE    ESCALATE     REJECT
                                   │          │           │
                           tools.run()  escalation.ask()  audit only
                                   └──────────┴───────────┴──► state.log()
```

The model never executes anything directly and cannot raise its own authority: a proposal that the
gate rejects is recorded, not retried into acceptance.

## Run

Requires Node.js 18+. No dependencies.

```bash
npm test          # node --test
node examples/demo.js
```

## Example

```js
const { createAgent } = require('./src/agent');
const { fakeModel } = require('./src/model');

const agent = createAgent({ model: fakeModel([{ tool: 'refund', args: { orderId: 'A-1', amount: 40 },
  confidence: 0.92, rationale: 'duplicate charge' }]) });

const out = await agent.handle({ requester: 'ops@example.com', text: 'Customer was charged twice for A-1' });
// out.verdict === 'EXECUTE'   (amount under the automatic limit, evidence present)
```

## License

MIT
