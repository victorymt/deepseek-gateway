import { test } from 'node:test';
import assert from 'node:assert';

import {
  codexModelAlias,
  normalizeBalanceQuery,
  normalizeConfig,
  normalizeInputModalities,
  normalizeModelIdentifier,
  normalizeUpstreamFormat,
  serializableConfig,
} from '../config-core.mjs';

test('Codex model aliases capitalize the provider and use a dot separator', () => {
  assert.equal(codexModelAlias('aihub', 'gpt-5.6-sol'), 'Aihub.gpt-5.6-sol');
  assert.equal(codexModelAlias('open-router', 'claude/3.5-sonnet'), 'Open-router.claude/3.5-sonnet');
});

test('legacy config normalizes and serializes as canonical v2', () => {
  const normalized = normalizeConfig({
    upstream: 'https://legacy.example/v1/',
    keys: [{ name: 'primary', key: 'sk-legacy', weight: 2 }],
    breakerThreshold: 4,
    defaultModel: 'deepseek-v4-flash',
    customField: { keep: true },
  });
  const stored = serializableConfig(normalized);

  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.defaultProvider, 'deepseek');
  assert.equal(stored.defaultModel, 'deepseek--v4-flash');
  assert.equal(stored.blacklistThreshold, 4);
  assert.equal(stored.providers[0].baseUrl, 'https://legacy.example/v1');
  assert.equal(stored.providers[0].upstreamFormat, 'responses');
  assert.deepEqual(stored.providers[0].models[0].inputModalities, ['text']);
  assert.equal(stored.providers[0].keys[0].key, 'sk-legacy');
  assert.equal(stored.providers[0].keys[0].enabled, true);
  assert.equal(normalized.providers[0].keys[0].alwaysTry, false);
  assert.equal(stored.providers[0].keys[0].alwaysTry, undefined);
  assert.deepEqual(stored.customField, { keep: true });
  assert.equal(stored.upstream, undefined);
  assert.equal(stored.keys, undefined);
  assert.equal(stored.breakerThreshold, undefined);
});

test('provider key alwaysTry defaults to false and persists when enabled', () => {
  const normalized = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      id: 'alpha',
      baseUrl: 'https://alpha.example/v1',
      models: [{ id: 'chat', upstreamModel: 'chat' }],
      keys: [
        { name: 'primary', key: 'sk-primary', alwaysTry: true },
        { name: 'backup', key: 'sk-backup' },
      ],
    }],
  });
  const storedKeys = serializableConfig(normalized).providers[0].keys;

  assert.equal(normalized.providers[0].keys[1].alwaysTry, false);
  assert.equal(storedKeys[0].alwaysTry, true);
  assert.equal(storedKeys[1].alwaysTry, undefined);
});

test('provider upstream format defaults to Responses and accepts Chat Completions', () => {
  assert.equal(normalizeUpstreamFormat(undefined), 'responses');
  assert.equal(normalizeUpstreamFormat('chat-completions'), 'chat-completions');
  assert.throws(() => normalizeUpstreamFormat('anthropic'), /must be one of/);

  const normalized = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      id: 'alpha',
      baseUrl: 'https://alpha.example/v1',
      upstreamFormat: 'chat-completions',
      models: [{ id: 'chat', upstreamModel: 'chat' }],
      keys: [{ name: 'one', key: 'sk-one' }],
    }],
  });
  assert.equal(serializableConfig(normalized).providers[0].upstreamFormat, 'chat-completions');
});

test('model input modalities default to text and normalize image capability', () => {
  assert.deepEqual(normalizeInputModalities(undefined), ['text']);
  assert.deepEqual(normalizeInputModalities(['image', 'text', 'image']), ['text', 'image']);
  assert.throws(() => normalizeInputModalities(['image']), /must include text/);
  assert.throws(() => normalizeInputModalities(['text', 'audio']), /must contain only/);
  assert.throws(() => normalizeInputModalities([]), /non-empty array/);

  const normalized = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--gpt-4.1',
    providers: [{
      id: 'alpha',
      baseUrl: 'https://alpha.example/v1',
      models: [{
        id: 'gpt-4.1',
        upstreamModel: 'gpt-4.1',
        inputModalities: ['image', 'text'],
      }],
      keys: [{ name: 'one', key: 'sk-one' }],
    }],
  });
  assert.equal(normalized.providers[0].models[0].id, 'gpt-4.1');
  assert.deepEqual(normalized.providers[0].models[0].inputModalities, ['text', 'image']);
  assert.deepEqual(
    serializableConfig(normalized).providers[0].models[0].inputModalities,
    ['text', 'image'],
  );
});

test('model identifiers preserve common upstream punctuation without weakening provider ids', () => {
  assert.equal(normalizeModelIdentifier('GPT-4.1'), 'gpt-4.1');
  assert.equal(normalizeModelIdentifier('Claude/3.5-Sonnet'), 'claude/3.5-sonnet');
  assert.equal(normalizeModelIdentifier('llama3.1:8b_instruct+fast'), 'llama3.1:8b_instruct+fast');
  assert.throws(() => normalizeModelIdentifier('gpt--4.1'), /reserved separator/);
  assert.throws(() => normalizeModelIdentifier('gpt 4.1'), /must use letters/);
  assert.throws(() => normalizeModelIdentifier('.gpt-4.1'), /must use letters/);
});

test('config validation rejects duplicate key secrets', () => {
  assert.throws(() => normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      id: 'alpha',
      name: 'Alpha',
      baseUrl: 'https://alpha.example/v1',
      enabled: true,
      models: [{ id: 'chat', name: 'Chat', upstreamModel: 'chat' }],
      keys: [
        { name: 'one', key: 'sk-same', weight: 1 },
        { name: 'two', key: 'sk-same', weight: 1 },
      ],
    }],
  }), /duplicate key secret/);
});

test('config validation rejects providers with every key disabled', () => {
  assert.throws(() => normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      id: 'alpha',
      name: 'Alpha',
      baseUrl: 'https://alpha.example/v1',
      enabled: true,
      models: [{ id: 'chat', name: 'Chat', upstreamModel: 'chat' }],
      keys: [{ name: 'one', key: 'sk-one', weight: 1, enabled: false }],
    }],
  }), /at least one enabled key/);
});

test('provider balance query normalizes and persists JavaScript settings', () => {
  const query = normalizeBalanceQuery({
    enabled: true,
    code: '({ request: {}, extractor: function () { return { remaining: 1 }; } })',
    timeoutMs: 5000,
    refreshMs: 60000,
  });
  assert.deepEqual(query, {
    enabled: true,
    language: 'javascript',
    code: '({ request: {}, extractor: function () { return { remaining: 1 }; } })',
    timeoutMs: 5000,
    refreshMs: 60000,
  });

  const normalized = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      id: 'alpha',
      baseUrl: 'https://alpha.example/v1',
      models: [{ id: 'chat', upstreamModel: 'chat' }],
      keys: [{ name: 'one', key: 'sk-one' }],
      balanceQuery: query,
    }],
  });
  assert.deepEqual(serializableConfig(normalized).providers[0].balanceQuery, query);
});

test('provider balance query rejects unsafe configuration values', () => {
  assert.throws(() => normalizeBalanceQuery({ enabled: true, code: '' }), /code is required/);
  assert.throws(() => normalizeBalanceQuery({
    enabled: true,
    language: 'python',
    code: '({})',
  }), /language must be javascript/);
  assert.throws(() => normalizeBalanceQuery({
    enabled: true,
    code: '({})',
    timeoutMs: 31000,
  }), /timeoutMs/);
  assert.deepEqual(normalizeBalanceQuery({ enabled: false, code: '' }), {
    enabled: false,
    language: 'javascript',
    code: '',
    timeoutMs: 10000,
  });
});

test('explicit setup config normalizes only when setup mode is allowed', () => {
  const input = {
    schemaVersion: 2,
    setupPending: true,
    port: 8787,
    providers: [],
    defaultProvider: '',
    defaultModel: '',
  };

  assert.throws(() => normalizeConfig(input), /setup is incomplete/);
  const normalized = normalizeConfig(input, { allowSetup: true });
  const stored = serializableConfig(normalized);
  assert.equal(stored.setupPending, true);
  assert.deepEqual(stored.providers, []);
  assert.equal(stored.defaultProvider, '');
  assert.equal(stored.defaultModel, '');
});

test('setup config rejects partial provider state', () => {
  assert.throws(() => normalizeConfig({
    schemaVersion: 2,
    setupPending: true,
    defaultProvider: 'alpha',
    defaultModel: '',
    providers: [],
  }, { allowSetup: true }), /must not define defaultProvider/);
});

test('setup config requires authentication on non-loopback hosts', () => {
  for (const host of ['0.0.0.0', '127.999.0.1']) {
    assert.throws(() => normalizeConfig({
      schemaVersion: 2,
      setupPending: true,
      host,
      token: '',
      defaultProvider: '',
      defaultModel: '',
      providers: [],
    }, { allowSetup: true }), /requires a gateway token/);
  }
});
