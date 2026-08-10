import { test } from 'node:test';
import assert from 'node:assert';

import {
  normalizeBalanceQuery,
  normalizeConfig,
  normalizeUpstreamFormat,
  serializableConfig,
} from '../config-core.mjs';

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
  assert.equal(stored.providers[0].keys[0].key, 'sk-legacy');
  assert.equal(stored.providers[0].keys[0].enabled, true);
  assert.deepEqual(stored.customField, { keep: true });
  assert.equal(stored.upstream, undefined);
  assert.equal(stored.keys, undefined);
  assert.equal(stored.breakerThreshold, undefined);
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
