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
  assert.equal(model.context_window, 32768);
  assert.equal(model.supports_parallel_tool_calls, false);
  assert.equal(model.model_messages, undefined);
  assert.equal(model.shell_type, 'shell_command');
  assert.equal(model.apply_patch_tool_type, undefined);
  assert.ok(model.base_instructions);
  assert.equal(model.supports_reasoning_summaries, false);
});

test('Responses catalog entries opt into the template hosted web search type', () => {
  const model = buildModelCatalog(
    config('responses', true),
  ).models[0];

  assert.equal(model.web_search_tool_type, 'text');
  assert.equal(model.supports_search_tool, false);
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
  }
});

test('known templates keep proxy tools but strip them for native Responses', () => {
  const proxyChat = buildModelCatalog(
    config('chat-completions', false, 'deepseek-v4-flash'),
  ).models[0];
  const nativeResponses = buildModelCatalog(
    config('responses', false, 'deepseek-v4-flash'),
  ).models[0];

  assert.equal(proxyChat.apply_patch_tool_type, 'freeform');
  assert.ok(proxyChat.model_messages?.instructions_template);
  assert.equal(nativeResponses.apply_patch_tool_type, undefined);
  assert.equal(nativeResponses.model_messages, undefined);
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
