# Architecture

The README says what this does. This file says why each decision went the way it did, and
what the alternative would have cost.

---

## 1. The model is a proposal engine, not an actor

The agent loop calls the model exactly once per request, at the start, and what comes back
is data:

```js
{ tool: 'refund', args: { orderId: 'A-100', amount: 40 }, confidence: 0.93, rationale: '…' }
```

Everything after that is ordinary code. The alternative — handing the model the real tools
and letting it call them — collapses proposal and execution into one step, and once they are
one step there is no place left to stand between the model and the side effect.

This is also why `src/providers/anthropic.js` gives Claude a single tool, `propose_action`,
instead of the real `refund` tool. The API's `strict: true` schema enforcement is genuinely
useful — it guarantees the arguments validate, which is a stronger promise than any parser —
but it must apply to the *proposal*, not to the action.

## 2. Confidence is not evidence

A model's confidence is its opinion of its own work. Treating it as a permission is asking
the thing under review to sign its own review.

So `confidence` appears in exactly one place in `src/gate.js`, and it can only ever *lower*
authority:

```js
if (confidence < rules.minConfidence) reasons.push(`…below ${rules.minConfidence}`);
```

There is no branch where a high confidence widens a limit, skips a check, or turns an
`ESCALATE` into an `EXECUTE`. `test/gate.test.js` fixes that: *"confidence 1.0 does not buy
authority: the hard limit still rejects."*

## 3. Three answers, not two

`src/evidence.js` answers every requirement with `MET`, `FAILED`, or `UNKNOWN`.

The two-valued version of this is where the expensive failures live. A validator that ran and
found nothing wrong, and a validator that never ran, both produce "no problems" — and the
second one is silent precisely when something is broken. Collapsing them into a boolean
destroys the distinction at exactly the moment it matters.

Concretely, in this repo:

- `verify([], subject, ledger)` returns `ok: false` with *"no requirements declared for this
  action: nothing was verified"*. Zero requirements is not zero problems.
- A missing ledger returns `ok: false`, not a pass.
- A requirement whose own test function throws returns `UNKNOWN`, not `MET`.
- An investigation that fails records nothing, so every requirement stays `UNKNOWN`, so the
  gate escalates. Failure of the checking machinery can only ever make the system *more*
  cautious.

## 4. Evidence is bound to its subject

Every fact carries the object it is about:

```js
ledger.record({ subject: 'A-100', key: 'status', value: 'PAID', source: 'lookup_order' });
```

Without that, a ledger full of recent, genuine, correctly-retrieved facts about order A-100
will happily authorise an action on A-200. Nothing is missing, nothing errors, every check
passes — and the agent acts on the wrong record. Binding the subject turns that silent class
of bug into an `UNKNOWN`, which escalates. It is one field, and it is load-bearing.

## 5. Reject and escalate are different verdicts

- **REJECT** — the agent was never permitted to do this. Above the hard limit, unregistered
  tool, malformed arguments.
- **ESCALATE** — this might be right, and a person has to decide.

The temptation is to escalate everything and let humans sort it out. That fails twice: it
buries the decisions that genuinely need a person under the ones that do not, and it invites
someone at the end of a long day to approve something the system was built to refuse. Note
in `src/gate.js` that the hard limit is checked *before* evidence — no amount of verification
buys authority that was never granted.

And escalation has a budget, in `src/escalation.js`: deduplicated by effect key, capped per
person per day, overflow queued. An alerting channel that cries wolf is an alerting channel
nobody reads, which is the same as not having one.

## 6. Retries: the classifier is the whole thing

`src/retry.js` is small. The part that matters is `src/errors.js`, because "should I try
again?" has exactly one correct answer per error and guessing it is how one incident becomes
two:

- Retrying a `400` forever turns a bad request into a self-inflicted outage.
- Not retrying a `503` turns a blip into a failure.
- Retrying without jitter turns N clients failing together into N clients returning together,
  which keeps the dependency down.

So errors declare `retryable` themselves; an unknown error is retried **only** if it carries
a signal we recognise (`ECONNRESET`, HTTP 429/5xx). Everything else is permanent by default —
cautious in the direction that costs least.

Two different retry loops exist in `src/agent.js` on purpose, and they are not the same loop:

- **Transport retry** — same prompt, exponential backoff. A reset connection should not
  consume one of the model's chances to answer.
- **Malformed-output retry** — a *new* prompt carrying the exact validation errors. That is a
  different request, not a repeat of the same one.

Both are bounded by `maxAttempts`. Asking a model over and over until it happens to emit
valid JSON turns a validation layer into a slot machine.

## 7. Idempotency belongs to the caller, not the clock

`src/tools.js` keys side effects by tool name plus ordered arguments (overridable per tool).
A UUID or a timestamp would make every retry a new effect, which defeats the purpose: "the
same request" has to mean the same thing across a process restart, and a clock cannot express
that.

A replayed effect returns `replayed: true` rather than silently returning the cached value,
so a caller can tell "we refunded it" from "we refunded it twice".

## 8. The audit trail has a test

Not "we log a lot" — a specific question the log has to answer:

> Six months from now, can someone reconstruct why the system did this, **without re-running
> the model** and getting a different answer?

That requires the proposal, the evidence with its sources, the verdict with its reasons, and
the result — in order, with nothing overwritten. So events are frozen, deep-copied on the way
in, and numbered. Rejected proposals are recorded too: the decisions that did *not* happen
are usually the interesting ones during an incident.

Secrets are redacted at the boundary, because the alternative is discovering a token in a log
shipper six months later.

## What a production deployment adds

Honest scope. This sample does **not** include:

- **Durable state.** The ledger and audit trail are in-memory; `createState({ file })` writes
  JSONL as the seam where a real store goes.
- **A queue.** Requests are handled inline.
- **Multi-tenant authorisation.** One rule set, one approver.
- **Rate limits per tenant** and a circuit breaker around the tool layer.
- **Evaluation.** A real deployment needs a graded set of requests and a way to tell whether
  a prompt change helped, which is a repo of its own.

What it does include is the part that is usually missing: a place to stand between the model
and the side effect, and a record of why the system did what it did.
