import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  freePort,
  multiProviderConfig,
  startGateway,
} from './helpers/gateway-harness.mjs';

test('native Responses forwards image input while Chat Completions validates it', async () => {
  const textOnlyConfig = multiProviderConfig({
    providers: [{
      id: 'alpha',
      name: 'Alpha',
      baseUrl: 'https://alpha.example',
      enabled: true,
      models: [{
        id: 'text-only',
        name: 'Text Only',
        upstreamModel: 'text-only-upstream',
        inputModalities: ['text'],
      }],
      keys: [{ name: 'alpha-key', key: 'sk-alpha-ok', weight: 1 }],
    }],
    defaultProvider: 'alpha',
    defaultModel: 'alpha--text-only',
  });
  const textOnly = await startGateway('', [], {}, textOnlyConfig, { keysArg: false });
  try {
    const forwarded = await textOnly.responses({
      model: 'alpha--text-only',
      input: [{
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }],
      }],
    });
    assert.equal(forwarded.status, 200, forwarded.text);
  } finally {
    await textOnly.stop();
  }

  const chatConfig = multiProviderConfig({
    providers: [{
      id: 'alpha',
      name: 'Alpha Chat',
      baseUrl: 'https://alpha.example',
      upstreamFormat: 'chat-completions',
      enabled: true,
      models: [{
        id: 'text-only',
        name: 'Text Only',
        upstreamModel: 'text-only-upstream',
        inputModalities: ['text'],
      }],
      keys: [{ name: 'alpha-key', key: 'sk-alpha-ok', weight: 1 }],
    }],
    defaultProvider: 'alpha',
    defaultModel: 'alpha--text-only',
  });
  const chatGateway = await startGateway('', [], {}, chatConfig, { keysArg: false });
  try {
    const rejected = await chatGateway.chat({
      model: 'alpha--text-only',
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
      }],
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.text, /does not support image input/);
  } finally {
    await chatGateway.stop();
  }
});

test('provider-scoped aliases route identical upstream model names without crossing pools', async () => {
  const gw = await startGateway('', [], {}, multiProviderConfig(), { keysArg: false });
  try {
    const alpha = await gw.chat({ model: 'alpha--shared' });
    assert.equal(alpha.status, 200);
    assert.equal(alpha.headers.get('x-gateway-provider'), 'alpha');
    assert.equal(alpha.headers.get('x-gateway-model'), 'alpha--shared');
    assert.equal(JSON.parse(alpha.text).gateway_key_name, 'alpha-key');
    assert.equal(JSON.parse(alpha.text).model, 'same-upstream-model');

    const beta = await gw.chat({ model: 'beta--shared' });
    assert.equal(beta.status, 200);
    assert.equal(beta.headers.get('x-gateway-provider'), 'beta');
    assert.equal(beta.headers.get('x-gateway-model'), 'beta--shared');
    assert.equal(JSON.parse(beta.text).gateway_key_name, 'beta-key');

    const h = await gw.health();
    assert.equal(h.providers.find(provider => provider.id === 'alpha').total.requests, 1);
    assert.equal(h.providers.find(provider => provider.id === 'beta').total.requests, 1);
    assert.equal(h.total.requests, 2);
  } finally {
    await gw.stop();
  }
});

test('Chat Completions providers adapt Responses JSON and SSE while direct Chat stays passthrough', async () => {
  const upstreamPort = await freePort();
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({
        url: req.url,
        body,
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
      });
      if (req.url === '/v1/chat/completions?trace=direct') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-direct',
          object: 'chat.completion',
          model: body.model,
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'direct' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      if (req.url !== '/v1/chat/completions?trace=adapted') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `unexpected path ${req.url}` } }));
        return;
      }
      if (!body.stream) {
        const responseBody = JSON.stringify({
          id: 'chatcmpl-json',
          object: 'chat.completion',
          created: 100,
          model: body.model,
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', reasoning_content: 'checked', content: 'adapted json' },
          }],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(responseBody),
          etag: 'upstream-chat-body',
        });
        res.end(responseBody);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const frames = [
        'data: {"id":"chatcmpl-sse","created":101,"model":"same-upstream-model","choices":[{"delta":{"content":"adapted "}}]}\n\n',
        'data: {"id":"chatcmpl-sse","model":"same-upstream-model","choices":[{"delta":{"content":"stream"},"finish_reason":"stop"}]}\n\n',
        'data: {"id":"chatcmpl-sse","model":"same-upstream-model","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        'data: [DONE]\n\n',
      ];
      res.write(frames[0].slice(0, 47));
      res.write(frames[0].slice(47) + frames[1]);
      res.end(frames[2] + frames[3]);
    });
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));

  const config = multiProviderConfig({
    defaultProvider: 'alpha',
    defaultModel: 'alpha--shared',
    providers: [{
      id: 'alpha',
      name: 'Alpha Chat',
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      upstreamFormat: 'chat-completions',
      supportsPromptCacheKey: true,
      enabled: true,
      models: [{
        id: 'shared',
        name: 'Shared',
        upstreamModel: 'same-upstream-model',
        reasoning: {
          parameter: 'thinking_budget',
          default: 'high',
          levels: [
            { effort: 'low', upstreamValue: 1024 },
            { effort: 'high', upstreamValue: 8192 },
          ],
        },
      }],
      keys: [{ name: 'alpha-key', key: 'sk-alpha', weight: 1, enabled: true }],
    }],
  });
  const gw = await startGateway('', [], {}, config, { mock: false, keysArg: false });
  try {
    const nonStream = await gw.responses({
      model: 'alpha--shared',
      instructions: 'Use tools carefully.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'inspect' }] }],
      reasoning: { effort: 'high' },
    }, { cookie: 'dsgw=must-not-reach-upstream' }, '?trace=adapted');
    assert.equal(nonStream.status, 200, nonStream.text);
    assert.equal(nonStream.headers.get('x-gateway-provider'), 'alpha');
    assert.equal(nonStream.headers.get('content-encoding'), null);
    assert.equal(nonStream.headers.get('etag'), null);
    const response = JSON.parse(nonStream.text);
    assert.equal(response.object, 'response');
    assert.deepEqual(response.output.map(item => item.type), ['reasoning', 'message']);
    assert.equal(response.output[1].content[0].text, 'adapted json');
    assert.equal(response.usage.total_tokens, 7);
    assert.equal((await gw.health()).providers[0].upstreamFormat, 'chat-completions');

    assert.equal(requests[0].url, '/v1/chat/completions?trace=adapted');
    assert.equal(requests[0].body.model, 'same-upstream-model');
    assert.equal(requests[0].body.thinking_budget, 8192);
    assert.equal(requests[0].body.reasoning_effort, undefined);
    assert.deepEqual(requests[0].body.messages.map(message => message.role), ['system', 'user']);
    assert.equal(requests[0].cookie, undefined);

    const compact = await fetch(`${gw.base}/v1/responses/compact?trace=adapted`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'alpha--shared',
        input: 'compact',
        prompt_cache_key: 'stable-project-session',
      }),
    });
    assert.equal(compact.status, 200, await compact.clone().text());
    assert.equal((await compact.json()).object, 'response');
    assert.equal(requests.at(-1).url, '/v1/chat/completions?trace=adapted');
    assert.equal(requests.at(-1).body.prompt_cache_key, 'stable-project-session');

    const stream = await gw.responses({ model: 'alpha--shared', input: 'stream', stream: true }, {}, '?trace=adapted');
    assert.equal(stream.status, 200, stream.text);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    assert.match(stream.text, /"type":"response\.output_text\.delta"/);
    assert.match(stream.text, /"delta":"adapted "/);
    assert.equal((stream.text.match(/event: response\.completed/g) || []).length, 1);
    assert.doesNotMatch(stream.text, /data: \[DONE\]/);

    const direct = await fetch(`${gw.base}/v1/chat/completions?trace=direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha--shared', messages: [{ role: 'user', content: 'direct' }] }),
    });
    const directBody = await direct.json();
    assert.equal(direct.status, 200);
    assert.equal(directBody.object, 'chat.completion');
    assert.equal(directBody.choices[0].message.content, 'direct');
    assert.equal(requests.at(-1).url, '/v1/chat/completions?trace=direct');

    const webSearchFiltered = await gw.responses({
      model: 'alpha--shared',
      input: 'search',
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'web_search' },
      parallel_tool_calls: true,
    }, {}, '?trace=adapted');
    assert.equal(webSearchFiltered.status, 200, webSearchFiltered.text);
    assert.equal(requests.at(-1).url, '/v1/chat/completions?trace=adapted');
    assert.equal(requests.at(-1).body.tools, undefined);
    assert.equal(requests.at(-1).body.tool_choice, undefined);
    assert.equal(requests.at(-1).body.parallel_tool_calls, undefined);

    const agentMessage = await gw.responses({
      model: 'alpha--shared',
      input: [{
        type: 'agent_message',
        id: 'amsg_chat_task',
        author: '/root',
        recipient: '/root/child',
        content: [
          { type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\n' },
          { type: 'encrypted_content', encrypted_content: 'CHAT-SUBAGENT-9502' },
        ],
      }],
    }, {}, '?trace=adapted');
    assert.equal(agentMessage.status, 200, agentMessage.text);
    const agentRequest = requests.at(-1).body;
    assert.equal(agentRequest.messages[0].role, 'user');
    assert.match(agentRequest.messages[0].content, /Message Type: NEW_TASK/);
    assert.match(agentRequest.messages[0].content, /CHAT-SUBAGENT-9502/);
    assert.doesNotMatch(JSON.stringify(agentRequest), /agent_message|encrypted_content/);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('compressed Codex requests are decoded and stale encoding headers are removed', async () => {
  const upstreamPort = await freePort();
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp-compressed',
        object: 'response',
        status: 'completed',
        output: [],
      }));
    });
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const payload = Buffer.from(JSON.stringify({
      model: 'alpha--shared',
      input: 'compressed',
    }));
    const response = await fetch(`${gw.base}/v1/responses/compact?trace=zstd`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'zstd',
      },
      body: zlib.zstdCompressSync(payload),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(requests[0].url, '/v1/responses/compact?trace=zstd');
    assert.equal(requests[0].body.model, 'same-upstream-model');
    assert.equal(requests[0].headers['content-encoding'], undefined);
    assert.equal(
      Number(requests[0].headers['content-length']),
      Buffer.byteLength(JSON.stringify(requests[0].body)),
    );

    const malformed = await fetch(`${gw.base}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: Buffer.from('invalid'),
    });
    assert.equal(malformed.status, 400);
    assert.match(await malformed.text(), /invalid compressed request body/);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('Responses providers normalize agent messages by default and allow explicit native passthrough', async () => {
  const upstreamPort = await freePort();
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ url: req.url, raw, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'resp_native',
        object: 'response',
        status: 'completed',
        model: requests.at(-1).body.model,
        output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      }));
    });
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));

  const config = multiProviderConfig({
    defaultProvider: 'alpha',
    defaultModel: 'alpha--shared',
    providers: [
      {
        id: 'alpha',
        name: 'Compatible Responses',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        upstreamFormat: 'responses',
        enabled: true,
        models: [{ id: 'shared', name: 'Shared', upstreamModel: 'same-upstream-model' }],
        keys: [{ name: 'alpha-key', key: 'sk-alpha', weight: 1 }],
      },
      {
        id: 'beta',
        name: 'Native Responses',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        upstreamFormat: 'responses',
        supportsEncryptedAgentMessages: true,
        enabled: true,
        models: [{ id: 'shared', name: 'Shared', upstreamModel: 'same-upstream-model' }],
        keys: [{ name: 'beta-key', key: 'sk-beta', weight: 1 }],
      },
    ],
  });
  const agentInput = [{
    type: 'agent_message',
    id: 'amsg_native_task',
    author: '/root',
    recipient: '/root/child',
    content: [
      { type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\n' },
      { type: 'encrypted_content', encrypted_content: 'NATIVE-SUBAGENT-9502' },
    ],
  }];
  const gw = await startGateway('', [], {}, config, { mock: false, keysArg: false });
  try {
    const compatible = await gw.responses({
      model: 'alpha--shared',
      input: agentInput,
    }, {}, '?trace=compatible');
    assert.equal(compatible.status, 200, compatible.text);

    const native = await gw.responses({
      model: 'beta--shared',
      input: agentInput,
    }, {}, '?trace=native');
    assert.equal(native.status, 200, native.text);

    assert.equal(requests[0].url, '/v1/responses?trace=compatible');
    assert.deepEqual(requests[0].body, {
      model: 'same-upstream-model',
      input: [{
        type: 'message',
        role: 'user',
        id: 'amsg_native_task',
        content: [
          { type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\n' },
          { type: 'input_text', text: 'NATIVE-SUBAGENT-9502' },
        ],
      }],
    });
    assert.equal(requests[1].url, '/v1/responses?trace=native');
    assert.deepEqual(requests[1].body, {
      model: 'same-upstream-model',
      input: agentInput,
    });

    const publicConfig = await gw.providers();
    assert.equal(publicConfig.providers[0].supportsEncryptedAgentMessages, false);
    assert.equal(publicConfig.providers[1].supportsEncryptedAgentMessages, true);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('unknown prefixed aliases fail closed while legacy model names use the default provider', async () => {
  const gw = await startGateway('', [], {}, multiProviderConfig(), { keysArg: false });
  try {
    const unknown = await gw.chat({ model: 'missing--shared' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.text, /unknown or disabled model alias/);
    const unknownCodex = await gw.chat({ model: 'Missing.shared' });
    assert.equal(unknownCodex.status, 400);
    assert.match(unknownCodex.text, /unknown or disabled model alias/);
    const unknownNumericCodex = await gw.chat({ model: '1missing.shared' });
    assert.equal(unknownNumericCodex.status, 400);
    assert.match(unknownNumericCodex.text, /unknown or disabled model alias/);
    const legacy = await gw.chat({ model: 'same-upstream-model' });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.headers.get('x-gateway-provider'), 'alpha');
    assert.equal(JSON.parse(legacy.text).gateway_key_name, 'alpha-key');
  } finally {
    await gw.stop();
  }
});

test('Codex dotted aliases route Responses requests to the matching provider model', async () => {
  const config = multiProviderConfig({
    defaultProvider: 'routify',
    defaultModel: 'routify--deepseek-v4-flash',
    providers: [{
      id: 'routify',
      name: 'Routify',
      baseUrl: 'https://routify.example/v1',
      enabled: true,
      models: [{
        id: 'deepseek-v4-flash',
        name: 'deepseek-v4-flash',
        upstreamModel: 'deepseek-v4-flash',
      }],
      keys: [{ name: 'routify-key', key: 'sk-routify-ok', weight: 1 }],
    }],
  });
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  try {
    const routed = await gw.responses({
      model: 'Routify.deepseek-v4-flash',
      input: 'hello',
    });
    assert.equal(routed.status, 200, routed.text);
    assert.equal(routed.headers.get('x-gateway-provider'), 'routify');
  } finally {
    await gw.stop();
  }
});

test('dotted bare model names route to the default provider instead of 400', async () => {
  const config = multiProviderConfig({
    defaultProvider: 'alpha',
    defaultModel: 'alpha--gpt-4.1',
    providers: [{
      id: 'alpha',
      name: 'Alpha',
      baseUrl: 'https://alpha.example',
      enabled: true,
      models: [
        { id: 'shared', name: 'Shared Alpha', upstreamModel: 'same-upstream-model' },
        { id: 'Gpt-4.1', name: 'GPT 4.1', upstreamModel: 'gpt-4.1' },
      ],
      keys: [{ name: 'alpha-key', key: 'sk-alpha-ok', weight: 1 }],
    }],
  });
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  try {
    const mixed = await gw.chat({ model: 'Gpt-4.1' });
    assert.equal(mixed.status, 200, mixed.text);
    assert.equal(mixed.headers.get('x-gateway-provider'), 'alpha');
    const lowercase = await gw.chat({ model: 'gpt-4.1' });
    assert.equal(lowercase.status, 200, lowercase.text);
  } finally {
    await gw.stop();
  }
});

test('model discovery proxies OpenAI-compatible endpoints and normalizes upstream model ids', async () => {
  const upstreamPort = await freePort();
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url === '/leak/models') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`reflected ${req.headers.authorization}`);
      return;
    }
    if (req.url === '/anthropic/v1/models') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (req.url !== '/v1/models') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        {
          id: 'Qwen/Qwen3-235B-A22B-Instruct',
          owned_by: 'qwen',
          architecture: { input_modalities: ['text'] },
        },
        { id: 'gpt-4o-mini', owned_by: 'openai' },
        {
          id: 'claude/3.5-sonnet',
          name: 'Claude 3.5 Sonnet',
          supports_image: false,
        },
      ],
    }));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}/anthropic`;
  const gw = await startGateway('', [], {}, config, { keysArg: false });
  const secret = 'sk-model-discovery-secret';
  try {
    const response = await fetch(`${gw.base}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${upstreamPort}/anthropic`,
        key: secret,
      }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const payload = JSON.parse(responseText);
    assert.deepEqual(payload.models.map(model => model.upstreamModel), [
      'claude/3.5-sonnet',
      'gpt-4o-mini',
      'Qwen/Qwen3-235B-A22B-Instruct',
    ]);
    assert.deepEqual(payload.models.map(model => model.id), [
      'claude/3.5-sonnet',
      'gpt-4o-mini',
      'qwen/qwen3-235b-a22b-instruct',
    ]);
    assert.equal(payload.models[2].ownedBy, 'qwen');
    assert.equal(payload.models[0].name, 'Claude 3.5 Sonnet');
    assert.deepEqual(payload.models.map(model => model.inputModalities), [
      ['text'],
      ['text', 'image'],
      ['text'],
    ]);
    assert.deepEqual(payload.models.map(model => model.capabilitySource), [
      'upstream',
      'default',
      'upstream',
    ]);
    assert.equal(payload.models[0].reasoning, undefined);
    assert.equal(payload.models[1].reasoning, undefined);
    assert.ok(!JSON.stringify(payload).includes(secret));

    const capabilitiesResponse = await fetch(`${gw.base}/api/model-capabilities`);
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities = await capabilitiesResponse.json();
    assert.deepEqual(capabilities.unknownModel.inputModalities, ['text', 'image']);
    assert.ok(capabilities.models.some(model => (
      model.id === 'deepseek-v4-pro'
      && JSON.stringify(model.inputModalities) === JSON.stringify(['text'])
    )));
    assert.deepEqual(
      capabilities.models.find(model => model.id === 'deepseek-v4-pro').reasoning,
      {
        parameter: 'reasoning_effort',
        default: 'high',
        levels: [
          { effort: 'low', description: 'Fast responses with lighter reasoning' },
          { effort: 'high', description: 'Extra high reasoning depth for complex problems' },
          { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
        ],
      },
    );

    const providerKeyResponse = await fetch(`${gw.base}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({ providerId: 'alpha' }),
    });
    assert.equal(providerKeyResponse.status, 200, await providerKeyResponse.text());

    const crossOriginResponse = await fetch(`${gw.base}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        providerId: 'alpha',
        baseUrl: `http://localhost:${upstreamPort}/anthropic`,
      }),
    });
    assert.equal(crossOriginResponse.status, 400);
    assert.match(await crossOriginResponse.text(), /explicit API key/);
    assert.deepEqual(requests, [
      { path: '/anthropic/v1/models', authorization: `Bearer ${secret}` },
      { path: '/v1/models', authorization: `Bearer ${secret}` },
      { path: '/anthropic/v1/models', authorization: 'Bearer sk-alpha-ok' },
      { path: '/v1/models', authorization: 'Bearer sk-alpha-ok' },
    ]);

    const reflected = await fetch(`${gw.base}/api/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gw.base },
      body: JSON.stringify({
        providerId: 'alpha',
        modelsUrl: `http://127.0.0.1:${upstreamPort}/leak/models`,
      }),
    });
    const reflectedText = await reflected.text();
    assert.equal(reflected.status, 500);
    assert.doesNotMatch(reflectedText, /sk-alpha-ok|Bearer/);
    assert.match(reflectedText, /model endpoint returned HTTP 500/);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('large non-SSE JSON responses still record usage totals', async () => {
  const upstreamPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'large-response',
      output: 'x'.repeat(1100000),
      usage: { total_tokens: 37 },
    }));
  });
  await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
  const config = multiProviderConfig();
  config.providers[0].baseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gw = await startGateway('', [], {}, config, { keysArg: false, mock: false });
  try {
    const response = await gw.chat({ model: 'alpha--shared' });
    assert.equal(response.status, 200);
    assert.ok(response.text.length > 1100000);
    const health = await gw.health();
    assert.equal(health.total.tokens, 37);
  } finally {
    await gw.stop();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('oversized request body is rejected with 413', async () => {
  const gw = await startGateway('alice=sk-a-ok', ['--max-body-bytes', '100']);
  try {
    const res = await fetch(`${gw.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x'.repeat(200) }] }),
    });
    assert.equal(res.status, 413);
    const small = await gw.chat();
    assert.equal(small.status, 200);
  } finally {
    await gw.stop();
  }
});
