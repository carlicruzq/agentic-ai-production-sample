# agentic-ai-production-sample

**An LLM agent that is safe to run in production.** The model proposes; deterministic code
verifies and decides. Dependency-free Node.js, ~1.000 lines, 56 tests, runs offline.

```
npm test          # 56 tests, no network, no API key, no cost
npm run demo      # six requests through the agent, with the reasoning printed
```

---

## The problem this is about

The demo of an agent is easy. What is hard is the part nobody sees in the demo: the day it
confidently does the wrong thing to a real record, and the log cannot tell you why.

Almost every guardrail people reach for first is the model grading itself — a confidence
score, a rationale, a second model checking the first. None of those are evidence. They are
the same system agreeing with itself in a new paragraph.

So the rule here is narrow and mechanical:

> **The model's only output is a proposal. Nothing it says grants it authority. Every action
> is authorised by facts this system retrieved on its own, checked by a pure function you
> can read in one sitting.**

## What that looks like in practice

Four cases from `npm run demo`, all with the same model and the same code:

| Request | Model says | System does |
|---|---|---|
| Charged twice for A-100 | refund $40, confidence 0.93 | **EXECUTE** — looked the order up: paid, $80 refundable |
| Refund A-200 | refund $350, confidence 0.90 | **ESCALATE** — verified, but above the automatic limit |
| Refund A-300 | refund $9000, **confidence 1.00** | **REJECT** — above the hard limit. Confidence buys nothing |
| Refund A-400, charged twice | refund $40, **confidence 0.99**, fluent rationale | **ESCALATE** — the order is already refunded, and the lookup says so |

The last row is the one that matters. Nothing in the model's output is wrong-looking. The
proposal is well-formed, the confidence is high, the rationale is plausible. It is stopped
because the system went and read the order, and the order disagrees.

## How it works

```
                      ┌──────────────────────────────────────────┐
  request ──────────► │ 1. model.propose()                       │  the ONLY model call
                      │    → { tool, args, confidence, rationale }│
                      └───────────────┬──────────────────────────┘
                                      ▼
                      ┌──────────────────────────────────────────┐
                      │ 2. schema.validate()                     │  closed schema, no coercion
                      │    invalid → ask again WITH the errors   │  bounded: N attempts, then fail
                      └───────────────┬──────────────────────────┘
                                      ▼
                      ┌──────────────────────────────────────────┐
                      │ 3. investigate()                         │  the system checks the claim
                      │    read-only tools → evidence ledger     │  with its OWN tools
                      └───────────────┬──────────────────────────┘
                                      ▼
                      ┌──────────────────────────────────────────┐
                      │ 4. gate.decide()   ← pure function       │  no model, no clock, no I/O
                      └──┬────────────────┬───────────────────┬──┘
                         ▼                ▼                   ▼
                     EXECUTE          ESCALATE             REJECT
                    tools.run()     escalation.ask()      audit only
                         └────────────────┴───────────────────┘
                                          ▼
                                   state.log()  — append-only, frozen, redacted
```

Every step is appended to the audit trail, including the rejected ones. The test for that
log is: six months from now, can someone reconstruct the decision **without re-running the
model** and getting a different answer?

## The seven concerns, and where each one lives

| Concern | File | The idea, in one line |
|---|---|---|
| **Scoped tools** | `src/tools.js` | The agent can call only what is registered, with the exact argument shape declared — plus timeouts and idempotency keys, so a retry never doubles a side effect. |
| **Closed output schema** | `src/schema.js` | One JSON object, no extra keys, no coercion. Anything else is rejected, never "best-effort parsed". |
| **Verified evidence** | `src/evidence.js` | A fact is something a read-only tool returned, bound to the object it describes. An unchecked requirement is `UNKNOWN`, which is **not** a pass. |
| **Deterministic gate** | `src/gate.js` | `EXECUTE` / `ESCALATE` / `REJECT` from rules and facts. Pure: same input, same verdict, forever. |
| **Human in the loop** | `src/escalation.js` | Escalations are deduplicated and capped per person per day, so asking a human has a cost the system respects instead of spamming the one person who answers. |
| **Retries & error handling** | `src/retry.js`, `src/errors.js` | Retryable vs. permanent is a property of the error, not a guess. Exponential backoff with full jitter, a hard budget, and the original error preserved. |
| **Audit trail** | `src/state.js` | Append-only, frozen events, secrets redacted, optionally streamed to JSONL. |

Three design choices are worth calling out because they are the ones that get skipped:

- **Unknown is not OK.** A validator that returns "no problems" because it never ran looks
  exactly like one that ran and found nothing. Here they are different values, and only one
  of them is allowed to authorise an action.
- **Evidence is bound to its subject.** Facts about order A-100 authorise nothing about
  A-200 — a whole class of "the agent acted on the wrong record" bugs that generic checks
  miss, because nothing was technically *missing*.
- **The hard limit is a rejection, not an escalation.** An escalation invites a tired human
  to approve at 2am something the agent was never permitted to do.

## Using a real model

Everything above runs against a scripted model, which is why the tests need no key and cost
nothing. The vendor lives in exactly one file, `src/providers/anthropic.js`:

```bash
npm install @anthropic-ai/sdk        # optional — only this path needs it
export ANTHROPIC_API_KEY=...
node examples/live.js "customer was charged twice for order A-100"
```

That adapter uses Claude's tool calling with `strict: true` — but it gives the model a
single tool, `propose_action`, whose only effect is to return a structured proposal. Real
tool calling, with the authority taken out of it. The schema guarantees the arguments
validate; the gate decides whether any of it happens.

Swapping providers means writing one function: `propose({ request, tools, feedback }) → string`.

## Running it

Node 18+. No dependencies.

```bash
npm test          # 56 tests
npm run demo      # the walk-through above
npm run check     # syntax check every file

docker build -t agentic-sample .
docker run --rm --network none agentic-sample     # the suite, with no network at all
```

CI runs the tests on Node 18/20/22, runs the demo (a README example that quietly broke two
refactors ago is worse than no example), asserts the runtime has zero dependencies, and runs
the whole suite inside a container with `--network none` — which is how the claim "the
default path calls no API" is enforced rather than asserted.

## Scope

This is a **sample**, deliberately small enough to read in one sitting. The patterns come
from systems I build and operate — document analysis with LLMs, field-operations reporting,
automated market applications, trading operations — rewritten from scratch here. No client
code, data, credentials or business logic.

What a production deployment adds on top and this does not include: durable state (the
ledger and audit trail are in-memory by default, with a JSONL sink as the seam), a real
queue, multi-tenant authorisation, and per-tenant rate limits.

More detail on the reasoning: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## License

MIT
