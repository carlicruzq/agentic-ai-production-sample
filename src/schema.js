'use strict';
// Closed-schema validation for model output. No coercion, no extra keys.

const PROPOSAL = {
  tool: { type: 'string', required: true },
  args: { type: 'object', required: true },
  confidence: { type: 'number', required: true, min: 0, max: 1 },
  rationale: { type: 'string', required: true, minLength: 3, maxLength: 500 },
};

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
function validate(value, schema = PROPOSAL) {
  const errors = [];
  if (typeOf(value) !== 'object') return { ok: false, errors: ['output is not a JSON object'] };
  for (const key of Object.keys(value)) {
    if (!schema[key]) errors.push(`unexpected key: ${key}`);
  }
  for (const [key, rule] of Object.entries(schema)) {
    const v = value[key];
    if (v === undefined) {
      if (rule.required) errors.push(`missing key: ${key}`);
      continue;
    }
    if (typeOf(v) !== rule.type) {
      errors.push(`${key}: expected ${rule.type}, got ${typeOf(v)}`);
      continue;
    }
    if (rule.type === 'number') {
      if (!Number.isFinite(v)) errors.push(`${key}: not a finite number`);
      if (rule.min != null && v < rule.min) errors.push(`${key}: below ${rule.min}`);
      if (rule.max != null && v > rule.max) errors.push(`${key}: above ${rule.max}`);
    }
    if (rule.type === 'string') {
      if (rule.minLength != null && v.trim().length < rule.minLength) errors.push(`${key}: too short`);
      if (rule.maxLength != null && v.length > rule.maxLength) errors.push(`${key}: too long`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/** Parses raw model text strictly: one JSON object, nothing around it. */
function parseStrict(text) {
  if (typeof text !== 'string') return { ok: false, errors: ['model returned non-text output'] };
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return { ok: false, errors: ['output must be a single JSON object with no surrounding text'] };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (e) {
    return { ok: false, errors: ['invalid JSON: ' + e.message] };
  }
}

module.exports = { PROPOSAL, validate, parseStrict };
