import { test } from 'node:test';
import assert from 'node:assert';

import {
  findModelCapability,
  inferModelCapabilities,
  modelCapabilityCatalog,
} from '../model-capabilities.mjs';

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
  assert.equal(findModelCapability('deepseek-v4-pro-vision'), null);
});

test('unknown models fail open without inheriting family capabilities', () => {
  for (const model of [
    'gpt-5.6-sol',
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
    { inputModalities: ['text', 'image'], source: 'upstream' },
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
  first.models[0].inputModalities.push('image');
  const second = modelCapabilityCatalog();
  assert.notDeepEqual(first.models[0].inputModalities, second.models[0].inputModalities);
});
