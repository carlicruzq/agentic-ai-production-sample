'use strict';
// One vocabulary for failure, because "it failed" is not actionable.
//
// The distinction that matters in production is not what broke, but whether
// trying again can possibly help. Everything else — the message, the provider,
// the stack — is detail. Code that cannot answer "is this retryable?" ends up
// either retrying a validation error forever or giving up on a timeout.

class AgentError extends Error {
  constructor(message, { retryable = false, code = 'AGENT_ERROR', cause } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

/** The request itself is wrong. Trying again changes nothing. */
class PermanentError extends AgentError {
  constructor(message, opts = {}) {
    super(message, { ...opts, retryable: false, code: opts.code || 'PERMANENT' });
  }
}

/** Something outside failed in a way that may not fail again. */
class TransientError extends AgentError {
  constructor(message, opts = {}) {
    super(message, { ...opts, retryable: true, code: opts.code || 'TRANSIENT' });
  }
}

/** The model returned something the schema does not accept. */
class InvalidOutputError extends PermanentError {
  constructor(errors) {
    super(`model output rejected: ${errors.join('; ')}`, { code: 'INVALID_OUTPUT' });
    this.errors = errors;
  }
}

/** A tool took longer than it is allowed to take. */
class ToolTimeoutError extends TransientError {
  constructor(name, ms) {
    super(`tool ${name} exceeded its ${ms}ms budget`, { code: 'TOOL_TIMEOUT' });
    this.tool = name;
  }
}

// An unknown error is treated as transient ONLY when it carries a signal we
// recognise. Guessing "retryable" by default turns a bad request into an
// expensive loop; guessing "permanent" by default turns a blip into an outage.
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE']);
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function isRetryable(err) {
  if (!err) return false;
  if (typeof err.retryable === 'boolean') return err.retryable;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  if (typeof err.status === 'number') return RETRYABLE_STATUS.has(err.status);
  return false;
}

module.exports = { AgentError, PermanentError, TransientError, InvalidOutputError,
  ToolTimeoutError, isRetryable, RETRYABLE_CODES, RETRYABLE_STATUS };
