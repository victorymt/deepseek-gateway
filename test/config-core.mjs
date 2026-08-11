import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  codexModelAlias,
  normalizeBalanceQuery,
  normalizeConfig,
  normalizeInputModalities,
  normalizeModelIdentifier,
  normalizeProvider,
  normalizeUpstreamFormat,
  persistConfig,
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

test('future config schema versions fail closed', () => {
  assert.throws(
    () => normalizeConfig({ schemaVersion: 3, providers: [] }),
    /unsupported config schemaVersion: 3/,
  );
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

test('masked provider keys can be renamed without resending the secret', () => {
  const existing = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      id: 'alpha',
      baseUrl: 'https://alpha.example/v1',
      models: [{ id: 'chat', upstreamModel: 'chat' }],
      keys: [{ name: 'primary', key: 'sk-primary' }],
    }],
  }).providers[0];
  const renamed = normalizeProvider({
    ...existing,
    keys: [{
      name: 'renamed',
      originalName: existing.keys[0].name,
      key: '',
      weight: 1,
    }],
  }, existing);
  assert.equal(renamed.keys[0].name, 'renamed');
  assert.equal(renamed.keys[0].key, existing.keys[0].key);

  assert.throws(() => normalizeProvider({
    ...existing,
    baseUrl: 'https://other.example/v1',
    keys: [{
      name: 'primary',
      originalName: 'primary',
      key: '',
      weight: 1,
    }],
  }, existing), /secret is required/);
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

test('encrypted agent message passthrough is explicit and limited to Responses providers', () => {
  const baseProvider = {
    id: 'alpha',
    baseUrl: 'https://alpha.example/v1',
    models: [{ id: 'chat', upstreamModel: 'chat' }],
    keys: [{ name: 'one', key: 'sk-one' }],
  };
  const defaults = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [baseProvider],
  });
  assert.equal(defaults.providers[0].supportsEncryptedAgentMessages, false);
  assert.equal(
    serializableConfig(defaults).providers[0].supportsEncryptedAgentMessages,
    undefined,
  );

  const passthrough = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{ ...baseProvider, supportsEncryptedAgentMessages: true }],
  });
  assert.equal(passthrough.providers[0].supportsEncryptedAgentMessages, true);
  assert.equal(
    serializableConfig(passthrough).providers[0].supportsEncryptedAgentMessages,
    true,
  );

  assert.throws(() => normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      ...baseProvider,
      upstreamFormat: 'chat-completions',
      supportsEncryptedAgentMessages: true,
    }],
  }), /requires responses upstreamFormat/);

  assert.throws(() => normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{ ...baseProvider, supportsEncryptedAgentMessages: 'true' }],
  }), /must be a boolean/);
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

test('hosted web search is explicit, persisted, and limited to Responses providers', () => {
  const baseProvider = {
    id: 'alpha',
    baseUrl: 'https://alpha.example/v1',
    models: [{ id: 'chat', upstreamModel: 'chat' }],
    keys: [{ name: 'one', key: 'sk-one' }],
  };
  const defaults = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [baseProvider],
  });
  assert.equal(
    defaults.providers[0].models[0].supportsHostedWebSearch,
    false,
  );
  assert.equal(
    serializableConfig(defaults)
      .providers[0]
      .models[0]
      .supportsHostedWebSearch,
    undefined,
  );

  const enabled = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      ...baseProvider,
      models: [{
        id: 'chat',
        upstreamModel: 'chat',
        supportsHostedWebSearch: true,
      }],
    }],
  });
  assert.equal(
    serializableConfig(enabled)
      .providers[0]
      .models[0]
      .supportsHostedWebSearch,
    true,
  );

  assert.throws(() => normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      ...baseProvider,
      upstreamFormat: 'chat-completions',
      models: [{
        id: 'chat',
        upstreamModel: 'chat',
        supportsHostedWebSearch: true,
      }],
    }],
  }), /requires responses upstreamFormat/);

  assert.throws(() => normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      ...baseProvider,
      models: [{
        id: 'chat',
        upstreamModel: 'chat',
        supportsHostedWebSearch: 'true',
      }],
    }],
  }), /must be a boolean/);
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

test('completed config requires authentication on non-loopback hosts', () => {
  const config = {
    host: '0.0.0.0',
    token: '',
    upstream: 'https://api.deepseek.com',
    keys: [{ name: 'primary', key: 'sk-primary' }],
  };
  assert.throws(() => normalizeConfig(config), /non-loopback host requires/);

  config.token = 'long-enough-token';
  config.adminToken = 'different-admin-token';
  assert.equal(normalizeConfig(config).host, '0.0.0.0');
});

test('gateway and management authentication require distinct tokens', () => {
  const config = {
    token: 'gateway-token-1234',
    upstream: 'https://api.deepseek.com',
    keys: [{ name: 'primary', key: 'sk-primary' }],
  };
  assert.throws(() => normalizeConfig(config), /separate adminToken/);
  config.adminToken = config.token;
  assert.throws(() => normalizeConfig(config), /must be different/);
  config.adminToken = 'admin-token-567890';
  assert.equal(normalizeConfig(config).adminToken, config.adminToken);
});

test('management authentication rejects short non-empty admin tokens without gateway auth', () => {
  const config = {
    token: '',
    adminToken: 'short',
    upstream: 'https://api.deepseek.com',
    keys: [{ name: 'primary', key: 'sk-primary' }],
  };
  assert.throws(() => normalizeConfig(config), /adminToken must be at least 16 characters/);

  config.adminToken = 'admin-token-1234';
  assert.equal(normalizeConfig(config).adminToken, config.adminToken);
});

test('persistConfig does not fail after rename on a redundant target chmod', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-config-'));
  const target = path.join(directory, 'keys.json');
  const config = normalizeConfig({
    schemaVersion: 2,
    setupPending: true,
    defaultProvider: '',
    defaultModel: '',
    providers: [],
  }, { allowSetup: true });
  const chmodSync = fs.chmodSync;
  fs.chmodSync = (file, mode) => {
    if (path.resolve(file) === path.resolve(target)) {
      throw new Error('target chmod must not run after rename');
    }
    return chmodSync(file, mode);
  };
  try {
    persistConfig(target, config);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).setupPending, true);
  } finally {
    fs.chmodSync = chmodSync;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
