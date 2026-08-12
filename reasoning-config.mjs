'use strict';

export const CHAT_REASONING_PARAMETERS = [
  'reasoning_effort',
  'enable_thinking',
  'thinking_budget',
];

const REASONING_EFFORT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function normalizeReasoningEffort(value, field) {
  const effort = String(value || '').trim().toLowerCase();
  if (!REASONING_EFFORT_RE.test(effort)) {
    throw new Error(`${field} must use a short lowercase identifier`);
  }
  return effort;
}

function normalizeReasoningValue(value, field) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new Error(`${field} must be a string, number, or boolean`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`${field} must be finite`);
  }
  return value;
}

export function normalizeReasoningConfig(value, field = 'reasoning') {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object or null`);
  }
  const parameter = String(value.parameter || 'reasoning_effort').trim().toLowerCase();
  if (!CHAT_REASONING_PARAMETERS.includes(parameter)) {
    throw new Error(
      `${field} parameter must be one of: ${CHAT_REASONING_PARAMETERS.join(', ')}`,
    );
  }
  if (!Array.isArray(value.levels) || !value.levels.length) {
    throw new Error(`${field} levels must be a non-empty array`);
  }
  if (value.levels.length > 10) {
    throw new Error(`${field} levels must contain at most 10 entries`);
  }
  const seen = new Set();
  const levels = value.levels.map((entry, index) => {
    const levelField = `${field} levels[${index}]`;
    const source = typeof entry === 'string' ? { effort: entry } : entry;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error(`${levelField} must be an object or string`);
    }
    const effort = normalizeReasoningEffort(source.effort, `${levelField}.effort`);
    if (seen.has(effort)) throw new Error(`${field} contains duplicate effort ${effort}`);
    seen.add(effort);
    const description = source.description === undefined
      ? undefined
      : String(source.description).trim();
    if (description && description.length > 200) {
      throw new Error(`${levelField}.description must be at most 200 characters`);
    }
    const upstreamValue = source.upstreamValue === undefined
      ? source.value
      : source.upstreamValue;
    return {
      effort,
      ...(description ? { description } : {}),
      ...(upstreamValue === undefined
        ? {}
        : { upstreamValue: normalizeReasoningValue(upstreamValue, `${levelField}.upstreamValue`) }),
    };
  });
  const defaultEffort = normalizeReasoningEffort(
    value.default ?? levels[0].effort,
    `${field}.default`,
  );
  if (parameter === 'thinking_budget' && levels.some(
    level => typeof level.upstreamValue !== 'number' || level.upstreamValue < 0,
  )) {
    throw new Error(`${field} thinking_budget levels require non-negative numeric upstreamValue values`);
  }
  if (parameter === 'enable_thinking' && levels.some(level => {
    const mapped = level.upstreamValue ?? (['on', 'off'].includes(level.effort)
      ? level.effort === 'on'
      : undefined);
    return typeof mapped !== 'boolean';
  })) {
    throw new Error(`${field} enable_thinking levels require boolean upstreamValue values or on/off efforts`);
  }
  if (!seen.has(defaultEffort)) {
    throw new Error(`${field}.default must reference one of the configured efforts`);
  }
  return {
    parameter,
    default: defaultEffort,
    levels,
  };
}

export function normalizeCatalogReasoningConfig(value, field = 'reasoning') {
  if (value === null) {
    throw new Error(`${field} must be an object`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [index, level] of (Array.isArray(value.levels) ? value.levels : []).entries()) {
      if (
        level
        && typeof level === 'object'
        && !Array.isArray(level)
        && ('upstreamValue' in level || 'value' in level)
      ) {
        throw new Error(`${field} levels[${index}] must not define upstreamValue`);
      }
    }
  }
  const reasoning = normalizeReasoningConfig(value, field);
  if (!reasoning) {
    throw new Error(`${field} must be an object`);
  }
  if (reasoning.parameter !== 'reasoning_effort') {
    throw new Error(`${field} only supports the reasoning_effort parameter`);
  }
  return reasoning;
}
