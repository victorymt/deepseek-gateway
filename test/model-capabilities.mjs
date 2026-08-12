import { test } from 'node:test';
import assert from 'node:assert';

import {
  findModelCapability,
  inferModelCapabilities,
  modelCapabilityCatalog,
} from '../model-capabilities.mjs';
import { normalizeCatalogReasoningConfig } from '../reasoning-config.mjs';

const DEEPSEEK_V4_REASONING = {
  parameter: 'reasoning_effort',
  default: 'high',
  levels: [
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'high', description: 'Extra high reasoning depth for complex problems' },
    { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
  ],
};

const GPT_5_6_SOL_REASONING = {
  parameter: 'reasoning_effort',
  default: 'medium',
  levels: [
    { effort: 'none', description: 'Lowest latency without additional reasoning' },
    { effort: 'low', description: 'Fast responses with light reasoning' },
    { effort: 'medium', description: 'Balanced reasoning for general work' },
    { effort: 'high', description: 'Deeper reasoning for complex tasks' },
    { effort: 'xhigh', description: 'Extra-high reasoning for difficult problems' },
    { effort: 'max', description: 'Maximum reasoning for the hardest problems' },
  ],
};

test('model capability registry uses exact normalized model ids', () => {
  assert.deepEqual(
    inferModelCapabilities('deepseek/deepseek-v4-pro').inputModalities,
    ['text'],
  );
  assert.deepEqual(
    inferModelCapabilities('models/GLM-5.2[1M]').inputModalities,
    ['text'],
  );
  assert.deepEqual(
    inferModelCapabilities('glm-5.2v').inputModalities,
    ['text', 'image'],
  );
  assert.deepEqual(inferModelCapabilities('gpt-5.6-sol'), {
    id: 'gpt-5.6-sol',
    inputModalities: ['text', 'image'],
    reasoning: GPT_5_6_SOL_REASONING,
    source: 'registry',
  });
  assert.equal(findModelCapability('deepseek-v4-pro-vision'), null);
});

test('unknown models fail open without inheriting family capabilities', () => {
  for (const model of [
    'deepseek-v4-pro-vision',
    'qwen3-coder-vl',
    'custom-relay-alias',
  ]) {
    const capabilities = inferModelCapabilities(model);
    assert.deepEqual(capabilities.inputModalities, ['text', 'image']);
    assert.equal(capabilities.source, 'default');
  }
});

test('upstream capability declarations override the registry', () => {
  assert.deepEqual(
    inferModelCapabilities('deepseek-v4-pro', { supports_image: true }),
    {
      inputModalities: ['text', 'image'],
      reasoning: DEEPSEEK_V4_REASONING,
      source: 'upstream',
    },
  );
  assert.deepEqual(
    inferModelCapabilities('gpt-4o', {
      architecture: { input_modalities: ['text'] },
    }),
    { inputModalities: ['text'], source: 'upstream' },
  );
});

test('public capability catalog returns detached JSON data', () => {
  const first = modelCapabilityCatalog();
  const firstReasoning = first.models.find(model => model.id === 'deepseek-v4-pro').reasoning;
  first.models[0].inputModalities.push('image');
  firstReasoning.default = 'low';
  firstReasoning.levels[0].description = 'mutated';
  const second = modelCapabilityCatalog();
  assert.notDeepEqual(first.models[0].inputModalities, second.models[0].inputModalities);
  assert.deepEqual(
    second.models.find(model => model.id === 'deepseek-v4-pro').reasoning,
    DEEPSEEK_V4_REASONING,
  );

  const found = findModelCapability('deepseek-v4-pro');
  found.reasoning.levels.push({ effort: 'custom' });
  assert.deepEqual(
    findModelCapability('deepseek-v4-pro').reasoning,
    DEEPSEEK_V4_REASONING,
  );
});

test('catalog reasoning profiles only allow standard reasoning_effort values', () => {
  assert.deepEqual(normalizeCatalogReasoningConfig({
    parameter: 'reasoning_effort',
    default: 'high',
    levels: ['low', 'high'],
  }), {
    parameter: 'reasoning_effort',
    default: 'high',
    levels: [{ effort: 'low' }, { effort: 'high' }],
  });

  for (const value of [
    null,
    { parameter: 'thinking_budget', levels: [{ effort: 'high', upstreamValue: 8192 }] },
    { parameter: 'enable_thinking', levels: [{ effort: 'on', upstreamValue: true }] },
    { parameter: 'reasoning_effort', levels: [{ effort: 'high', upstreamValue: 'high' }] },
    { parameter: 'reasoning_effort', levels: [{ effort: 'high', value: 'high' }] },
  ]) {
    assert.throws(() => normalizeCatalogReasoningConfig(value), /reasoning|object/);
  }
});
