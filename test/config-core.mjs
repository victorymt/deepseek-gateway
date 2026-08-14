import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  codexModelAlias,
  normalizeApiProfile,
  normalizeBalanceQuery,
  normalizeConfig,
  normalizeInputModalities,
  normalizeKeyRouting,
  normalizeModelIdentifier,
  normalizeProvider,
  normalizeReasoningConfig,
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
  assert.equal(stored.providers[0].models[0].reasoning.default, 'high');
  assert.deepEqual(
    stored.providers[0].models[0].reasoning.levels.map(level => level.effort),
    ['low', 'high', 'max'],
  );
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

test('provider key routing defaults to balanced and persists affinity explicitly', () => {
  assert.equal(normalizeKeyRouting(undefined), 'balanced');
  assert.equal(normalizeKeyRouting('prompt-cache-affinity'), 'prompt-cache-affinity');
  assert.throws(() => normalizeKeyRouting('sticky'), /must be one of/);

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
  assert.equal(defaults.providers[0].keyRouting, 'balanced');
  assert.equal(serializableConfig(defaults).providers[0].keyRouting, undefined);

  const affinity = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{ ...baseProvider, keyRouting: 'prompt-cache-affinity' }],
  });
  assert.equal(affinity.providers[0].keyRouting, 'prompt-cache-affinity');
  assert.equal(
    serializableConfig(affinity).providers[0].keyRouting,
    'prompt-cache-affinity',
  );
  assert.equal(normalizeProvider({ name: 'Renamed' }, affinity.providers[0]).keyRouting, 'prompt-cache-affinity');
});

test('provider API profile validates and legacy official DeepSeek configs are inferred once', () => {
  assert.equal(normalizeApiProfile(undefined), 'generic');
  assert.equal(normalizeApiProfile('DeepSeek'), 'deepseek');
  assert.throws(() => normalizeApiProfile('openai'), /must be one of/);

  const normalized = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek--flash',
    providers: [{
      id: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      upstreamFormat: 'responses',
      models: [{ id: 'flash', upstreamModel: 'deepseek-v4-flash' }],
      keys: [{ name: 'one', key: 'sk-one' }],
    }],
  });
  const provider = normalized.providers[0];
  const stored = serializableConfig(normalized).providers[0];

  assert.equal(provider.apiProfile, 'deepseek');
  assert.equal(provider.models[0].supportsHostedWebSearch, true);
  assert.equal(provider.models[0].supportsCustomApplyPatch, true);
  assert.equal(stored.apiProfile, 'deepseek');
  assert.equal(stored.models[0].supportsHostedWebSearch, true);
  assert.equal(stored.models[0].supportsCustomApplyPatch, true);
});

test('DeepSeek tool defaults require the profile and explicit false remains an opt-out', () => {
  const provider = ({ id, baseUrl, apiProfile, model = {} }) => ({
    id,
    baseUrl,
    ...(apiProfile ? { apiProfile } : {}),
    models: [{ id: 'flash', upstreamModel: 'deepseek-v4-flash', ...model }],
    keys: [{ name: 'one', key: `sk-${id}` }],
  });
  const generic = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--flash',
    providers: [provider({
      id: 'alpha',
      baseUrl: 'https://relay.example/v1',
    })],
  }).providers[0];
  assert.equal(generic.apiProfile, 'generic');
  assert.equal(generic.models[0].supportsHostedWebSearch, false);
  assert.equal(generic.models[0].supportsCustomApplyPatch, false);

  const optedOut = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek--flash',
    providers: [provider({
      id: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiProfile: 'deepseek',
      model: {
        supportsHostedWebSearch: false,
        supportsCustomApplyPatch: false,
      },
    })],
  });
  const stored = serializableConfig(optedOut);
  assert.equal(stored.providers[0].models[0].supportsHostedWebSearch, false);
  assert.equal(stored.providers[0].models[0].supportsCustomApplyPatch, false);
  assert.equal(
    normalizeConfig(stored).providers[0].models[0].supportsCustomApplyPatch,
    false,
  );
});

test('native Responses model catalog overrides normalize and serialize', () => {
  const normalized = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      id: 'alpha',
      baseUrl: 'https://alpha.example/v1',
      models: [{
        id: 'chat',
        upstreamModel: 'chat',
        contextWindow: 262144,
        supportsParallelToolCalls: false,
        baseInstructions: '  Use the upstream coding harness.  ',
      }],
      keys: [{ name: 'one', key: 'sk-one' }],
    }],
  });
  const model = normalized.providers[0].models[0];
  const storedModel = serializableConfig(normalized).providers[0].models[0];

  assert.equal(model.contextWindow, 262144);
  assert.equal(model.supportsParallelToolCalls, false);
  assert.equal(model.baseInstructions, 'Use the upstream coding harness.');
  assert.equal(storedModel.contextWindow, 262144);
  assert.equal(storedModel.supportsParallelToolCalls, false);
  assert.equal(storedModel.baseInstructions, 'Use the upstream coding harness.');
});

test('native Responses model catalog overrides reject invalid values', () => {
  const configWithModel = model => ({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      id: 'alpha',
      baseUrl: 'https://alpha.example/v1',
      models: [{ id: 'chat', upstreamModel: 'chat', ...model }],
      keys: [{ name: 'one', key: 'sk-one' }],
    }],
  });

  assert.throws(
    () => normalizeConfig(configWithModel({ contextWindow: 0 })),
    /contextWindow must be an integer between 1/,
  );
  assert.throws(
    () => normalizeConfig(configWithModel({ contextWindow: null })),
    /contextWindow must be an integer between 1/,
  );
  assert.throws(
    () => normalizeConfig(configWithModel({ contextWindow: 1.5 })),
    /contextWindow must be an integer between 1/,
  );
  assert.throws(
    () => normalizeConfig(configWithModel({ supportsParallelToolCalls: 'false' })),
    /supportsParallelToolCalls must be a boolean/,
  );
  assert.throws(
    () => normalizeConfig(configWithModel({ baseInstructions: '   ' })),
    /baseInstructions must not be empty/,
  );
  assert.throws(
    () => normalizeConfig(configWithModel({ baseInstructions: 'x'.repeat(65537) })),
    /baseInstructions must be at most 65536 characters/,
  );
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

test('prompt cache key forwarding is explicit and limited to Chat Completions providers', () => {
  const baseProvider = {
    id: 'alpha',
    baseUrl: 'https://alpha.example/v1',
    upstreamFormat: 'chat-completions',
    models: [{ id: 'chat', upstreamModel: 'chat' }],
    keys: [{ name: 'one', key: 'sk-one' }],
  };
  const defaults = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [baseProvider],
  });
  assert.equal(defaults.providers[0].supportsPromptCacheKey, false);
  assert.equal(serializableConfig(defaults).providers[0].supportsPromptCacheKey, undefined);

  const enabled = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{ ...baseProvider, supportsPromptCacheKey: true }],
  });
  assert.equal(enabled.providers[0].supportsPromptCacheKey, true);
  assert.equal(serializableConfig(enabled).providers[0].supportsPromptCacheKey, true);

  assert.throws(() => normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{ ...baseProvider, upstreamFormat: 'responses', supportsPromptCacheKey: true }],
  }), /requires chat-completions upstreamFormat/);
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
      upstreamFormat: 'chat-completions',
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

test('missing model input modalities are inferred from the capability registry', () => {
  const normalizeModel = upstreamModel => normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--model',
    providers: [{
      id: 'alpha',
      baseUrl: 'https://alpha.example/v1',
      models: [{ id: 'model', upstreamModel }],
      keys: [{ name: 'one', key: 'sk-one' }],
    }],
  }).providers[0].models[0];

  assert.deepEqual(normalizeModel('deepseek-v4-pro').inputModalities, ['text']);
  assert.deepEqual(normalizeModel('glm-5.2v').inputModalities, ['text', 'image']);
  assert.deepEqual(normalizeModel('future-vision-model').inputModalities, ['text', 'image']);
});

test('missing model reasoning is inferred from the capability registry and persisted', () => {
  const normalized = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--reasoner',
    providers: [{
      id: 'alpha',
      baseUrl: 'https://alpha.example/v1',
      models: [{ id: 'reasoner', upstreamModel: 'deepseek-v4-pro' }],
      keys: [{ name: 'one', key: 'sk-one' }],
    }],
  });
  const expected = {
    parameter: 'reasoning_effort',
    default: 'high',
    levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'high', description: 'Extra high reasoning depth for complex problems' },
      { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
    ],
  };

  assert.deepEqual(normalized.providers[0].models[0].reasoning, expected);
  assert.deepEqual(
    serializableConfig(normalized).providers[0].models[0].reasoning,
    expected,
  );
});

test('explicit model reasoning overrides catalog defaults and null persists as opt-out', () => {
  const base = {
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--reasoner',
    providers: [{
      id: 'alpha',
      baseUrl: 'https://alpha.example/v1',
      models: [{
        id: 'reasoner',
        upstreamModel: 'deepseek-v4-pro',
        reasoning: {
          parameter: 'reasoning_effort',
          default: 'medium',
          levels: ['medium', 'high'],
        },
      }],
      keys: [{ name: 'one', key: 'sk-one' }],
    }],
  };
  const customized = normalizeConfig(base);
  assert.deepEqual(customized.providers[0].models[0].reasoning, {
    parameter: 'reasoning_effort',
    default: 'medium',
    levels: [{ effort: 'medium' }, { effort: 'high' }],
  });

  base.providers[0].models[0].reasoning = null;
  const disabled = normalizeConfig(base);
  assert.equal(disabled.providers[0].models[0].reasoning, null);
  const stored = serializableConfig(disabled);
  assert.equal(stored.providers[0].models[0].reasoning, null);
  assert.equal(
    normalizeConfig(stored).providers[0].models[0].reasoning,
    null,
  );
});

test('reasoning capability normalizes, validates, and persists per-model mappings', () => {
  const reasoning = normalizeReasoningConfig({
    parameter: 'thinking_budget',
    default: 'high',
    levels: [
      { effort: 'low', description: 'Shorter reasoning', upstreamValue: 1024 },
      { effort: 'high', description: 'Deeper reasoning', upstreamValue: 8192 },
    ],
  });
  assert.deepEqual(reasoning, {
    parameter: 'thinking_budget',
    default: 'high',
    levels: [
      { effort: 'low', description: 'Shorter reasoning', upstreamValue: 1024 },
      { effort: 'high', description: 'Deeper reasoning', upstreamValue: 8192 },
    ],
  });

  const normalized = normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--reasoner',
    providers: [{
      id: 'alpha',
      baseUrl: 'https://alpha.example/v1',
      upstreamFormat: 'chat-completions',
      models: [{
        id: 'reasoner',
        upstreamModel: 'reasoner',
        reasoning,
      }],
      keys: [{ name: 'one', key: 'sk-one' }],
    }],
  });
  assert.deepEqual(
    serializableConfig(normalized).providers[0].models[0].reasoning,
    reasoning,
  );
  assert.throws(
    () => normalizeReasoningConfig({ levels: ['low', 'low'] }),
    /duplicate effort/,
  );
  assert.throws(
    () => normalizeReasoningConfig({ parameter: 'temperature', levels: ['low'] }),
    /parameter must be one of/,
  );
  assert.throws(
    () => normalizeReasoningConfig({ default: 'max', levels: ['low'] }),
    /default must reference/,
  );
  assert.throws(() => normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--reasoner',
    providers: [{
      id: 'alpha',
      baseUrl: 'https://alpha.example/v1',
      upstreamFormat: 'responses',
      models: [{
        id: 'reasoner',
        upstreamModel: 'reasoner',
        reasoning: {
          parameter: 'thinking_budget',
          levels: [{ effort: 'high', upstreamValue: 8192 }],
        },
      }],
      keys: [{ name: 'one', key: 'sk-one' }],
    }],
  }), /custom reasoning parameters require a chat-completions upstream/);
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
    false,
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
        supportsCustomApplyPatch: true,
      }],
    }],
  }), /supportsCustomApplyPatch requires responses upstreamFormat/);

  assert.throws(() => normalizeConfig({
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      ...baseProvider,
      models: [{
        id: 'chat',
        upstreamModel: 'chat',
        supportsCustomApplyPatch: 'true',
      }],
    }],
  }), /supportsCustomApplyPatch must be a boolean/);
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
