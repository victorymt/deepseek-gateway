import { test } from 'node:test';
import assert from 'node:assert';

import { buildModelCatalog } from '../codex-config.mjs';

function config(upstreamFormat, supportsHostedWebSearch = false) {
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
        upstreamModel: 'unknown-model',
        inputModalities: ['text'],
        supportsHostedWebSearch,
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
});

test('Responses catalog entries default hosted web search to disabled', () => {
  const model = buildModelCatalog(config('responses')).models[0];

  assert.equal(model.web_search_tool_type, undefined);
  assert.equal(model.supports_search_tool, false);
  assert.equal(model.context_window, 32768);
  assert.equal(model.supports_parallel_tool_calls, false);
  assert.equal(model.model_messages, undefined);
});

test('Responses catalog entries opt into the template hosted web search type', () => {
  const model = buildModelCatalog(
    config('responses', true),
  ).models[0];

  assert.equal(model.web_search_tool_type, 'text');
  assert.equal(model.supports_search_tool, false);
});
