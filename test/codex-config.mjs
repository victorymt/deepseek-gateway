import { test } from 'node:test';
import assert from 'node:assert';

import { buildCodexArtifacts, buildModelCatalog } from '../codex-config.mjs';

function config(
  upstreamFormat,
  supportsHostedWebSearch = false,
  upstreamModel = 'unknown-model',
  reasoning,
) {
  return {
    schemaVersion: 2,
    defaultProvider: 'alpha',
    defaultModel: 'alpha--chat',
    providers: [{
      id: 'alpha',
      name: 'Alpha',
      baseUrl: 'https://alpha.example/v1',
      upstreamFormat,
      enabled: true,
      models: [{
        id: 'chat',
        name: 'Chat',
        upstreamModel,
        inputModalities: ['text'],
        supportsHostedWebSearch,
        ...(reasoning === undefined ? {} : { reasoning }),
      }],
      keys: [{ name: 'one', key: 'sk-one', weight: 1 }],
    }],
  };
}

test('Chat Completions catalog entries do not advertise hosted web search', () => {
  const model = buildModelCatalog(
    config('chat-completions'),
  ).models[0];

  assert.equal(model.web_search_tool_type, undefined);
  assert.equal(model.supports_search_tool, false);
  assert.equal(model.shell_type, 'shell_command');
  assert.equal(model.apply_patch_tool_type, 'freeform');
  assert.ok(model.base_instructions);
  assert.ok(model.model_messages?.instructions_template);
  assert.equal(model.supports_reasoning_summaries, false);
});

test('Responses catalog entries default hosted web search to disabled', () => {
  const model = buildModelCatalog(config('responses')).models[0];

  assert.equal(model.web_search_tool_type, undefined);
  assert.equal(model.supports_search_tool, false);
  assert.equal(model.context_window, 128000);
  assert.equal(model.max_context_window, 128000);
  assert.equal(model.effective_context_window_percent, 95);
  assert.equal(model.supports_parallel_tool_calls, false);
  assert.deepEqual(model.truncation_policy, { mode: 'bytes', limit: 10000 });
  assert.deepEqual(model.supported_reasoning_levels, [
    { effort: 'none', description: 'Disable Thinking' },
    { effort: 'high', description: 'Enabled Thinking' },
  ]);
  assert.equal(model.default_reasoning_level, 'high');
  assert.equal(model.supports_reasoning_summaries, true);
  assert.equal(model.default_reasoning_summary, 'none');
  assert.deepEqual(model.additional_speed_tiers, []);
  assert.deepEqual(model.service_tiers, []);
  assert.equal(model.availability_nux, null);
  assert.equal(model.upgrade, null);
  assert.equal(model.model_messages, undefined);
  assert.equal(model.shell_type, 'shell_command');
  assert.equal(model.apply_patch_tool_type, undefined);
  assert.ok(model.base_instructions);
});

test('generic native Responses applies model-level catalog overrides', () => {
  const generic = config('responses');
  Object.assign(generic.providers[0].models[0], {
    contextWindow: 262144,
    supportsParallelToolCalls: true,
    baseInstructions: 'Use the vendor-native coding workflow.',
  });

  const model = buildModelCatalog(generic).models[0];

  assert.equal(model.context_window, 262144);
  assert.equal(model.max_context_window, 262144);
  assert.equal(model.supports_parallel_tool_calls, true);
  assert.equal(model.base_instructions, 'Use the vendor-native coding workflow.');
});

test('Responses catalog entries opt into the template hosted web search type', () => {
  const model = buildModelCatalog(
    config('responses', true),
  ).models[0];

  assert.equal(model.web_search_tool_type, 'text');
  assert.equal(model.supports_search_tool, false);
});

test('official DeepSeek Responses defaults to hosted search and custom apply_patch', () => {
  const deepseek = config('responses', false, 'deepseek-v4-flash');
  deepseek.defaultProvider = 'deepseek';
  deepseek.defaultModel = 'deepseek--chat';
  Object.assign(deepseek.providers[0], {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
  });
  delete deepseek.providers[0].models[0].supportsHostedWebSearch;
  Object.assign(deepseek.providers[0].models[0], {
    contextWindow: 12345,
    supportsParallelToolCalls: false,
    baseInstructions: 'This must not replace the official harness.',
  });

  const model = buildModelCatalog(deepseek).models[0];

  assert.equal(model.web_search_tool_type, 'text');
  assert.equal(model.apply_patch_tool_type, 'freeform');
  assert.equal(model.shell_type, 'shell_command');
  assert.equal(model.context_window, 1048576);
  assert.notEqual(model.base_instructions, 'This must not replace the official harness.');
  assert.ok(model.base_instructions.length > 10000);
  assert.ok(model.model_messages?.instructions_template);
});

test('DeepSeek profile on a relay does not claim the official Responses harness', () => {
  const relay = config('responses', false, 'deepseek-v4-flash');
  relay.providers[0].apiProfile = 'deepseek';

  const model = buildModelCatalog(relay).models[0];

  assert.equal(model.model_messages, undefined);
  assert.equal(model.context_window, 128000);
  assert.doesNotMatch(model.base_instructions, /apply_patch/);
});

test('generic native Responses only exposes custom apply_patch when enabled', () => {
  const generic = config('responses');
  generic.providers[0].models[0].supportsCustomApplyPatch = true;

  const model = buildModelCatalog(generic).models[0];

  assert.equal(model.apply_patch_tool_type, 'freeform');
  assert.equal(model.web_search_tool_type, undefined);
});

test('model reasoning capabilities override neutral and matched catalog profiles', () => {
  const reasoning = {
    parameter: 'thinking_budget',
    default: 'high',
    levels: [
      { effort: 'low', description: 'Fast', upstreamValue: 1024 },
      { effort: 'high', description: 'Deep', upstreamValue: 8192 },
    ],
  };
  for (const upstreamModel of ['unknown-model', 'deepseek-v4-flash']) {
    const model = buildModelCatalog(
      config('chat-completions', false, upstreamModel, reasoning),
    ).models[0];
    assert.deepEqual(model.supported_reasoning_levels, [
      { effort: 'low', description: 'Fast' },
      { effort: 'high', description: 'Deep' },
    ]);
    assert.equal(model.default_reasoning_level, 'high');
  }
});

test('models with reasoning explicitly disabled clear levels inherited from matched templates', () => {
  for (const upstreamFormat of ['responses', 'chat-completions']) {
    const model = buildModelCatalog(
      config(upstreamFormat, false, 'deepseek-v4-flash', null),
    ).models[0];
    assert.deepEqual(model.supported_reasoning_levels, []);
    assert.equal(model.default_reasoning_level, undefined);
    assert.equal(model.supports_reasoning_summaries, false);
    assert.equal(model.default_reasoning_summary, undefined);
  }
});

test('known templates keep proxy tools but strip them for generic native Responses', () => {
  const proxyConfig = config('chat-completions', false, 'deepseek-v4-flash');
  Object.assign(proxyConfig.providers[0].models[0], {
    contextWindow: 12345,
    supportsParallelToolCalls: false,
    baseInstructions: 'This must not replace the proxy harness.',
  });
  const proxyChat = buildModelCatalog(proxyConfig).models[0];
  const nativeResponses = buildModelCatalog(
    config('responses', false, 'deepseek-v4-flash'),
  ).models[0];

  assert.equal(proxyChat.apply_patch_tool_type, 'freeform');
  assert.ok(proxyChat.model_messages?.instructions_template);
  assert.equal(proxyChat.context_window, 1048576);
  assert.notEqual(proxyChat.base_instructions, 'This must not replace the proxy harness.');
  assert.equal(nativeResponses.apply_patch_tool_type, undefined);
  assert.equal(nativeResponses.model_messages, undefined);
  assert.equal(nativeResponses.context_window, 128000);
  assert.ok(nativeResponses.base_instructions);
  assert.doesNotMatch(nativeResponses.base_instructions, /apply_patch/);
  assert.equal(nativeResponses.shell_type, 'shell_command');
});

test('both upstream formats keep Codex on the local Responses route', () => {
  const proxyChat = buildCodexArtifacts(config('chat-completions'), {
    modelsPath: '/tmp/gateway-models.json',
  });
  const nativeResponses = buildCodexArtifacts(config('responses'), {
    modelsPath: '/tmp/gateway-models.json',
  });

  for (const artifacts of [proxyChat, nativeResponses]) {
    assert.match(artifacts.configToml, /wire_api = "responses"/);
  }
  assert.equal(proxyChat.catalog.models[0].apply_patch_tool_type, 'freeform');
  assert.equal(nativeResponses.catalog.models[0].apply_patch_tool_type, undefined);
});

test('Codex artifact revision is stable and changes with generated content', () => {
  const base = config('responses');
  const first = buildCodexArtifacts(base, {
    gatewayUrl: 'http://127.0.0.1:8787',
    modelsPath: '/tmp/gateway-models.json',
  });
  const repeated = buildCodexArtifacts(structuredClone(base), {
    gatewayUrl: 'http://127.0.0.1:8787',
    modelsPath: '/tmp/gateway-models.json',
  });
  const changed = buildCodexArtifacts(base, {
    gatewayUrl: 'http://127.0.0.1:9999',
    modelsPath: '/tmp/gateway-models.json',
  });

  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.equal(first.revision, repeated.revision);
  assert.notEqual(first.revision, changed.revision);
  assert.equal(first.configToml, repeated.configToml);
  assert.equal(first.catalogJson, repeated.catalogJson);
});

test('native subagents are not exposed as model catalog aliases', () => {
  const base = config('chat-completions');
  const artifacts = buildCodexArtifacts(base, {
    modelsPath: '/tmp/gateway-models.json',
    subagents: [{
      id: 'coder',
      name: 'Code Reviewer',
      providerId: 'alpha',
      model: 'alpha--chat',
      instructions: 'Review carefully.',
      enabled: true,
    }, {
      id: 'disabled',
      name: 'Disabled',
      providerId: 'alpha',
      model: 'alpha--chat',
      enabled: false,
    }],
  });
  assert.deepEqual(artifacts.catalog.models.map(model => model.slug), ['Alpha.chat']);
  assert.equal(artifacts.catalogJson.includes('agent--'), false);
});

test('catalog uses inferred modalities when provider config omits them', () => {
  const textOnly = config('responses', false, 'deepseek-v4-pro');
  const unknown = config('responses', false, 'future-vision-model');
  delete textOnly.providers[0].models[0].inputModalities;
  delete unknown.providers[0].models[0].inputModalities;

  assert.deepEqual(buildModelCatalog(textOnly).models[0].input_modalities, ['text']);
  assert.deepEqual(
    buildModelCatalog(unknown).models[0].input_modalities,
    ['text', 'image'],
  );
});
